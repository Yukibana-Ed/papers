import { DurableObject } from 'cloudflare:workers';
import { RoomCore, type Peer } from './core.ts';
import { connectionExpired } from './limits.ts';
import type { Identity } from './protocol.ts';
import { RoomStore } from './store.ts';

/** How long after the last change the room compacts its logs and asks for a WIP backup. */
const TICK_MS = 5 * 60 * 1000;

/** The header the app's Worker sets on the upgrade it forwards: the identity it checked against GitHub. The room
 *  Worker has no route of its own, so only the app's Worker (through its Durable Object binding) can set it. */
export const IDENTITY_HEADER = 'X-Yukibana-Identity';

interface Env {
    readonly ROOM: DurableObjectNamespace<Room>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
}

function parseIdentity(raw: string | null): Identity | null {
    if (raw === null) return null;
    try {
        const r: unknown = JSON.parse(raw);
        if (!isRecord(r)) return null;
        const access = r['access'];
        if (typeof r['login'] !== 'string' || typeof r['name'] !== 'string' || (access !== 'write' && access !== 'comment')) return null;
        return { login: r['login'], name: r['name'], access };
    } catch {
        return null;
    }
}

/** The room of one branch of one repository: named `<owner>/<repo>#<branch>` by the app's Worker. Hibernating
 *  WebSockets: an idle room costs nothing, and wakes with its documents from SQLite. */
export class Room extends DurableObject<Env> {
    private core: RoomCore | null = null;
    private readonly peers = new Map<WebSocket, Peer>();

    private room(): RoomCore {
        if (this.core) return this.core;
        const core = new RoomCore(new RoomStore(this.ctx.storage.sql));
        this.core = core;
        // After a wake from hibernation: the sockets are still open, the peers have to be rebuilt.
        for (const ws of this.ctx.getWebSockets()) {
            const attachment: unknown = ws.deserializeAttachment();
            const identity = parseIdentity(typeof attachment === 'string' ? attachment : null);
            if (identity) this.peers.set(ws, this.peerOf(ws, identity));
        }
        return core;
    }

    private peerOf(ws: WebSocket, identity: Identity): Peer {
        return {
            identity,
            awarenessIds: new Set(),
            send: data => {
                try {
                    ws.send(data);
                } catch {
                    // The socket closed under us; its close event removes the peer.
                }
            },
        };
    }

    override async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
        const identity = parseIdentity(request.headers.get(IDENTITY_HEADER));
        if (!identity) return new Response('Unknown identity', { status: 403 });
        const core = this.room();
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(JSON.stringify({ ...identity, since: Date.now() }));
        const peer = this.peerOf(server, identity);
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
        const peer = this.peers.get(ws);
        if (peer) this.room().disconnect(peer);
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
