import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate, writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import * as Y from 'yjs';
import { DEFAULT_LIMITS, PersonMeter, UsageMeter, dayOf, type Limits } from './limits.ts';
import {
    DOC_REVIEW,
    DOC_TEXT,
    IdSet,
    MSG_AWARENESS,
    MSG_SYNC,
    parseClientMessage,
    type Authors,
    type BaseFile,
    type DocId,
    type Identity,
    type ServerMessage,
    type SyncMode,
} from '@yukibana/papers-room-protocol';
import type { RoomStore } from './store.ts';

/** One connection to the room. */
export interface Peer {
    readonly identity: Identity;
    send(data: string | Uint8Array): void;
    /** The awareness client ids this connection has announced, so they go when it does. */
    readonly awarenessIds: Set<number>;
}

/** The ids of `text`'s characters that are in it now, in order: what a file's committed state is when the room
 *  creates it from that very text. */
export function visibleIds(text: Y.Text): IdSet {
    const ids = new IdSet();
    // The items, deleted ones included, are only reachable through Yjs's own field: no public API walks them with ids.
    // oxlint-disable-next-line no-underscore-dangle
    for (let item = text._start; item !== null; item = item.right) if (!item.deleted && item.countable) ids.add(item.id.client, item.id.clock, item.length);
    return ids;
}

/** Compact a document's update log once it is this long. */
const COMPACT_AFTER = 200;
/** How long the day's byte counter may be ahead of its stored copy. A room that hibernates within it undercounts by
 *  what arrived in that time: the budget is a guard against runaway use, not an account. */
const USAGE_SAVE_MS = 10_000;

/** Whether `data` is a Yjs message that would change the text document (a sync step 2 or an update to it); false for
 *  anything else, malformed messages included (those are refused later, as invalid). */
function changesText(data: Uint8Array): boolean {
    try {
        const dec = decoding.createDecoder(data);
        if (decoding.readUint8(dec) !== DOC_TEXT || decoding.readVarUint(dec) !== MSG_SYNC) return false;
        const sync = decoding.readVarUint(dec);
        return sync === messageYjsSyncStep2 || sync === messageYjsUpdate;
    } catch {
        return false;
    }
}

/** A room: the two Yjs documents of one branch's session, kept in memory and in the room's SQL storage, and the
 *  connections to it. It is the Durable Object's logic without the Durable Object, so tests drive it directly.
 *
 *  Invariants: every change applied to a document is in the store before it is sent to anyone; a connection with
 *  `comment` access never changes the text document; the base commit and the files' committed state change only on
 *  `open` (for a file the room does not have yet), `committed` and `pulled`, all from `write` connections. */
export class RoomCore {
    readonly text = new Y.Doc();
    readonly review = new Y.Doc();
    readonly awareness = new Awareness(this.review);
    private readonly peers = new Set<Peer>();
    private readonly meter: UsageMeter;
    /** Each person's own budget, by login, across their connections. */
    private readonly people = new Map<string, PersonMeter>();
    /** The connection each awareness client id belongs to: the first to announce it, until it disconnects. */
    private readonly awarenessOwners = new Map<number, Peer>();
    private lastMode: SyncMode = { mode: 'live' };
    /** Every committed file's character ids together: deletions of these are the ones worth recording. */
    private baseIds = new IdSet();
    /** What the store holds, kept here so that a message costs no reads and only the writes that say something new:
     *  the length of each document's update log, whether the text has changes no backup holds (`meta.dirty`), and the
     *  byte counter as last stored with when. */
    private readonly logged = new Map<DocId, number>();
    /** The login each client id writes as (`writers` in the store). */
    private readonly writers: Map<number, string>;
    private dirty: boolean;
    private usageSaved: { day: string; bytes: number; at: number };

