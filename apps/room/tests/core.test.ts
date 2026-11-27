import { DatabaseSync } from 'node:sqlite';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';
import { RoomCore, type Peer } from '../src/core.ts';
import { DEFAULT_LIMITS, MAX_CONNECTION_MS, connectionExpired } from '../src/limits.ts';
import { DOC_REVIEW, DOC_TEXT, IdSet, MSG_AWARENESS, MSG_SYNC, type Access, type ServerMessage } from '@yukibana/papers-room-protocol';
import { RoomStore, type Sql, type SqlValue } from '../src/store.ts';

/** node:sqlite behind the Durable Object SQL interface. */
function memorySql(db = new DatabaseSync(':memory:')): Sql {
    return {
        exec(query, ...bindings) {
            const stmt = db.prepare(query);
            const reader = /^\s*(SELECT|PRAGMA)/i.test(query);
            const rows = reader ? (stmt.all(...(bindings as never[])) as Record<string, SqlValue>[]) : (stmt.run(...(bindings as never[])), []);
            return { toArray: () => rows };
        },
    };
}

/** A client: a Yjs text document and review document connected to the room through a fake socket. */
class Client {
    readonly text = new Y.Doc();
    readonly review = new Y.Doc();
    readonly control: ServerMessage[] = [];
    readonly peer: Peer;

    constructor(
        readonly room: RoomCore,
        login: string,
        access: Access,
    ) {
        this.peer = { identity: { login, name: login, access }, awarenessIds: new Set(), send: d => this.onServer(d) };
        for (const [id, doc] of [
            [DOC_TEXT, this.text],
            [DOC_REVIEW, this.review],
        ] as const) {
            doc.on('update', (u: Uint8Array, origin: unknown) => {
                if (origin === this) return;
                const e = encoding.createEncoder();
                encoding.writeUint8(e, id);
                encoding.writeVarUint(e, MSG_SYNC);
                writeUpdate(e, u);
                room.receive(this.peer, encoding.toUint8Array(e));
            });
        }
        room.connect(this.peer);
        for (const [id, doc] of [
            [DOC_TEXT, this.text],
            [DOC_REVIEW, this.review],
        ] as const) {
            const e = encoding.createEncoder();
            encoding.writeUint8(e, id);
            encoding.writeVarUint(e, MSG_SYNC);
            writeSyncStep1(e, doc);
            room.receive(this.peer, encoding.toUint8Array(e));
        }
    }

    private onServer(d: string | Uint8Array): void {
        if (typeof d === 'string') {
            this.control.push(JSON.parse(d) as ServerMessage);
            return;
        }
        const dec = decoding.createDecoder(d);
        const id = decoding.readUint8(dec);
        const kind = decoding.readVarUint(dec);
        if (kind !== MSG_SYNC) return;
        const reply = encoding.createEncoder();
        encoding.writeUint8(reply, id);
        encoding.writeVarUint(reply, MSG_SYNC);
        readSyncMessage(dec, reply, id === DOC_TEXT ? this.text : this.review, this);
        if (encoding.length(reply) > 2) this.room.receive(this.peer, encoding.toUint8Array(reply));
    }

    open(path: string, text: string, commit = 'c1'): void {
        this.room.receive(this.peer, JSON.stringify({ type: 'open', path, blob: `b-${path}`, text, commit }));
    }

    file(path: string): string | undefined {
        return this.text.getMap<Y.Text>('files').get(path)?.toString();
    }
}

