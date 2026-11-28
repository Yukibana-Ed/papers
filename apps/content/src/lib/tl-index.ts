/** The TeX Live store's name index, shared by the content Worker (which answers the engine's file requests) and the
 *  script that builds and uploads the store (scripts/tlstore.ts).
 *
 *  The engine asks for a file as `GET /tl/<kpathsea format>/<name>`, often without its extension (`article` for
 *  `article.cls`). The whole index of a snapshot is 50 MB, too big to load per request, so it is split into 256 shards
 *  by a hash of the requested name: the shard of a name holds the file of that exact name and every file whose name
 *  without its extension is that name, so one small read answers any request.
 *
 *  Our own pdfTeX asks for files as an installation has them, by path (`GET /tl-file/<path from TeX Live's root>`): it
 *  searches with kpathsea's own file database, `ls-R`, which the store makes for exactly the files it holds. That index
 *  is split by a hash of the path.
 *
 *  R2 layout of a snapshot `<snap>`:
 *  - `tl/<snap>/objects/<sha256[0..2]>/<sha256>`: a file's bytes, brotli-compressed (stored with Content-Encoding br);
 *  - `tl/<snap>/index/<shard>.json`: a `Shard`, `<shard>` two lowercase hex digits;
 *  - `tl/<snap>/paths/<shard>.json`: a `PathShard`, `<shard>` three lowercase hex digits. */

/** A file: its content hash, its size before compression, and its name as TeX Live spells it. */
export type IndexedFile = readonly [sha256: string, size: number, name: string];

export interface Shard {
    /** Lowercased file name → the file. */
    readonly n: Readonly<Record<string, IndexedFile>>;
    /** Lowercased name without extension → every file with that stem. */
    readonly s: Readonly<Record<string, readonly IndexedFile[]>>;
}

/** Reads a shard as the upload script wrote it. Checks the shape of the top level only: the bucket is ours, so this
 *  guards against a format change, not an attacker. Null when the text is not a shard. */
export function parseShard(text: string): Shard | null {
    const x: unknown = JSON.parse(text);
    if (typeof x !== 'object' || x === null || !('n' in x) || !('s' in x)) return null;
    const { n, s } = x;
    if (typeof n !== 'object' || n === null || typeof s !== 'object' || s === null) return null;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the entries are not checked one by one (see above)
    return { n, s } as Shard;
}

/** The shard of a requested name: FNV-1a over the lowercased name's UTF-16 code units, low 8 bits, as two hex digits. */
export function shardOf(name: string): string {
    let h = 0x811c9dc5;
    const k = name.toLowerCase();
    for (let i = 0; i < k.length; i++) {
        h ^= k.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h & 0xff).toString(16).padStart(2, '0');
}

/** The name without its last extension: `pgfmath.code.tex` → `pgfmath.code`; a name without a dot is its own stem. */
export function stemOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

function extOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot) : '';
}

/** The extensions kpathsea tries for a name without one, per format id (kpathsea's `kpse_file_format_type`). */
const EXTENSIONS: Readonly<Record<number, readonly string[]>> = {
    3: ['.tfm'],
    6: ['.bib'],
    7: ['.bst'],
    10: ['.fmt'],
    11: ['.map'],
    20: ['.ofm', '.tfm'],
    23: ['.ovf', '.vf'],
    26: ['.tex', '.sty', '.cls', '.fd', '.def', '.cfg', '.ltx', '.dtx', '.ldf', '.clo', '.bbx', '.cbx', '.lbx', '.dbx', '.rtx'],
    32: ['.pfa', '.pfb'],
    33: ['.vf'],
    35: ['.ist'],
    36: ['.ttf', '.ttc'],
    44: ['.enc'],
    47: ['.otf'],
    51: ['.lua', '.luc'],
};

/** A requested name made safe: letters, digits, `.`, `_` and `-` only. */
export function cleanName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '');
}

