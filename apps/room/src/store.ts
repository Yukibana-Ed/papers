import type { BaseFile, DocId } from './protocol.ts';

/** The subset of a Durable Object's SQL API the room uses (`ctx.storage.sql`): run a statement with bindings and get
 *  its rows. Tests give it node:sqlite instead. */
export interface Sql {
    exec(query: string, ...bindings: (string | number | ArrayBuffer | Uint8Array | null)[]): { toArray(): Record<string, SqlValue>[] };
}
export type SqlValue = string | number | ArrayBuffer | Uint8Array | null;

/** The schema, in order. A new step is appended, never edited: a room's database is migrated by running the steps
 *  after the one it is at. Every column is NOT NULL. */
const MIGRATIONS: readonly string[] = [
    `CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
     CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, doc INTEGER NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL) STRICT;
     CREATE INDEX updates_doc ON updates (doc, id);
     CREATE TABLE base_files (path TEXT PRIMARY KEY NOT NULL, blob TEXT NOT NULL, text TEXT NOT NULL) STRICT;
     CREATE TABLE usage (day TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, metric)) STRICT;`,
];

function str(v: SqlValue | undefined): string {
    if (typeof v !== 'string') throw new TypeError('Expected TEXT');
    return v;
}

function bytes(v: SqlValue | undefined): Uint8Array {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    throw new TypeError('Expected a BLOB');
}

/** A room's durable state: the Yjs update log of each document, the committed state of the files, the base commit,
 *  and the usage counters. */
export class RoomStore {
    /** Precondition: `sql` belongs to this room alone. Migrates it to the current schema. */
    constructor(private readonly sql: Sql) {
        sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT');
        const row = sql.exec('SELECT version FROM schema_version').toArray()[0];
        let version = row ? Number(row['version']) : 0;
        if (!row) sql.exec('INSERT INTO schema_version (version) VALUES (0)');
        for (; version < MIGRATIONS.length; version++) {
            for (const statement of (MIGRATIONS[version] ?? '').split(';')) if (statement.trim()) sql.exec(statement);
            sql.exec('UPDATE schema_version SET version = ?', version + 1);
        }
    }

    getMeta(key: string): string | null {
        const row = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
        return row ? str(row['value']) : null;
    }

    setMeta(key: string, value: string): void {
        this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
    }

    /** Every update of `doc`, oldest first. */
    updates(doc: DocId): Uint8Array[] {
        return this.sql
            .exec('SELECT data FROM updates WHERE doc = ? ORDER BY id', doc)
            .toArray()
            .map(r => bytes(r['data']));
    }

    appendUpdate(doc: DocId, data: Uint8Array, at: number): void {
        this.sql.exec('INSERT INTO updates (doc, data, at) VALUES (?, ?, ?)', doc, data, at);
    }

    updateCount(doc: DocId): number {
        return Number(this.sql.exec('SELECT count(*) AS n FROM updates WHERE doc = ?', doc).toArray()[0]?.['n'] ?? 0);
    }

    /** Replaces `doc`'s whole log with one update that `state` holds (its state as one update). */
    compact(doc: DocId, state: Uint8Array, at: number): void {
        this.sql.exec('DELETE FROM updates WHERE doc = ?', doc);
        this.appendUpdate(doc, state, at);
    }

    baseFiles(): BaseFile[] {
        return this.sql
            .exec('SELECT path, blob, text FROM base_files ORDER BY path')
            .toArray()
            .map(r => ({ path: str(r['path']), blob: str(r['blob']), text: str(r['text']) }));
    }

    baseFile(path: string): BaseFile | null {
        const r = this.sql.exec('SELECT path, blob, text FROM base_files WHERE path = ?', path).toArray()[0];
        return r ? { path: str(r['path']), blob: str(r['blob']), text: str(r['text']) } : null;
    }

    setBaseFile(f: BaseFile): void {
        this.sql.exec(
            'INSERT INTO base_files (path, blob, text) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET blob = excluded.blob, text = excluded.text',
            f.path,
            f.blob,
            f.text,
        );
    }

    usage(day: string, metric: string): number {
        return Number(this.sql.exec('SELECT value FROM usage WHERE day = ? AND metric = ?', day, metric).toArray()[0]?.['value'] ?? 0);
    }

    setUsage(day: string, metric: string, value: number): void {
        this.sql.exec('INSERT INTO usage (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = excluded.value', day, metric, value);
        // A month of counters is plenty to look back at.
        this.sql.exec('DELETE FROM usage WHERE day < ?', new Date(Date.parse(`${day}T00:00:00Z`) - 31 * 864e5).toISOString().slice(0, 10));
    }
}
