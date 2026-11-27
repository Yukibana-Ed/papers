import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';
import {
    DOC_REVIEW,
    DOC_TEXT,
    MSG_AWARENESS,
    MSG_SYNC,
    type Authors,
    type BaseFile,
    type DocId,
    type Identity,
    type ServerMessage,
    type SyncMode,
} from '@yukibana/papers-room-protocol';

/** What the `url` callback throws when the app's Worker turned the ticket request down for the user's sign-in (401 or
 *  403): the client stops reconnecting and reports `signedOut`. */
export class TicketRefused extends Error {
    constructor(readonly status: number) {
        super(`No ticket (${status})`);
    }
}

/** At most one presence message per this many milliseconds: a cursor moves on every key. */
export const PRESENCE_MS = 150;

export interface RoomEvents {
    welcome(you: Identity, base: string | null, files: readonly BaseFile[], authors: Authors): void;
    base(base: string, files: readonly BaseFile[]): void;
    /** A file joined the room, with its committed state. */
    opened(file: BaseFile): void;
    /** More about who wrote and deleted what. */
    authors(a: Authors): void;
    sync(mode: SyncMode): void;
    /** Both documents have the room's state (after every (re)connection). */
    synced(): void;
    backupDue(): void;
    connection(state: 'connecting' | 'open' | 'closed'): void;
    refused(reason: string): void;
    /** The ticket was refused for the user's sign-in: the client has stopped, and signing in again is the way back. */
    signedOut(): void;
}

/** The app's end of a room: the branch's two Yjs documents kept in sync with the room over one WebSocket, the
 *  user's presence, and the room's sync mode honoured (changes batched or held while paused, never dropped).
 *
 *  Reconnects with jittered backoff until `close`, or until the ticket is refused for the user's sign-in; after a
 *  reconnection both documents sync again from their state vectors, so edits made while offline are sent then. An
 *  update the room refused while paused is sent the same way: the client reconnects once the room takes messages again.
 *
 *  Presence: only this client's own state is sent, when it changes and at most once per `PRESENCE_MS`; while paused
 *  only the latest state is kept, to be sent on resume. Someone else's presence lasts until the room says they left
 *  or this client's connection closes.
 *
 *  A client whose user does nothing sends nothing: the room can sleep under an open tab. */
export class RoomClient {
    readonly text = new Y.Doc();
    readonly review = new Y.Doc();
    readonly awareness = new Awareness(this.review);
    private ws: WebSocket | null = null;
    private mode: SyncMode = { mode: 'live' };
    private readonly pending = new Map<DocId, Uint8Array[]>();
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private presenceTimer: ReturnType<typeof setTimeout> | undefined;
    private presenceDue = false;
    private presenceAt = Number.NEGATIVE_INFINITY;
    private retry = 0;
    private closed = false;
    /** An update was refused while paused: reconnect (a full resync) once the room takes messages again. */
    private resync = false;
    private readonly syncedDocs = new Set<DocId>();
    private readonly docListeners: [Y.Doc, (u: Uint8Array, origin: unknown) => void][] = [];

    /** Precondition: `url` resolves to the room's WebSocket URL on the app's own origin, with a fresh ticket: it is
     *  called for every (re)connection, since tickets last a minute. It throws `TicketRefused` when the user's sign-in
     *  is what failed. */
    constructor(
        private readonly url: () => Promise<string>,
        private readonly on: RoomEvents,
    ) {
        for (const [id, doc] of [
            [DOC_TEXT, this.text],
            [DOC_REVIEW, this.review],
        ] as const) {
            const listener = (u: Uint8Array, origin: unknown): void => {
                if (origin !== this) this.queue(id, u);
            };
            doc.on('update', listener);
            this.docListeners.push([doc, listener]);
        }
        // y-protocols renews the local state every 15 s and times others out after 30 s. Neither is wanted: a message
        // every 15 s from every open tab keeps the room awake all day (awake time is what the platform bills), and the
        // room says when someone left.
        // `destroy` is the one public way to stop that timer; it also clears the local state and the listeners (none
        // yet), and the awareness works as before otherwise.
        this.awareness.destroy();
        this.awareness.on('update', this.onAwareness);
        this.connect();
    }

