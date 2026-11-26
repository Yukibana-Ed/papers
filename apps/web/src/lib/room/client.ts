import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';
import { DOC_REVIEW, DOC_TEXT, MSG_AWARENESS, MSG_SYNC, type BaseFile, type DocId, type Identity, type ServerMessage, type SyncMode } from '@yukibana/papers-room/protocol';

export interface RoomEvents {
    welcome(you: Identity, base: string | null, files: readonly BaseFile[]): void;
    base(base: string, files: readonly BaseFile[]): void;
    sync(mode: SyncMode): void;
    /** Both documents have the room's state (after every (re)connection). */
    synced(): void;
    backupDue(): void;
    connection(state: 'connecting' | 'open' | 'closed'): void;
    refused(reason: string): void;
}

/** The app's end of a room: the branch's two Yjs documents kept in sync with the room over one WebSocket, the
 *  user's presence, and the room's sync mode honoured (changes batched or held while paused, never dropped).
 *
 *  Reconnects with backoff; after a reconnection both documents sync again from their state vectors, so edits made
 *  while offline are sent then. */
export class RoomClient {
    readonly text = new Y.Doc();
    readonly review = new Y.Doc();
    readonly awareness = new Awareness(this.review);
    private ws: WebSocket | null = null;
    private mode: SyncMode = { mode: 'live' };
    private readonly pending = new Map<DocId, Uint8Array[]>();
    private flushTimer = 0;
    private retry = 0;
    private closed = false;
    private syncedDocs = new Set<DocId>();

    /** Precondition: `url` resolves to the room's WebSocket URL on the app's own origin, with a fresh ticket: it is
     *  called for every (re)connection, since tickets last a minute. */
    constructor(
        private readonly url: () => Promise<string>,
        private readonly on: RoomEvents,
    ) {
        for (const [id, doc] of [
            [DOC_TEXT, this.text],
            [DOC_REVIEW, this.review],
        ] as const) {
            doc.on('update', (u: Uint8Array, origin: unknown) => {
                if (origin !== this) this.queue(id, u);
            });
        }
        this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
            if (origin === this) return;
            const e = encoding.createEncoder();
            encoding.writeUint8(e, DOC_REVIEW);
            encoding.writeVarUint(e, MSG_AWARENESS);
            encoding.writeVarUint8Array(e, encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
            this.sendRaw(encoding.toUint8Array(e));
        });
        this.connect();
    }

    private connect(): void {
        if (this.closed) return;
        this.on.connection('connecting');
        this.url().then(
            url => this.openSocket(url),
            () => this.retryLater(),
        );
    }

    private retryLater(): void {
        if (!this.closed) setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** this.retry++));
    }

    private openSocket(url: string): void {
        if (this.closed) return;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.addEventListener('open', () => {
            this.retry = 0;
            this.syncedDocs.clear();
            this.on.connection('open');
            for (const [id, doc] of [
                [DOC_TEXT, this.text],
                [DOC_REVIEW, this.review],
            ] as const) {
                const e = encoding.createEncoder();
                encoding.writeUint8(e, id);
                encoding.writeVarUint(e, MSG_SYNC);
                writeSyncStep1(e, doc);
                ws.send(encoding.toUint8Array(e));
            }
            if (this.awareness.getLocalState() !== null) {
                const e = encoding.createEncoder();
                encoding.writeUint8(e, DOC_REVIEW);
                encoding.writeVarUint(e, MSG_AWARENESS);
                encoding.writeVarUint8Array(e, encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
                ws.send(encoding.toUint8Array(e));
            }
        });
        ws.addEventListener('message', (m: MessageEvent) => {
            if (typeof m.data === 'string') this.control(m.data);
            else if (m.data instanceof ArrayBuffer) this.binary(new Uint8Array(m.data));
        });
        ws.addEventListener('close', () => {
            this.ws = null;
            this.on.connection('closed');
            // Others' presence is stale once we cannot hear them.
            removeAwarenessStates(
                this.awareness,
                [...this.awareness.getStates().keys()].filter(id => id !== this.awareness.clientID),
                this,
            );
            this.retryLater();
        });
    }

    private control(data: string): void {
        let m: ServerMessage;
        try {
            m = JSON.parse(data) as ServerMessage;
        } catch {
            return;
        }
        switch (m.type) {
            case 'welcome':
                this.mode = m.sync;
                this.on.welcome(m.you, m.base, m.files);
                this.on.sync(m.sync);
                break;
            case 'base':
                this.on.base(m.base, m.files);
                break;
            case 'sync':
                this.mode = m.sync;
                this.on.sync(m.sync);
                this.scheduleFlush();
                break;
            case 'backup-due':
                this.on.backupDue();
                break;
            case 'refused':
                this.on.refused(m.reason);
                break;
        }
    }

    private binary(data: Uint8Array): void {
        const dec = decoding.createDecoder(data);
        const id = decoding.readUint8(dec);
        const kind = decoding.readVarUint(dec);
        if (kind === MSG_AWARENESS) {
            applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
            return;
        }
        if (kind !== MSG_SYNC || (id !== DOC_TEXT && id !== DOC_REVIEW)) return;
        const doc = id === DOC_TEXT ? this.text : this.review;
        const reply = encoding.createEncoder();
        encoding.writeUint8(reply, id);
        encoding.writeVarUint(reply, MSG_SYNC);
        const type = readSyncMessage(dec, reply, doc, this);
        if (encoding.length(reply) > 2) this.sendRaw(encoding.toUint8Array(reply));
        // A step 2 answers our step 1: that document now has everything the room had.
        if (type === 1 && !this.syncedDocs.has(id)) {
            this.syncedDocs.add(id);
            if (this.syncedDocs.size === 2) this.on.synced();
        }
    }

    private queue(id: DocId, update: Uint8Array): void {
        const list = this.pending.get(id) ?? [];
        list.push(update);
        this.pending.set(id, list);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        clearTimeout(this.flushTimer);
        const m = this.mode;
        if (m.mode === 'live') return this.flush();
        const wait = m.mode === 'batched' ? m.intervalMs : Math.max(1000, m.until - Date.now());
        this.flushTimer = window.setTimeout(() => {
            if (this.mode.mode === 'paused' && Date.now() >= this.mode.until) this.mode = { mode: 'live' };
            this.flush();
        }, wait);
    }

    private flush(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.mode.mode === 'paused') return;
        for (const [id, list] of this.pending) {
            if (!list.length) continue;
            const e = encoding.createEncoder();
            encoding.writeUint8(e, id);
            encoding.writeVarUint(e, MSG_SYNC);
            writeUpdate(e, Y.mergeUpdates(list));
            this.ws.send(encoding.toUint8Array(e));
        }
        this.pending.clear();
    }

    private sendRaw(data: Uint8Array<ArrayBuffer> | string): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    }

    /** Puts a file in the room as of `commit` (the room keeps it if it has it already). */
    open(path: string, blob: string, text: string, commit: string): void {
        this.sendRaw(JSON.stringify({ type: 'open', path, blob, text, commit }));
    }

    committed(commit: string, files: readonly BaseFile[]): void {
        this.sendRaw(JSON.stringify({ type: 'committed', commit, files }));
    }

    backedUp(commit: string): void {
        this.sendRaw(JSON.stringify({ type: 'backed-up', commit }));
    }

    /** The session text of every file the room has. */
    get files(): Y.Map<Y.Text> {
        return this.text.getMap<Y.Text>('files');
    }

    close(): void {
        this.closed = true;
        this.awareness.setLocalState(null);
        this.ws?.close();
    }
}