/** The file that answers a request for `name` in kpathsea format `format`, from the shard of `name`, as the local store
 *  server did: the exact name first, then the name with each of the format's extensions in order. Null when none. */
export function resolve(shard: Shard, format: number, name: string): IndexedFile | null {
    const k = name.toLowerCase();
    const exact = shard.n[k];
    if (exact !== undefined) return exact;
    const candidates = shard.s[k] ?? [];
    for (const ext of EXTENSIONS[format] ?? []) {
        const hit = candidates.find(f => extOf(f[2].toLowerCase()) === ext);
        if (hit !== undefined) return hit;
    }
    return null;
}

/** Builds the 256 shards from a snapshot's name → file map. Precondition: names are base names (no `/`). */
export function buildShards(files: Iterable<IndexedFile>): Map<string, { n: Record<string, IndexedFile>; s: Record<string, IndexedFile[]> }> {
    const shards = new Map<string, { n: Record<string, IndexedFile>; s: Record<string, IndexedFile[]> }>();
    const get = (key: string): { n: Record<string, IndexedFile>; s: Record<string, IndexedFile[]> } => {
        const id = shardOf(key);
        let s = shards.get(id);
        if (s === undefined) {
            s = { n: {}, s: {} };
            shards.set(id, s);
        }
        return s;
    };
    for (const f of files) {
        const k = f[2].toLowerCase();
        const byName = get(k);
        if (!(k in byName.n)) byName.n[k] = f;
        const stem = stemOf(k);
        if (stem !== k) (get(stem).s[stem] ??= []).push(f);
    }
    return shards;
}

/** Files by their path from TeX Live's root (`texmf-dist/tex/latex/base/article.cls`): content hash and size. */
export type PathShard = Readonly<Record<string, readonly [sha256: string, size: number]>>;

/** Reads a path shard as the upload script wrote it; null when the text is not one. The entries are not checked one
 *  by one: the bucket is ours. */
export function parsePathShard(text: string): PathShard | null {
    const x: unknown = JSON.parse(text);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as PathShard) : null;
}

/** The shard of a path: FNV-1a over its UTF-16 code units, low 12 bits, as three hex digits. */
export function pathShardOf(path: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) {
        h ^= path.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h & 0xfff).toString(16).padStart(3, '0');
}

/** The path shards of a snapshot's files. */
export function buildPathShards(files: Iterable<readonly [path: string, sha256: string, size: number]>): Map<string, Record<string, [string, number]>> {
    const shards = new Map<string, Record<string, [string, number]>>();
    for (const [path, sha, size] of files) {
        const id = pathShardOf(path);
        let shard = shards.get(id);
        if (shard === undefined) {
            shard = {};
            shards.set(id, shard);
        }
        shard[path] = [sha, size];
    }
    return shards;
}

/** kpathsea's file database (`ls-R`) of a tree that has exactly `files`, given by their paths from the tree's root, and
 *  the database itself: a block for every directory, with its entries in code unit order, as `mktexlsr` writes it. */
export function lsR(files: Iterable<string>): string {
    const dirs = new Map<string, Set<string>>([['', new Set(['ls-R'])]]);
    const entries = (dir: string): Set<string> => {
        let e = dirs.get(dir);
        if (e === undefined) {
            e = new Set();
            dirs.set(dir, e);
            const slash = dir.lastIndexOf('/');
            entries(slash < 0 ? '' : dir.slice(0, slash)).add(dir.slice(slash + 1));
        }
        return e;
    };
    for (const path of files) {
        const slash = path.lastIndexOf('/');
        entries(slash < 0 ? '' : path.slice(0, slash)).add(path.slice(slash + 1));
    }
    const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    let out = '% ls-R -- filename database for kpathsea; do not change this line.\n';
    for (const dir of [...dirs.keys()].toSorted(order)) out += `./${dir}:\n${[...(dirs.get(dir) ?? [])].toSorted(order).join('\n')}\n\n`;
    return out;
}
