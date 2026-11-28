/** The engine's files on a computer with TeX Live installed: for local runners, and for this package's tests. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DirEntry, Kind, Project, Tree } from './files.ts';

/** The file system of this computer as a tree, with `extra` files (by absolute path) over it. Everything read is
 *  kept, so a file that changes on disk afterwards is not seen to change. */
export class DiskTree implements Tree {
    readonly #extra: ReadonlyMap<string, Uint8Array>;
    readonly #files = new Map<string, Uint8Array | null>();
    readonly #kinds = new Map<string, Kind>();
    readonly #lists = new Map<string, readonly DirEntry[]>();

    constructor(extra: ReadonlyMap<string, Uint8Array> = new Map()) {
        this.#extra = extra;
    }

    read(path: string): Uint8Array | null {
        const extra = this.#extra.get(path);
        if (extra !== undefined) return extra;
        let data = this.#files.get(path);
        if (data === undefined) {
            try {
                data = statSync(path).isFile() ? new Uint8Array(readFileSync(path)) : null;
            } catch {
                data = null;
            }
            this.#files.set(path, data);
        }
        return data;
    }

    kind(path: string): Kind {
        if (this.read(path) !== null) return 1;
        let kind = this.#kinds.get(path);
        if (kind === undefined) {
            try {
                kind = statSync(path).isDirectory() ? 2 : 0;
            } catch {
                kind = 0;
            }
            this.#kinds.set(path, kind);
        }
        return kind;
    }

    list(path: string): readonly DirEntry[] {
        let list = this.#lists.get(path);
        if (list === undefined) {
            list = readdirSync(path, { withFileTypes: true })
                .filter(e => e.isFile() || e.isDirectory() || e.isSymbolicLink())
                .map((e): DirEntry => ({ name: e.name, kind: e.isDirectory() || (e.isSymbolicLink() && this.kind(join(path, e.name)) === 2) ? 2 : 1 }))
                .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            this.#lists.set(path, list);
        }
        return list;
    }
}

/** The files under the directory `root` as a project: every file, by its path relative to `root`. */
export function readProject(root: string): Project {
    const files = new Map<string, Uint8Array>();
    const walk = (dir: string, rel: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, e.name);
            const name = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) walk(path, name);
            else if (e.isFile()) files.set(name, new Uint8Array(readFileSync(path)));
        }
    };
    walk(root, '');
    return files;
}
