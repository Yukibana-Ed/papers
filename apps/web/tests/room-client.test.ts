import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import * as Y from 'yjs';
import { DOC_REVIEW, DOC_TEXT, MSG_AWARENESS, MSG_SYNC, type ServerMessage } from '@yukibana/papers-room-protocol';
import { PRESENCE_MS, RoomClient, TicketRefused, type RoomEvents } from '#lib/room/client.ts';

/** A binary message the client sent, decoded far enough to tell them apart. */
interface Sent {
    readonly doc: number;
    readonly kind: 'step1' | 'step2' | 'update' | 'awareness';
    readonly payload: Uint8Array;
}

/** A WebSocket that records what is sent and opens, speaks and closes when the test says. */
class FakeSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static all: FakeSocket[] = [];
    readyState = FakeSocket.CONNECTING;
    binaryType = 'blob';
    readonly sent: (string | Uint8Array)[] = [];

    constructor(readonly url: string) {
        super();
        FakeSocket.all.push(this);
    }

    send(data: string | Uint8Array): void {
        if (this.readyState !== FakeSocket.OPEN) throw new Error('not open');
        this.sent.push(data);
    }

    close(): void {
        if (this.readyState === FakeSocket.CLOSED) return;
        this.readyState = FakeSocket.CLOSED;
        this.dispatchEvent(new Event('close'));
    }

    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.dispatchEvent(new Event('open'));
    }

    receive(data: string | Uint8Array): void {
        const payload = typeof data === 'string' ? data : data.slice().buffer;
        this.dispatchEvent(new MessageEvent('message', { data: payload }));
    }

    control(m: ServerMessage): void {
        this.receive(JSON.stringify(m));
    }

    /** The binary messages sent, decoded far enough to tell them apart. */
    binaries(): Sent[] {
        return this.sent.flatMap((d): Sent[] => {
            if (typeof d === 'string') return [];
            const dec = decoding.createDecoder(d);
            const doc = decoding.readUint8(dec);
            const kind = decoding.readVarUint(dec);
            if (kind === MSG_AWARENESS) return [{ doc, kind: 'awareness', payload: decoding.readVarUint8Array(dec) }];
            const sync = decoding.readVarUint(dec);
            return [{ doc, kind: (['step1', 'step2', 'update'] as const)[sync] ?? 'update', payload: decoding.readVarUint8Array(dec) }];
        });
    }
}

/** The room's answer to a step 1 for `doc` from `room` (its state, as a step 2), and its own step 1. */
function step(id: number, room: Y.Doc, which: 1 | 2): Uint8Array {
    const e = encoding.createEncoder();
    encoding.writeUint8(e, id);
    encoding.writeVarUint(e, MSG_SYNC);
    if (which === 1) writeSyncStep1(e, room);
    else writeSyncStep2(e, room);
    return encoding.toUint8Array(e);
}

function events(): RoomEvents & { log: string[] } {
    const log: string[] = [];
    return {
        log,
        welcome: () => log.push('welcome'),
        base: () => log.push('base'),
        opened: () => log.push('opened'),
        authors: () => log.push('authors'),
        sync: m => log.push(`sync:${m.mode}`),
        synced: () => log.push('synced'),
        backupDue: () => log.push('backup-due'),
        connection: s => log.push(`connection:${s}`),
        refused: r => log.push(`refused:${r}`),
        signedOut: () => log.push('signed-out'),
    };
}

const WELCOME: ServerMessage = {
    type: 'welcome',
    you: { login: 'me', name: 'Me', access: 'write' },
    base: null,
    files: [],
    sync: { mode: 'live' },
    authors: { writers: [], deleted: [] },
} as unknown as ServerMessage;

/** A client whose first socket is open and synced with empty documents. */
async function connected(on = events()): Promise<{ client: RoomClient; ws: FakeSocket; on: ReturnType<typeof events> }> {
    const client = new RoomClient(async () => 'wss://app/room?ticket=t', on);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.all.at(-1);
    if (!ws) throw new Error('no socket');
    ws.open();
    ws.control(WELCOME);
    const empty = new Y.Doc();
    ws.receive(step(DOC_TEXT, empty, 2));
    ws.receive(step(DOC_REVIEW, empty, 2));
    return { client, ws, on };
}

beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('RoomClient', () => {
    it('opens with a step 1 per document and reports synced once both have the room state', async () => {
        const { client, ws, on } = await connected();
        expect(ws.url).toBe('wss://app/room?ticket=t');
        expect(ws.binaryType).toBe('arraybuffer');
        expect(
            ws
                .binaries()
                .filter(b => b.kind === 'step1')
                .map(b => b.doc),
        ).toEqual([DOC_TEXT, DOC_REVIEW]);
        expect(on.log).toEqual(['connection:connecting', 'connection:open', 'welcome', 'sync:live', 'synced']);
        client.close();
    });

    it('answers the room step 1 with what it lacks, and applies what the room sends', async () => {
        const { client, ws } = await connected();
        client.files.set('a.tex', new Y.Text('mine'));
        const room = new Y.Doc();
        ws.sent.length = 0;
        ws.receive(step(DOC_TEXT, room, 1));
        const reply = ws.binaries().find(b => b.kind === 'step2');
        if (!reply) throw new Error('no step 2');
        Y.applyUpdate(room, reply.payload);
        expect(room.getMap<Y.Text>('files').get('a.tex')?.toJSON()).toBe('mine');
        client.close();
    });

    it('sends edits at once while live, batches them, and holds them while paused until the room resumes', async () => {
        const { client, ws } = await connected();
        ws.sent.length = 0;
        client.files.set('a.tex', new Y.Text('1'));
        expect(ws.binaries().filter(b => b.kind === 'update')).toHaveLength(1);

        ws.control({ type: 'sync', sync: { mode: 'batched', intervalMs: 1000 } });
        ws.sent.length = 0;
        client.files.get('a.tex')?.insert(1, '2');
        client.files.get('a.tex')?.insert(2, '3');
        expect(ws.binaries()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(ws.binaries().filter(b => b.kind === 'update')).toHaveLength(1);

        ws.control({ type: 'sync', sync: { mode: 'paused', until: Date.now() + 60_000 } });
        ws.sent.length = 0;
        client.files.get('a.tex')?.insert(3, '4');
        client.awareness.setLocalState({ user: 'me', cursor: { file: 'a.tex', line: 1 } });
        await vi.advanceTimersByTimeAsync(PRESENCE_MS * 4);
        expect(ws.binaries()).toHaveLength(0);
        ws.control({ type: 'sync', sync: { mode: 'live' } });
        const kinds = ws.binaries().map(b => b.kind);
        expect(kinds).toContain('update');
        expect(kinds.filter(k => k === 'awareness')).toHaveLength(1);
        client.close();
    });

    it("sends only this client's presence, at most once per PRESENCE_MS, the latest state last", async () => {
        const { client, ws } = await connected();
        // Opening sent the presence it had: a window after it, the next change goes at once.
        await vi.advanceTimersByTimeAsync(PRESENCE_MS);
        ws.sent.length = 0;
        for (let line = 1; line <= 5; line++) client.awareness.setLocalState({ user: 'me', cursor: { file: 'a.tex', line } });
        await vi.advanceTimersByTimeAsync(0);
        expect(ws.binaries().filter(b => b.kind === 'awareness')).toHaveLength(1);
        // The next change waits for the end of the window.
        client.awareness.setLocalState({ user: 'me', cursor: { file: 'a.tex', line: 6 } });
        await vi.advanceTimersByTimeAsync(PRESENCE_MS / 2);
        expect(ws.binaries().filter(b => b.kind === 'awareness')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(PRESENCE_MS / 2);
        const sent = ws.binaries().filter(b => b.kind === 'awareness');
        expect(sent).toHaveLength(2);
        const other = new Y.Doc();
        const { Awareness, applyAwarenessUpdate } = await import('y-protocols/awareness');
        const seen = new Awareness(other);
        const last = sent.at(-1);
        if (!last) throw new Error('no presence');
        applyAwarenessUpdate(seen, last.payload, 'test');
        expect(seen.getStates().get(client.awareness.clientID)).toEqual({ user: 'me', cursor: { file: 'a.tex', line: 6 } });
        seen.destroy();
        client.close();
    });

    it('reconnects with backoff after the socket closes, syncing again rather than resending what was queued', async () => {
        const { client, ws, on } = await connected();
        ws.close();
        expect(on.log.at(-1)).toBe('connection:closed');
        client.files.set('offline.tex', new Y.Text('kept'));
        expect(FakeSocket.all).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(FakeSocket.all).toHaveLength(2);
        const next = FakeSocket.all[1];
        if (!next) throw new Error('no second socket');
        next.open();
        // Only the two step 1s: the offline edit goes as the answer to the room's step 1, not as a queued update.
        expect(
            next
                .binaries()
                .filter(b => b.kind !== 'awareness')
                .map(b => b.kind),
        ).toEqual(['step1', 'step1']);
        next.receive(step(DOC_TEXT, new Y.Doc(), 1));
        const reply = next.binaries().find(b => b.kind === 'step2');
        const room = new Y.Doc();
        if (reply) Y.applyUpdate(room, reply.payload);
        expect(room.getMap<Y.Text>('files').get('offline.tex')?.toJSON()).toBe('kept');
        client.close();
    });

    it('resyncs by reconnecting once the room takes messages again after refusing one while paused', async () => {
        const { client, ws, on } = await connected();
        ws.control({ type: 'sync', sync: { mode: 'paused', until: Date.now() + 5000 } });
        ws.control({ type: 'refused', reason: 'paused' });
        expect(on.log.at(-1)).toBe('refused:paused');
        ws.control({ type: 'sync', sync: { mode: 'live' } });
        expect(ws.readyState).toBe(FakeSocket.CLOSED);
        await vi.advanceTimersByTimeAsync(500);
        expect(FakeSocket.all).toHaveLength(2);
        client.close();
    });

    it('stops and reports signed out when the ticket is refused for the sign-in, and retries other failures', async () => {
        const on = events();
        let calls = 0;
        const client = new RoomClient(async () => {
            calls++;
            if (calls === 1) throw new Error('No ticket (500)');
            throw new TicketRefused(401);
        }, on);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(calls).toBe(2);
        expect(on.log.slice(-2)).toEqual(['connection:closed', 'signed-out']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls).toBe(2);
        expect(FakeSocket.all).toHaveLength(0);
        client.close();
    });

    it('reports nothing and leaves no timer after close, even with a ticket still on its way', async () => {
        const on = events();
        let resolve: (url: string) => void = () => {};
        const client = new RoomClient(() => new Promise<string>(r => (resolve = r)), on);
        client.awareness.setLocalState({ user: 'me' });
        client.close();
        resolve('wss://late');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(FakeSocket.all).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        const open = await connected();
        open.client.awareness.setLocalState({ user: 'me', cursor: null });
        const before = open.on.log.length;
        open.client.close();
        expect(open.ws.readyState).toBe(FakeSocket.CLOSED);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(open.on.log.length).toBe(before);
        expect(FakeSocket.all).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