    private readonly onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
        // Remote states (applied here, or timed out by the awareness itself) are the room's to tell; only ours is sent.
        if (origin === this || ![...added, ...updated, ...removed].includes(this.awareness.clientID)) return;
        this.presenceDue = true;
        this.schedulePresence();
    };

    private schedulePresence(): void {
        if (this.presenceTimer !== undefined) return;
        this.presenceTimer = setTimeout(
            () => {
                this.presenceTimer = undefined;
                this.sendPresence();
            },
            Math.max(0, this.presenceAt + PRESENCE_MS - Date.now()),
        );
    }

    /** Sends this client's presence if it changed since the last send and the room takes messages now. */
    private sendPresence(): void {
        const ws = this.ws;
        if (!this.presenceDue || ws?.readyState !== WebSocket.OPEN || this.mode.mode === 'paused') return;
        this.presenceDue = false;
        this.presenceAt = Date.now();
        const e = encoding.createEncoder();
        encoding.writeUint8(e, DOC_REVIEW);
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
        ws.send(encoding.toUint8Array(e));
    }

    private connect(): void {
        if (this.closed) return;
        this.on.connection('connecting');
        this.url().then(
            url => this.openSocket(url),
            (e: unknown) => {
                if (this.closed) return;
                if (e instanceof TicketRefused && (e.status === 401 || e.status === 403)) {
                    this.closed = true;
                    this.on.connection('closed');
                    this.on.signedOut();
                } else this.retryLater();
            },
        );
    }

    /** Connects again after 0.5 s, doubling up to 30 s, each wait jittered down by up to half, so that the clients a
     *  room restart dropped do not all come back at once. */
    private retryLater(): void {
        if (this.closed) return;
        const wait = Math.min(30_000, 500 * 2 ** this.retry++) * (0.5 + Math.random() / 2);
        this.retryTimer = setTimeout(() => this.connect(), wait);
    }

    private openSocket(url: string): void {
        if (this.closed) return;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.addEventListener('open', () => {
            if (this.ws !== ws) return;
            this.retry = 0;
            this.resync = false;
            this.syncedDocs.clear();
            // The room's step 1 on this connection gets everything it lacks as our step 2, queued updates included.
            this.pending.clear();
            clearTimeout(this.flushTimer);
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
                this.presenceDue = true;
                this.sendPresence();
            }
        });
        ws.addEventListener('message', (m: MessageEvent) => {
            if (this.ws !== ws) return;
            if (typeof m.data === 'string') this.control(m.data);
            else if (m.data instanceof ArrayBuffer) this.binary(new Uint8Array(m.data));
        });
        ws.addEventListener('close', () => {
            if (this.ws !== ws) return;
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
                this.on.welcome(m.you, m.base, m.files, m.authors);
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
            case 'opened':
                this.on.opened(m.file);
                break;
            case 'authors':
                this.on.authors({ writers: m.writers, deleted: m.deleted });
                break;
            case 'backup-due':
                this.on.backupDue();
                break;
            case 'refused':
                if (m.reason === 'paused') this.resync = true;
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
        if (this.closed) return;
        const m = this.mode;
        if (m.mode === 'live') return this.flush();
        const wait = m.mode === 'batched' ? m.intervalMs : Math.max(1000, m.until - Date.now());
        this.flushTimer = setTimeout(() => {
            if (this.mode.mode === 'paused' && Date.now() >= this.mode.until) this.mode = { mode: 'live' };
            this.flush();
        }, wait);
    }

    private flush(): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || this.mode.mode === 'paused') return;
        if (this.resync) {
            // Reconnecting syncs both documents from their state vectors, the refused updates included.
            this.resync = false;
            ws.close();
            return;
        }
        this.sendPresence();
        for (const [id, list] of this.pending) {
            if (!list.length) continue;
            const e = encoding.createEncoder();
            encoding.writeUint8(e, id);
            encoding.writeVarUint(e, MSG_SYNC);
            writeUpdate(e, Y.mergeUpdates(list));
            ws.send(encoding.toUint8Array(e));
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

    /** Tells the room that `commit` now holds `files`: its new base. */
    committed(commit: string, files: readonly BaseFile[]): void {
        this.sendRaw(JSON.stringify({ type: 'committed', commit, files }));
    }

    /** Hands the room a push made outside it, merged into the session (`mergePush`): the room applies `update` and
     *  takes `to` as its base only if its base is still `from`, so one of several such merges is applied. */
    pulled(from: string, to: string, update: Uint8Array, files: readonly BaseFile[]): void {
        let binary = '';
        for (let i = 0; i < update.length; i += 0x8000) binary += String.fromCharCode(...update.subarray(i, i + 0x8000));
        this.sendRaw(JSON.stringify({ type: 'pulled', from, to, update: btoa(binary), files }));
    }

    /** Tells the room that a WIP backup of its changes was pushed as `commit`. */
    backedUp(commit: string): void {
        this.sendRaw(JSON.stringify({ type: 'backed-up', commit }));
    }

    /** The session text of every file the room has. */
    get files(): Y.Map<Y.Text> {
        return this.text.getMap<Y.Text>('files');
    }

    /** Leaves the room for good: closes the socket (the room drops this client's presence with it) and releases every
     *  timer and listener. Promises: no event is reported after it returns; calling it again does nothing. */
    close(): void {
        this.closed = true;
        this.awareness.off('update', this.onAwareness);
        clearTimeout(this.flushTimer);
        clearTimeout(this.retryTimer);
        clearTimeout(this.presenceTimer);
        this.presenceTimer = undefined;
        this.awareness.destroy();
        for (const [doc, listener] of this.docListeners) doc.off('update', listener);
        const ws = this.ws;
        this.ws = null;
        ws?.close();
    }
}