describe('room', () => {
    it('shares an opened file and edits to it', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        const b = new Client(room, 'lena', 'write');
        a.open('paper.tex', 'Hello world');
        expect(b.file('paper.tex')).toBe('Hello world');
        b.text.getMap<Y.Text>('files').get('paper.tex')?.insert(5, ',');
        expect(a.file('paper.tex')).toBe('Hello, world');
        expect(a.control[0]).toMatchObject({ type: 'welcome', you: { login: 'ada', access: 'write' } });
    });

    it('creates a file once, however many open it', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        const b = new Client(room, 'lena', 'write');
        a.open('x.tex', 'abc');
        b.open('x.tex', 'abc');
        expect(a.file('x.tex')).toBe('abc');
    });

    it('lets commenters comment but not edit', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const w = new Client(room, 'ada', 'write');
        const c = new Client(room, 'weber', 'comment');
        w.open('paper.tex', 'Text');
        c.text.getMap<Y.Text>('files').get('paper.tex')?.insert(0, 'X');
        expect(w.file('paper.tex')).toBe('Text');
        expect(c.control.some(m => m.type === 'refused' && m.reason === 'access')).toBe(true);
        c.review.getMap('threads').set('t1', { body: 'Nice' });
        expect(w.review.getMap('threads').get('t1')).toEqual({ body: 'Nice' });
        c.room.receive(c.peer, JSON.stringify({ type: 'open', path: 'evil.tex', blob: 'b', text: 'x', commit: 'c1' }));
        expect(w.file('evil.tex')).toBeUndefined();
    });

    it('keeps everything across a restart', () => {
        const db = new DatabaseSync(':memory:');
        const room = new RoomCore(new RoomStore(memorySql(db)));
        const a = new Client(room, 'ada', 'write');
        a.open('paper.tex', 'one');
        a.text.getMap<Y.Text>('files').get('paper.tex')?.insert(3, ' two');
        const again = new RoomCore(new RoomStore(memorySql(db)));
        expect(again.text.getMap<Y.Text>('files').get('paper.tex')?.toString()).toBe('one two');
        const b = new Client(again, 'lena', 'write');
        expect(b.control[0]).toMatchObject({ type: 'welcome', base: 'c1', files: [{ path: 'paper.tex', text: 'one' }] });
    });

    it('refuses a file from another commit than the base', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        a.open('a.tex', 'a', 'c1');
        a.open('b.tex', 'b', 'c2');
        expect(a.file('b.tex')).toBeUndefined();
    });

    it('moves the base on commit and tells everyone', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        const b = new Client(room, 'lena', 'write');
        a.open('a.tex', 'a');
        room.receive(a.peer, JSON.stringify({ type: 'committed', commit: 'c2', files: [{ path: 'a.tex', blob: 'b2', text: 'a!', items: '' }] }));
        expect(b.control.at(-1)).toMatchObject({ type: 'base', base: 'c2', files: [{ path: 'a.tex', blob: 'b2', text: 'a!' }] });
    });

    it('takes a push made outside the room once, whoever of several notices it first', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        const b = new Client(room, 'lena', 'write');
        a.open('a.tex', 'one\n');
        const from = 'c1';
        // Each merges the push's change (a line added) into a copy of the session and sends that as one step.
        const pulled = (c: Client): string => {
            const copy = new Y.Doc();
            Y.applyUpdate(copy, Y.encodeStateAsUpdate(c.text));
            const before = Y.encodeStateVector(copy);
            copy.getMap<Y.Text>('files').get('a.tex')?.insert(4, 'two\n');
            const update = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(copy, before)));
            return JSON.stringify({ type: 'pulled', from, to: 'c9', update, files: [{ path: 'a.tex', blob: 'b9', text: 'one\ntwo\n', items: '' }] });
        };
        const fromA = pulled(a);
        const fromB = pulled(b);
        room.receive(a.peer, fromA);
        room.receive(b.peer, fromB);
        expect(room.text.getMap<Y.Text>('files').get('a.tex')?.toJSON()).toBe('one\ntwo\n');
        expect(a.text.getMap<Y.Text>('files').get('a.tex')?.toJSON()).toBe('one\ntwo\n');
        expect(b.text.getMap<Y.Text>('files').get('a.tex')?.toJSON()).toBe('one\ntwo\n');
        expect(b.control.filter(m => m.type === 'base')).toEqual([{ type: 'base', base: 'c9', files: [{ path: 'a.tex', blob: 'b9', text: 'one\ntwo\n', items: '' }] }]);
        // Someone with read access cannot.
        const r = new Client(room, 'rita', 'comment');
        room.receive(r.peer, JSON.stringify({ type: 'pulled', from: 'c9', to: 'c10', update: '', files: [] }));
        expect(r.control.at(-1)).toEqual({ type: 'refused', reason: 'access' });
    });

    it('relays presence and drops it when the connection goes', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        const remote = new Awareness(new Y.Doc());
        remote.setLocalState({ user: 'lena', file: 'a.tex', line: 3 });
        const lena: Peer = { identity: { login: 'lena', name: 'Lena', access: 'comment' }, awarenessIds: new Set(), send: () => {} };
        room.connect(lena);
        const e = encoding.createEncoder();
        encoding.writeUint8(e, DOC_REVIEW);
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, encodeAwarenessUpdate(remote, [remote.clientID]));
        room.receive(lena, encoding.toUint8Array(e));
        expect(room.awareness.getStates().get(remote.clientID)).toEqual({ user: 'lena', file: 'a.tex', line: 3 });
        room.disconnect(lena);
        expect(room.awareness.getStates().has(remote.clientID)).toBe(false);
        expect(a.peer.awarenessIds.size).toBe(0);
    });

    it('batches, then pauses, a room that sends too much', () => {
        let now = Date.UTC(2026, 10, 26, 12);
        const limits = { ...DEFAULT_LIMITS, burstBytes: 1000, bytesPerSecond: 100, bytesPerDay: 5000 };
        const room = new RoomCore(new RoomStore(memorySql()), () => now, limits);
        const a = new Client(room, 'ada', 'write');
        a.open('a.tex', '');
        const t = a.text.getMap<Y.Text>('files').get('a.tex');
        t?.insert(0, 'x'.repeat(1200));
        expect(a.control.some(m => m.type === 'sync' && m.sync.mode === 'batched')).toBe(true);
        now += 60_000;
        t?.insert(0, 'y'.repeat(5000));
        t?.insert(0, 'z');
        expect(a.control.some(m => m.type === 'refused' && m.reason === 'paused')).toBe(true);
        expect(a.control.some(m => m.type === 'sync' && m.sync.mode === 'paused')).toBe(true);
    });

    it('does not count a commenter’s edits to the text against the room', () => {
        const limits = { ...DEFAULT_LIMITS, bytesPerDay: 2000, personBytesPerDay: 100_000 };
        const room = new RoomCore(new RoomStore(memorySql()), Date.now, limits);
        const w = new Client(room, 'ada', 'write');
        const c = new Client(room, 'weber', 'comment');
        w.open('a.tex', '');
        const t = c.text.getMap<Y.Text>('files').get('a.tex');
        for (let i = 0; i < 10; i++) t?.insert(0, 'x'.repeat(500));
        expect(c.control.filter(m => m.type === 'refused').every(m => m.type === 'refused' && m.reason === 'access')).toBe(true);
        w.text.getMap<Y.Text>('files').get('a.tex')?.insert(0, 'ok');
        expect(w.control.some(m => m.type === 'refused')).toBe(false);
        expect(w.file('a.tex')).toBe('ok');
    });

    it('gives each person their own budget', () => {
        let now = Date.UTC(2026, 10, 26, 12);
        const limits = { ...DEFAULT_LIMITS, personBurstBytes: 3000, personBytesPerSecond: 10, personBytesPerDay: 20_000 };
        const room = new RoomCore(new RoomStore(memorySql()), () => now, limits);
        const a = new Client(room, 'ada', 'write');
        const b = new Client(room, 'lena', 'write');
        a.open('a.tex', '');
        const t = a.text.getMap<Y.Text>('files').get('a.tex');
        t?.insert(0, 'x'.repeat(2000));
        t?.insert(0, 'y'.repeat(2000));
        expect(a.control.some(m => m.type === 'refused' && m.reason === 'too-fast')).toBe(true);
        // Ada's burst is spent; Lena's is her own.
        b.text.getMap<Y.Text>('files').get('a.tex')?.insert(0, 'z'.repeat(2000));
        expect(b.control.some(m => m.type === 'refused')).toBe(false);
        // And a second connection of Ada's shares Ada's.
        const a2 = new Client(room, 'ada', 'write');
        a2.text.getMap<Y.Text>('files').get('a.tex')?.insert(0, 'w'.repeat(2000));
        expect(a2.control.some(m => m.type === 'refused' && m.reason === 'too-fast')).toBe(true);
        // A day's share is a ceiling however slowly it is spent.
        for (let i = 0; i < 12; i++) {
            now += 300_000;
            b.text.getMap<Y.Text>('files').get('a.tex')?.insert(0, 'v'.repeat(2000));
        }
        expect(b.control.some(m => m.type === 'refused' && m.reason === 'paused')).toBe(true);
    });

    it('keeps each presence with the connection that announced it', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const awarenessOf = (login: string): Peer => ({ identity: { login, name: login, access: 'comment' }, awarenessIds: new Set(), send: () => {} });
        const announce = (p: Peer, a: Awareness): void => {
            const e = encoding.createEncoder();
            encoding.writeUint8(e, DOC_REVIEW);
            encoding.writeVarUint(e, MSG_AWARENESS);
            encoding.writeVarUint8Array(e, encodeAwarenessUpdate(a, [a.clientID]));
            room.receive(p, encoding.toUint8Array(e));
        };
        const lena = awarenessOf('lena');
        const eve = awarenessOf('eve');
        room.connect(lena);
        room.connect(eve);
        const real = new Awareness(new Y.Doc());
        real.setLocalState({ user: 'lena', line: 3 });
        announce(lena, real);
        // Eve claims Lena's client id.
        const forged = new Y.Doc();
        forged.clientID = real.clientID;
        const fake = new Awareness(forged);
        // A newer clock than Lena's, so that without the binding the room would take it.
        for (let i = 0; i < 3; i++) fake.setLocalState({ user: 'lena', line: 99 });
        announce(eve, fake);
        expect(room.awareness.getStates().get(real.clientID)).toEqual({ user: 'lena', line: 3 });
        expect(eve.awarenessIds.size).toBe(0);
        // Once Lena's connection goes, the id is free again.
        room.disconnect(lena);
        for (let i = 0; i < 3; i++) fake.setLocalState({ user: 'lena', line: 99 }); // newer than the removal
        announce(eve, fake);
        expect(room.awareness.getStates().get(real.clientID)).toEqual({ user: 'lena', line: 99 });
    });

    it('ends connections after an hour', () => {
        const since = Date.UTC(2026, 10, 26, 12);
        const attachment = JSON.stringify({ login: 'ada', name: 'Ada', access: 'write', since });
        expect(connectionExpired(attachment, since + MAX_CONNECTION_MS - 1)).toBe(false);
        expect(connectionExpired(attachment, since + MAX_CONNECTION_MS)).toBe(true);
        expect(connectionExpired(JSON.stringify({ login: 'ada', name: 'Ada', access: 'write' }), since)).toBe(true);
        expect(connectionExpired(null, since)).toBe(true);
    });

    it('asks a writer for a WIP backup after changes', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        a.open('a.tex', 'a');
        expect(room.tick()).toBe(true);
        expect(a.control.at(-1)).toEqual({ type: 'backup-due' });
        room.receive(a.peer, JSON.stringify({ type: 'backed-up', commit: 'w1' }));
        expect(room.tick()).toBe(false);
    });

    it('knows who wrote each character and who deleted committed ones, and nobody can write as someone else', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        const b = new Client(room, 'lena', 'write');
        a.open('a.tex', 'one two\n');
        const base = room.authors;
        expect(base.writers).toEqual([]);
        const committed = IdSet.decode(room.baseFiles[0]?.items ?? '');
        expect(committed?.size).toBe(8);
        const tb = b.text.getMap<Y.Text>('files').get('a.tex');
        tb?.insert(3, '!');
        tb?.delete(4, 4);
        const ta = a.text.getMap<Y.Text>('files').get('a.tex');
        ta?.insert(0, 'x');
        ta?.delete(0, 1);
        expect(a.file('a.tex')).toBe('one!\n');
        const who = room.authors;
        expect(who.writers).toEqual(
            [
                [b.text.clientID, 'lena'],
                [a.text.clientID, 'ada'],
            ].toSorted((x, y) => (x[0] as number) - (y[0] as number)),
        );
        // Lena deleted " two" (four committed characters); Ada's own typo is not a committed character.
        expect(who.deleted.map(d => [d[2], d[3]])).toEqual([[4, 'lena']]);
        expect(a.control.filter(m => m.type === 'authors').length).toBeGreaterThan(0);
        expect(new Client(room, 'marco', 'write').control[0]).toMatchObject({ type: 'welcome', authors: who });

        // Marco writing with Lena's client id stays Lena's.
        const forged = new Y.Doc();
        forged.clientID = b.text.clientID;
        Y.applyUpdate(forged, Y.encodeStateAsUpdate(a.text));
        const m = new Client(room, 'marco', 'write');
        const e = encoding.createEncoder();
        encoding.writeUint8(e, DOC_TEXT);
        encoding.writeVarUint(e, MSG_SYNC);
        const before = Y.encodeStateVector(forged);
        forged.getMap<Y.Text>('files').get('a.tex')?.insert(0, 'm');
        writeUpdate(e, Y.encodeStateAsUpdate(forged, before));
        room.receive(m.peer, encoding.toUint8Array(e));
        expect(room.authors.writers.filter(w => w[0] === b.text.clientID)).toEqual([[b.text.clientID, 'lena']]);
    });

    it('forgets deletions once a commit takes them in', () => {
        const room = new RoomCore(new RoomStore(memorySql()));
        const a = new Client(room, 'ada', 'write');
        a.open('a.tex', 'abc');
        a.text.getMap<Y.Text>('files').get('a.tex')?.delete(0, 1);
        expect(room.authors.deleted).toHaveLength(1);
        const items = room.baseFiles[0]?.items ?? '';
        const kept = new IdSet();
        for (const [client, clock, len] of IdSet.decode(items)?.ranges() ?? []) kept.add(client, clock + 1, len - 1);
        room.receive(a.peer, JSON.stringify({ type: 'committed', commit: 'c2', files: [{ path: 'a.tex', blob: '', text: 'bc', items: kept.encode() }] }));
        expect(room.authors.deleted).toEqual([]);
    });
});