    constructor(
        private readonly store: RoomStore,
        private readonly now: () => number = Date.now,
        private readonly limits: Limits = DEFAULT_LIMITS,
    ) {
        // The server holds no presence of its own.
        this.awareness.setLocalState(null);
        for (const [id, doc] of [
            [DOC_TEXT, this.text],
            [DOC_REVIEW, this.review],
        ] as const) {
            const log = store.updates(id);
            for (const u of log) Y.applyUpdate(doc, u, 'storage');
            this.logged.set(id, log.length);
            doc.on('update', (update: Uint8Array, origin: unknown) => this.onUpdate(id, update, origin));
        }
        this.text.on('afterTransaction', (tr: Y.Transaction) => this.recordAuthors(tr));
        this.loadBaseIds();
        this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
            const changed = [...added, ...updated, ...removed];
            const msg = encoding.createEncoder();
            encoding.writeUint8(msg, DOC_REVIEW);
            encoding.writeVarUint(msg, MSG_AWARENESS);
            encoding.writeVarUint8Array(msg, encodeAwarenessUpdate(this.awareness, changed));
            this.broadcast(encoding.toUint8Array(msg), origin);
        });
        this.dirty = store.getMeta('dirty') === '1';
        this.writers = new Map(store.authors().writers);
        const day = dayOf(now());
        store.pruneUsage(day);
        const bytes = store.usage(day, 'bytes');
        this.usageSaved = { day, bytes, at: now() };
        this.meter = new UsageMeter(limits, { day, bytes }, now());
    }

    private docOf(id: DocId): Y.Doc {
        return id === DOC_TEXT ? this.text : this.review;
    }

    private loadBaseIds(): void {
        const ids = new IdSet();
        for (const f of this.store.baseFiles()) for (const [client, clock, len] of IdSet.decode(f.items)?.ranges() ?? []) ids.add(client, clock, len);
        this.baseIds = ids;
    }

    /** After a change to the text from a connection: the clients it wrote with that nobody wrote with before are its
     *  person's from now on, and the committed characters it deleted were deleted by that person. Both are stored, then
     *  told to everyone. Changes the room makes itself (opening a file, merging a push) are nobody's. A client id
     *  someone else wrote with first stays theirs: an id is random, so taking one over is not an accident. */
    private recordAuthors(tr: Y.Transaction): void {
        const p = [...this.peers].find(x => x === tr.origin);
        if (!p) return;
        const login = p.identity.login;
        const writers: [number, string][] = [];
        for (const [client, clock] of tr.afterState) {
            if (clock > (tr.beforeState.get(client) ?? 0) && !this.writers.has(client)) {
                this.store.addWriter(client, login);
                this.writers.set(client, login);
                writers.push([client, login]);
            }
        }
        const deleted: [number, number, number, string][] = [];
        for (const [client, items] of tr.deleteSet.clients) {
            for (const d of items) {
                let clock = d.clock;
                const end = d.clock + d.len;
                while (clock < end) {
                    const r = this.baseIds.run(client, clock, end - clock);
                    if (r.inSet) {
                        this.store.addDeletion(client, clock, r.len, login);
                        deleted.push([client, clock, r.len, login]);
                    }
                    clock += r.len;
                }
            }
        }
        if (writers.length || deleted.length) this.broadcast(JSON.stringify({ type: 'authors', writers, deleted } satisfies ServerMessage), null);
    }

    /** Keeps only the deletions of characters some committed state still holds: the rest are committed. */
    private pruneDeletions(): void {
        const { deleted } = this.store.authors();
        const kept: [number, number, number, string][] = [];
        for (const [client, clock0, len, login] of deleted) {
            let clock = clock0;
            while (clock < clock0 + len) {
                const r = this.baseIds.run(client, clock, clock0 + len - clock);
                if (r.inSet) kept.push([client, clock, r.len, login]);
                clock += r.len;
            }
        }
        if (kept.length !== deleted.length || kept.some((k, i) => k[2] !== deleted[i]?.[2])) this.store.setDeletions(kept);
    }

    /** Every file's committed state. */
    get baseFiles(): BaseFile[] {
        return this.store.baseFiles();
    }

    /** What the room knows about who wrote what, for a new connection. */
    get authors(): Authors {
        return this.store.authors();
    }

    private onUpdate(id: DocId, update: Uint8Array, origin: unknown): void {
        if (origin === 'storage') return;
        this.store.appendUpdate(id, update, this.now());
        if (id === DOC_TEXT && !this.dirty) {
            this.store.setMeta('dirty', '1');
            this.dirty = true;
        }
        const logged = (this.logged.get(id) ?? 0) + 1;
        this.logged.set(id, logged);
        if (logged > COMPACT_AFTER) this.compact(id);
        const msg = encoding.createEncoder();
        encoding.writeUint8(msg, id);
        encoding.writeVarUint(msg, MSG_SYNC);
        encoding.writeVarUint(msg, messageYjsUpdate);
        encoding.writeVarUint8Array(msg, update);
        this.broadcast(encoding.toUint8Array(msg), origin);
    }

    /** Makes `id`'s log one update. */
    private compact(id: DocId): void {
        this.store.compact(id, Y.encodeStateAsUpdate(this.docOf(id)), this.now());
        this.logged.set(id, 1);
    }

    /** Stores the day's byte counter if it changed: at once with `now`, else once it is `USAGE_SAVE_MS` old. */
    private saveUsage(now: boolean): void {
        const { day, bytes } = this.meter.counter;
        const t = this.now();
        if (day === this.usageSaved.day && (bytes === this.usageSaved.bytes || (!now && t - this.usageSaved.at < USAGE_SAVE_MS))) return;
        this.store.setUsage(day, 'bytes', bytes);
        this.usageSaved = { day, bytes, at: t };
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
        this.sendControl(p, {
            type: 'welcome',
            you: p.identity,
            base: this.store.getMeta('base'),
            files: this.store.baseFiles(),
            sync: this.meter.mode(this.now()),
            authors: this.store.authors(),
        });
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
        for (const id of p.awarenessIds) if (this.awarenessOwners.get(id) === p) this.awarenessOwners.delete(id);
        // An empty room is put away soon: nothing later would store the counter.
        if (this.peers.size === 0) this.saveUsage(true);
    }

    get connections(): number {
        return this.peers.size;
    }

    /** Handles one message from `p`. Malformed messages are refused, never thrown. Messages `p` may not send at all
     *  (changes to the text, or control messages, from `comment` access) are refused before they count against any
     *  budget; the rest count against `p`'s person's own budget, then the room's. */
    receive(p: Peer, data: string | Uint8Array): void {
        const size = typeof data === 'string' ? data.length * 2 : data.byteLength;
        if (p.identity.access !== 'write' && (typeof data === 'string' || changesText(data))) return this.sendControl(p, { type: 'refused', reason: 'access' });
        if (size > this.limits.maxMessageBytes) return this.sendControl(p, { type: 'refused', reason: 'too-large' });
        let person = this.people.get(p.identity.login);
        if (!person) {
            person = new PersonMeter(this.limits, this.now());
            this.people.set(p.identity.login, person);
        }
        const own = person.take(size, this.now());
        if (own !== 'ok') return this.sendControl(p, { type: 'refused', reason: own });
        const verdict = this.meter.take(size, this.now());
        this.saveUsage(false);
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
            // The awareness clients this update speaks for: each must be new, or this connection's already.
            const d = decoding.createDecoder(update);
            const n = decoding.readVarUint(d);
            const ids: number[] = [];
            for (let i = 0; i < n; i++) {
                const client = decoding.readVarUint(d);
                const owner = this.awarenessOwners.get(client);
                if (client === this.awareness.clientID || (owner !== undefined && owner !== p)) throw new Error('another connection’s presence');
                ids.push(client);
                decoding.readVarUint(d);
                decoding.readVarString(d);
            }
            for (const client of ids) {
                p.awarenessIds.add(client);
                this.awarenessOwners.set(client, p);
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
                const text = new Y.Text(m.text);
                this.text.transact(() => files.set(m.path, text), 'server');
                const file = { path: m.path, blob: m.blob, text: m.text, items: visibleIds(text).encode() };
                this.store.setBaseFile(file);
                this.loadBaseIds();
                for (const peer of this.peers) this.sendControl(peer, { type: 'opened', file });
                return;
            }
            case 'committed': {
                this.store.setMeta('base', m.commit);
                for (const f of m.files) this.store.setBaseFile(f);
                this.loadBaseIds();
                this.pruneDeletions();
                const all = this.store.baseFiles();
                for (const peer of this.peers) this.sendControl(peer, { type: 'base', base: m.commit, files: all });
                return;
            }
            case 'pulled': {
                // Someone else's merge of the same push got here first: theirs stands, and this one is dropped whole.
                if (this.store.getMeta('base') !== m.from) return;
                Y.applyUpdate(
                    this.text,
                    Uint8Array.from(atob(m.update), c => c.charCodeAt(0)),
                    'server',
                );
                this.store.setMeta('base', m.to);
                for (const f of m.files) this.store.setBaseFile(f);
                this.loadBaseIds();
                this.pruneDeletions();
                const all = this.store.baseFiles();
                for (const peer of this.peers) this.sendControl(peer, { type: 'base', base: m.to, files: all });
                return;
            }
            case 'backed-up':
                this.store.setMeta('dirty', '0');
                this.dirty = false;
                this.store.setMeta('backup', m.commit);
                return;
        }
    }

    /** The alarm's work: compact both logs, and ask a writer for a WIP backup if the text changed since the last one.
     *  Returns whether there is anyone to ask. */
    tick(): boolean {
        for (const id of [DOC_TEXT, DOC_REVIEW] as const) if ((this.logged.get(id) ?? 0) > 1) this.compact(id);
        this.saveUsage(true);
        this.announceMode();
        if (!this.dirty) return false;
        const writer = [...this.peers].find(p => p.identity.access === 'write');
        if (writer) this.sendControl(writer, { type: 'backup-due' });
        return writer !== undefined;
    }
}
