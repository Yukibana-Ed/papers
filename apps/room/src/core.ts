import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate, writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import * as Y from 'yjs';
import { DEFAULT_LIMITS, UsageMeter, dayOf, type Limits } from './limits.ts';
import { DOC_REVIEW, DOC_TEXT, MSG_AWARENESS, MSG_SYNC, parseClientMessage, type DocId, type Identity, type ServerMessage, type SyncMode } from './protocol.ts';
import type { RoomStore } from './store.ts';

/** One connection to the room. */
export interface Peer {
    readonly identity: Identity;
    send(data: string | Uint8Array): void;
    /** The awareness client ids this connection has announced, so they go when it does. */
    readonly awarenessIds: Set<number>;
}

/** Compact a document's update log once it is this long. */
const COMPACT_AFTER = 200;

/** A room: the two Yjs documents of one branch's session, kept in memory and in the room's SQL storage, and the
 *  connections to it. It is the Durable Object's logic without the Durable Object, so tests drive it directly.
 *
 *  Invariants: every change applied to a document is in the store before it is sent to anyone; a connection with
 *  `comment` access never changes the text document; the base commit and the files' committed state change only on
 *  `open` (for a file the room does not have yet) and `committed`, both from `write` connections. */
export class RoomCore {
    readonly text = new Y.Doc();
    readonly review = new Y.Doc();
    readonly awareness = new Awareness(this.review);
    private readonly peers = new Set<Peer>();
    private readonly meter: UsageMeter;
    private lastMode: SyncMode = { mode: 'live' };

