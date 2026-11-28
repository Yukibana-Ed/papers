/** A TeX Live installation that is somewhere else: what a host has that cannot hold one (a browser). */
import type { DirEntry, Kind, Tree } from './files.ts';

const decoder = new TextDecoder();

/** Where an `ls-R` file lists the entries of a directory: the bytes `from` to `to` of `lsr`, a name a line. */
interface Block {
    readonly lsr: Uint8Array;
    readonly from: number;
    readonly to: number;
}

/** The directories an `ls-R` file lists, by path, with `root` the directory the file lies in, as kpathsea reads it: a
 *  line that ends in `:` names a directory (`./tex/latex:`); the lines after it, up to the next such line, name its
 *  entries. The entries are not read here: an installation has some 200,000, and a run asks for few of them. */
function blocks(root: string, lsr: Uint8Array): Map<string, Block> {
    const dirs = new Map<string, Block>();
    let dir: string | null = null;
    let from = 0;
    for (let at = 0; at < lsr.length;) {
        let end = lsr.indexOf(10, at);
        if (end < 0) end = lsr.length;
        // `./…:` or `/…:`
        if (end > at && lsr[end - 1] === 58 && (lsr[at] === 47 || (lsr[at] === 46 && lsr[at + 1] === 47))) {
            if (dir !== null) dirs.set(dir, { lsr, from, to: at });
            const rel = decoder.decode(lsr.subarray(lsr[at] === 46 ? at + 2 : at, end - 1)).replace(/\/+$/, '');
            dir = rel === '' ? root : `${root}/${rel}`;
            from = end + 1;
        }
        at = end + 1;
    }
    if (dir !== null) dirs.set(dir, { lsr, from, to: lsr.length });
    return dirs;
}

/** A tree of files it is given, and of TeX Live trees that it knows by their `ls-R` and whose files it fetches when a
 *  run first reads them.
 *
 *  A remote tree has exactly the files and directories its `ls-R` lists, so kpathsea, which searches such a tree by
 *  that file alone, finds in it what it would find in the installation. Each file is fetched once and kept: the tree is
 *  the same for every run. */
export class RemoteTree implements Tree {
    readonly #files: Map<string, Uint8Array>;
    /** The directories the `ls-R` files list. */
    readonly #blocks = new Map<string, Block>();
    /** The entries of each directory that was asked for or holds a given file, by its path. */
    readonly #dirs = new Map<string, Map<string, 1 | 2>>();
    readonly #fetch: (path: string) => Uint8Array;
    readonly #fetched = new Set<string>();

    /** A tree of `files`, by absolute normalized path. Each file among them that is named `ls-R` makes the directory it
     *  lies in a remote tree: a file it lists, when first read, is what `fetch` returns for its path. `fetch` throws
     *  when it cannot get the file; such an error leaves a run through the host, and the run is over.
     *  Precondition: in every `ls-R`, an entry is a directory exactly when the file has a block for it. */
    constructor(files: ReadonlyMap<string, Uint8Array>, fetch: (path: string) => Uint8Array) {
        this.#files = new Map(files);
        this.#fetch = fetch;
        for (const [path, bytes] of files) {
            if (!path.endsWith('/ls-R')) continue;
            const root = path.slice(0, -'/ls-R'.length);
            for (const [dir, block] of blocks(root, bytes)) this.#blocks.set(dir, block);
            this.#enter(root, 2);
        }
        for (const path of files.keys()) this.#enter(path, 1);
    }

    /** The entries of the directory `path`; null when `path` is not a directory. */
    #entries(path: string): Map<string, 1 | 2> | null {
        let entries = this.#dirs.get(path);
        if (entries !== undefined) return entries;
        const block = this.#blocks.get(path);
        if (block === undefined) return null;
        entries = new Map();
        for (const name of decoder.decode(block.lsr.subarray(block.from, block.to)).split('\n')) {
            if (name !== '' && name !== '.' && name !== '..') entries.set(name, this.#blocks.has(`${path}/${name}`) ? 2 : 1);
        }
        this.#dirs.set(path, entries);
        return entries;
    }

    /** Enters `path`, which is given, in its directory, and that directory in the one above it. */
    #enter(path: string, kind: 1 | 2): void {
        const slash = path.lastIndexOf('/');
        const dir = slash === 0 ? '/' : path.slice(0, slash);
        let entries = this.#entries(dir);
        if (entries === null) {
            entries = new Map();
            this.#dirs.set(dir, entries);
            if (dir !== '/') this.#enter(dir, 2);
        }
        entries.set(path.slice(slash + 1), kind);
    }

    #kind(path: string): Kind {
        if (path === '/') return 2;
        const slash = path.lastIndexOf('/');
        return this.#entries(slash === 0 ? '/' : path.slice(0, slash))?.get(path.slice(slash + 1)) ?? 0;
    }

    /** The remote files that were fetched or given so far, by path: what another tree of the same installation may be
     *  given ahead of its first run. */
    get fetched(): ReadonlySet<string> {
        return this.#fetched;
    }

    /** Whether `path` is a remote file that the tree does not have yet. */
    wants(path: string): boolean {
        return !this.#files.has(path) && this.#kind(path) === 1;
    }

    /** Gives the tree the remote file at `path` before a run reads it. Precondition: `wants(path)`. */
    give(path: string, bytes: Uint8Array): void {
        this.#files.set(path, bytes);
        this.#fetched.add(path);
    }

    read(path: string): Uint8Array | null {
        let bytes = this.#files.get(path);
        if (bytes === undefined) {
            if (this.#kind(path) !== 1) return null;
            bytes = this.#fetch(path);
            this.give(path, bytes);
        }
        return bytes;
    }

    kind(path: string): Kind {
        return this.#kind(path);
    }

    list(path: string): readonly DirEntry[] {
        return [...(this.#entries(path) ?? [])].map(([name, kind]) => ({ name, kind })).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
}
