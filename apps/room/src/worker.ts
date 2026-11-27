import { DurableObject } from 'cloudflare:workers';
import { RoomCore, type Peer } from './core.ts';
import { IDENTITY_HEADER, type Identity } from '@yukibana/papers-room-protocol';
import { connectionExpired } from './limits.ts';
import { RoomStore } from './store.ts';

/** How long after the last change the room compacts its logs and asks for a WIP backup. */
const TICK_MS = 5 * 60 * 1000;

interface Env {
    readonly ROOM: DurableObjectNamespace<Room>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
}

/** What a WebSocket's attachment holds, as JSON: who the connection is, since when (epoch ms), and its presence as
 *  the room core last handed it over (an awareness update, base64). It is all that outlives the room's sleep. */
interface Kept {
    readonly identity: Identity;
    readonly since: number;
    readonly presence: Uint8Array | null;
}

function base64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function parseKept(attachment: unknown): Kept | null {
    const identity = parseIdentity(typeof attachment === 'string' ? attachment : null);
    if (!identity || typeof attachment !== 'string') return null;
    const r: unknown = JSON.parse(attachment);
    if (!isRecord(r)) return null;
    let presence: Uint8Array | null = null;
    if (typeof r['presence'] === 'string') {
        try {
            presence = Uint8Array.from(atob(r['presence']), c => c.charCodeAt(0));
        } catch {
            // Not base64: no presence.
        }
    }
    return { identity, since: typeof r['since'] === 'number' ? r['since'] : 0, presence };
}

function parseIdentity(raw: string | null): Identity | null {
    if (raw === null) return null;
    try {
        // Percent-encoded JSON, as the app sends it; plain JSON from an app deployed before it did.
        const r: unknown = JSON.parse(raw.startsWith('%7B') ? decodeURIComponent(raw) : raw);
        if (!isRecord(r)) return null;
        const access = r['access'];
        if (typeof r['login'] !== 'string' || typeof r['name'] !== 'string' || (access !== 'write' && access !== 'comment')) return null;
        return { login: r['login'], name: r['name'], access };
    } catch {
        return null;
    }
}

/** The room of one branch of one repository: named `<owner>/<repo>#<branch>` by the app's Worker. Hibernating
 *  WebSockets: a room nobody is talking to is put to sleep with its connections open and costs nothing; it wakes for
 *  the next message with its documents from SQLite and its connections from their attachments. Nothing here or in
 *  the core may leave a timer pending: that would keep the room awake, which is what the platform bills. */
export class Room extends DurableObject<Env> {
    private core: RoomCore | null = null;
    private readonly peers = new Map<WebSocket, Peer>();

    private room(): RoomCore {
        if (this.core) return this.core;
        const core = new RoomCore(new RoomStore(this.ctx.storage.sql));
        this.core = core;
        // After a wake from hibernation: the sockets are still open, the room has to be told of them again.
        for (const ws of this.ctx.getWebSockets()) this.restore(core, ws);
        return core;
    }

    /** Puts `ws`, a connection from before the room slept, back in `core`, unless it is there. */
    private restore(core: RoomCore, ws: WebSocket): void {
        if (this.peers.has(ws)) return;
        const kept = parseKept(ws.deserializeAttachment());
        if (!kept) return;
        const peer = this.peerOf(ws, kept.identity, kept.since);
        this.peers.set(ws, peer);
        core.rejoin(peer, kept.presence);
    }

    private peerOf(ws: WebSocket, identity: Identity, since: number): Peer {
        return {
            identity,
            awarenessIds: new Set(),
            keep: presence => {
                try {
                    ws.serializeAttachment(JSON.stringify({ ...identity, since, presence: base64(presence) }));
                } catch {
                    // Larger than an attachment may be: after a sleep this connection's presence is unknown until it
                    // changes again.
                    ws.serializeAttachment(JSON.stringify({ ...identity, since }));
                }
            },
            send: data => {
                try {
                    ws.send(data);
                } catch {
                    // The socket closed under us; its close event removes the peer.
                }
            },
        };
    }

    /** A WebSocket upgrade joins the room. A POST asks whether the room can take a connection: it loads the room and
     *  writes to its storage as joining does, and answers 200, or 503 with what failed. */
    override async fetch(request: Request): Promise<Response> {
        const probe = request.method === 'POST';
        if (!probe && request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
        const identity = parseIdentity(request.headers.get(IDENTITY_HEADER));
        if (!identity) return new Response('Unknown identity', { status: 403 });
        if (probe) {
            try {
                this.room();
                await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
                return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
            } catch (e) {
                return new Response((e instanceof Error ? e.message : String(e)).slice(0, 300), { status: 503, headers: { 'Cache-Control': 'no-store' } });
            }
        }
        const core = this.room();
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        const since = Date.now();
        server.serializeAttachment(JSON.stringify({ ...identity, since }));
        const peer = this.peerOf(server, identity, since);
        this.peers.set(server, peer);
        core.connect(peer);
        await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
        return new Response(null, { status: 101, webSocket: client });
    }

    /** Closes `ws` once it has lasted MAX_CONNECTION_MS; returns whether it did. */
    private expire(ws: WebSocket): boolean {
        if (!connectionExpired(ws.deserializeAttachment(), Date.now())) return false;
        ws.close(4000, 'Reconnect');
        this.webSocketClose(ws);
        return true;
    }

    override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
        const core = this.room();
        const peer = this.peers.get(ws);
        if (!peer) return ws.close(1008, 'Unknown connection');
        if (this.expire(ws)) return;
        core.receive(peer, typeof message === 'string' ? message : new Uint8Array(message));
    }

    override webSocketClose(ws: WebSocket): void {
        const core = this.room();
        // A close can be what woke the room: the connection is put back first, so that its presence goes with it.
        this.restore(core, ws);
        const peer = this.peers.get(ws);
        if (peer) core.disconnect(peer);
        this.peers.delete(ws);
    }

    override webSocketError(ws: WebSocket): void {
        this.webSocketClose(ws);
    }

    override async alarm(): Promise<void> {
        const core = this.room();
        // Deleting from a Map while iterating it is safe: the deleted entries are skipped.
        for (const ws of this.peers.keys()) this.expire(ws);
        const anyone = core.tick();
        if (anyone || this.peers.size > 0) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
}

export default {
    fetch(): Response {
        // Reached only through the app's Durable Object binding; nothing is served on its own.
        return new Response('Not found', { status: 404 });
    },
} satisfies ExportedHandler<Env>;