    constructor(
        private readonly store: RoomStore,
        private readonly now: () => number = Date.now,
        limits: Limits = DEFAULT_LIMITS,
    ) {
        // The server holds no presence of its own.
        this.awareness.setLocalState(null);
        for (const [id, doc] of [
            [DOC_TEXT, this.text],
            [DOC_REVIEW, this.review],
        ] as const) {
            for (const u of store.updates(id)) Y.applyUpdate(doc, u, 'storage');
            doc.on('update', (update: Uint8Array, origin: unknown) => this.onUpdate(id, update, origin));
        }
        this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
            const changed = [...added, ...updated, ...removed];
            const msg = encoding.createEncoder();
            encoding.writeUint8(msg, DOC_REVIEW);
            encoding.writeVarUint(msg, MSG_AWARENESS);
            encoding.writeVarUint8Array(msg, encodeAwarenessUpdate(this.awareness, changed));
            this.broadcast(encoding.toUint8Array(msg), origin);
        });
        const day = dayOf(now());
        this.meter = new UsageMeter(limits, { day, bytes: store.usage(day, 'bytes') }, now());
    }

    private docOf(id: DocId): Y.Doc {
        return id === DOC_TEXT ? this.text : this.review;
    }

    private onUpdate(id: DocId, update: Uint8Array, origin: unknown): void {
        if (origin === 'storage') return;
        this.store.appendUpdate(id, update, this.now());
        if (id === DOC_TEXT) this.store.setMeta('dirty', '1');
        if (this.store.updateCount(id) > COMPACT_AFTER) this.store.compact(id, Y.encodeStateAsUpdate(this.docOf(id)), this.now());
        const msg = encoding.createEncoder();
        encoding.writeUint8(msg, id);
        encoding.writeVarUint(msg, MSG_SYNC);
        encoding.writeVarUint(msg, messageYjsUpdate);
        encoding.writeVarUint8Array(msg, update);
        this.broadcast(encoding.toUint8Array(msg), origin);
    }

    private broadcast(data: Uint8Array | string, except: unknown): void {
        for (const p of this.peers) if (p !== except) p.send(data);
    }

    private sendControl(p: Peer, m: ServerMessage): void {
        p.send(JSON.stringify(m));
    }

    /** Adds a connection: tells it who it is, where the room is, and starts the sync of both documents. */
    connect(p: Peer): void {
        this.peers.add(p);
        this.sendControl(p, { type: 'welcome', you: p.identity, base: this.store.getMeta('base'), files: this.store.baseFiles(), sync: this.meter.mode(this.now()) });
        for (const id of [DOC_TEXT, DOC_REVIEW] as const) {
            const msg = encoding.createEncoder();
            encoding.writeUint8(msg, id);
            encoding.writeVarUint(msg, MSG_SYNC);
            writeSyncStep1(msg, this.docOf(id));
            p.send(encoding.toUint8Array(msg));
        }
        const states = [...this.awareness.getStates().keys()];
        if (states.length) {
            const msg = encoding.createEncoder();
            encoding.writeUint8(msg, DOC_REVIEW);
            encoding.writeVarUint(msg, MSG_AWARENESS);
            encoding.writeVarUint8Array(msg, encodeAwarenessUpdate(this.awareness, states));
            p.send(encoding.toUint8Array(msg));
        }
    }

    /** Removes a connection and its presence. */
    disconnect(p: Peer): void {
        this.peers.delete(p);
        if (p.awarenessIds.size) removeAwarenessStates(this.awareness, [...p.awarenessIds], p);
    }

    get connections(): number {
        return this.peers.size;
    }

    /** Handles one message from `p`. Malformed messages are refused, never thrown. */
    receive(p: Peer, data: string | Uint8Array): void {
        const size = typeof data === 'string' ? data.length * 2 : data.byteLength;
        const verdict = this.meter.take(size, this.now());
        this.store.setUsage(this.meter.counter.day, 'bytes', this.meter.counter.bytes);
        this.announceMode();
        if (verdict !== 'ok') return this.sendControl(p, { type: 'refused', reason: verdict });
        try {
            if (typeof data === 'string') this.receiveControl(p, data);
            else this.receiveYjs(p, data);
        } catch {
            this.sendControl(p, { type: 'refused', reason: 'invalid' });
        }
    }

    private announceMode(): void {
        const mode = this.meter.mode(this.now());
        if (JSON.stringify(mode) === JSON.stringify(this.lastMode)) return;
        this.lastMode = mode;
        for (const p of this.peers) this.sendControl(p, { type: 'sync', sync: mode });
    }

    private receiveYjs(p: Peer, data: Uint8Array): void {
        const dec = decoding.createDecoder(data);
        const id = decoding.readUint8(dec);
        if (id !== DOC_TEXT && id !== DOC_REVIEW) throw new Error('unknown document');
        const kind = decoding.readVarUint(dec);
        if (kind === MSG_AWARENESS) {
            if (id !== DOC_REVIEW) throw new Error('awareness is on the review document');
            const update = decoding.readVarUint8Array(dec);
            // Remember which awareness clients this connection speaks for.
            const d = decoding.createDecoder(update);
            const n = decoding.readVarUint(d);
            for (let i = 0; i < n; i++) {
                p.awarenessIds.add(decoding.readVarUint(d));
                decoding.readVarUint(d);
                decoding.readVarString(d);
            }
            applyAwarenessUpdate(this.awareness, update, p);
            return;
        }
        if (kind !== MSG_SYNC) throw new Error('unknown message');
        const doc = this.docOf(id);
        const sync = decoding.readVarUint(dec);
        if (sync === messageYjsSyncStep1) {
            const sv = decoding.readVarUint8Array(dec);
            const msg = encoding.createEncoder();
            encoding.writeUint8(msg, id);
            encoding.writeVarUint(msg, MSG_SYNC);
            writeSyncStep2(msg, doc, sv);
            p.send(encoding.toUint8Array(msg));
            return;
        }
        if (sync !== messageYjsSyncStep2 && sync !== messageYjsUpdate) throw new Error('unknown sync message');
        if (id === DOC_TEXT && p.identity.access !== 'write') return this.sendControl(p, { type: 'refused', reason: 'access' });
        Y.applyUpdate(doc, decoding.readVarUint8Array(dec), p);
    }

    private receiveControl(p: Peer, data: string): void {
        const m = parseClientMessage(JSON.parse(data));
        if (!m) return this.sendControl(p, { type: 'refused', reason: 'invalid' });
        if (p.identity.access !== 'write') return this.sendControl(p, { type: 'refused', reason: 'access' });
        const files = this.text.getMap<Y.Text>('files');
        switch (m.type) {
            case 'open': {
                if (files.has(m.path)) return;
                const base = this.store.getMeta('base');
                // A file opened at another commit than the room's base would mix two states of the branch.
                if (base !== null && base !== m.commit) return this.sendControl(p, { type: 'refused', reason: 'invalid' });
                if (base === null) this.store.setMeta('base', m.commit);
                this.store.setBaseFile({ path: m.path, blob: m.blob, text: m.text });
                this.text.transact(() => files.set(m.path, new Y.Text(m.text)), 'server');
                return;
            }
            case 'committed': {
                this.store.setMeta('base', m.commit);
                for (const f of m.files) this.store.setBaseFile(f);
                const all = this.store.baseFiles();
                for (const peer of this.peers) this.sendControl(peer, { type: 'base', base: m.commit, files: all });
                return;
            }
            case 'backed-up':
                this.store.setMeta('dirty', '0');
                this.store.setMeta('backup', m.commit);
                return;
        }
    }

    /** The alarm's work: compact both logs, and ask a writer for a WIP backup if the text changed since the last one.
     *  Returns whether there is anyone to ask. */
    tick(): boolean {
        for (const id of [DOC_TEXT, DOC_REVIEW] as const) if (this.store.updateCount(id) > 1) this.store.compact(id, Y.encodeStateAsUpdate(this.docOf(id)), this.now());
        this.announceMode();
        if (this.store.getMeta('dirty') !== '1') return false;
        const writer = [...this.peers].find((p) => p.identity.access === 'write');
        if (writer) this.sendControl(writer, { type: 'backup-due' });
        return writer !== undefined;
    }
}
