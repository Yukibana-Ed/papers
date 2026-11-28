/** TeX Live as a store of files by name: what a host has that cannot hold a TeX Live installation (a browser). */
import type { DirEntry, Kind, Tree } from './files.ts';

/** A file of the store: its name as TeX Live spells it, and its bytes. */
export interface StoreFile {
    readonly name: string;
    readonly bytes: Uint8Array;
}

/** Where the files of the store are in the tree. */
const STORE = '/texlive';

/** A tree of a few files of its own (the program's place, kpathsea's configuration, the format) and, for every file
 *  kpathsea's paths do not lead to, what a store answers for the file's kpathsea format and name.
 *
 *  The configuration should give kpathsea no path into the tree, so that every TeX Live file is asked from the store:
 *  the project is searched first, as a path of `.` says. Each answer of the store is asked for once and kept, so the
 *  tree is the same for every run however the store changes meanwhile. */
export class StoreTree implements Tree {
    readonly #files: Map<string, Uint8Array>;
    readonly #dirs = new Map<string, DirEntry[]>([['/', []]]);
    readonly #fetch: (format: number, name: string) => StoreFile | null;
    readonly #found = new Map<string, string | null>();

    /** A tree of `files`, by absolute normalized path, over the store that `fetch` asks: it returns the file the store
     *  has for a kpathsea format and a name (which may lack its extension), null when the store has none, and throws
     *  when the store cannot be asked. Such an error leaves a run through the host: the run is over, and nothing is
     *  kept of the question. */
    constructor(files: ReadonlyMap<string, Uint8Array>, fetch: (format: number, name: string) => StoreFile | null) {
        this.#files = new Map(files);
        this.#fetch = fetch;
        for (const path of [...files.keys()].toSorted()) {
            const parts = path.split('/').slice(1);
            let dir = '/';
            for (const [i, name] of parts.entries()) {
                const last = i === parts.length - 1;
                const entries = this.#dirs.get(dir) ?? [];
                if (!entries.some(e => e.name === name)) entries.push({ name, kind: last ? 1 : 2 });
                if (last) break;
                dir = dir === '/' ? `/${name}` : `${dir}/${name}`;
                if (!this.#dirs.has(dir)) this.#dirs.set(dir, []);
            }
        }
    }

    /** How many questions the store was asked. */
    get asked(): number {
        return this.#found.size;
    }

    read(path: string): Uint8Array | null {
        return this.#files.get(path) ?? null;
    }

    kind(path: string): Kind {
        return this.#files.has(path) ? 1 : this.#dirs.has(path) ? 2 : 0;
    }

    list(path: string): readonly DirEntry[] {
        return this.#dirs.get(path) ?? [];
    }

    find(format: number, name: string): string | null {
        const key = `${format}/${name}`;
        let path = this.#found.get(key);
        if (path === undefined) {
            // A name with a directory is a file of the project, which the store does not have.
            const file = name.includes('/') ? null : this.#fetch(format, name);
            path = file === null ? null : `${STORE}/${format}/${file.name}`;
            if (file !== null && path !== null) this.#files.set(path, file.bytes);
            this.#found.set(key, path);
        }
        return path;
    }

    /** Gives the tree the store's answer to a question before a run asks it. An answer the tree already has stays. */
    know(format: number, name: string, file: StoreFile | null): void {
        const key = `${format}/${name}`;
        if (this.#found.has(key)) return;
        const path = file === null ? null : `${STORE}/${format}/${file.name}`;
        if (file !== null && path !== null) this.#files.set(path, file.bytes);
        this.#found.set(key, path);
    }
}
