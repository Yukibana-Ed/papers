/** The engine's files on a computer with TeX Live installed: for local runners, and for this package's tests. */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DirEntry, Kind, Project, Tree } from './files.ts';
import { dumpFormat } from './latex.ts';

/** A directory of this computer, at a path of the engine's file system. */
export interface Mount {
    /** The engine's path: absolute and normalized, not `/`. */
    readonly at: string;
    /** The directory on this computer, in this computer's notation. */
    readonly dir: string;
}

/** Files of this computer as a tree, with `extra` files (by absolute path) over them: the directory of `mount` at
 *  its path and nothing else of the disk, or without a mount the whole file system at its own paths (which needs
 *  paths with `/`: not Windows). Everything read is kept, so a file that changes on disk afterwards is not seen to
 *  change. */
export class DiskTree implements Tree {
    readonly #extra: ReadonlyMap<string, Uint8Array>;
    readonly #mount: Mount | null;
    readonly #files = new Map<string, Uint8Array | null>();
    readonly #kinds = new Map<string, Kind>();
    readonly #lists = new Map<string, readonly DirEntry[]>();
    /** The directories that hold an extra file or a directory of one, with those entries. */
    readonly #extraDirs = new Map<string, Map<string, 1 | 2>>();

    constructor(extra: ReadonlyMap<string, Uint8Array> = new Map(), mount: Mount | null = null) {
        this.#extra = extra;
        this.#mount = mount;
        // The directories on the way to an extra file are there too, whatever the disk has.
        for (const path of extra.keys()) {
            let name = path;
            for (let slash = name.lastIndexOf('/'); slash >= 0; slash = name.lastIndexOf('/')) {
                const dir = name.slice(0, slash) || '/';
                let entries = this.#extraDirs.get(dir);
                if (entries === undefined) {
                    entries = new Map<string, 1 | 2>();
                    this.#extraDirs.set(dir, entries);
                }
                entries.set(name.slice(slash + 1), name === path ? 1 : 2);
                if (dir === '/') break;
                name = dir;
            }
        }
    }

    /** Where `path` is on this computer; null when it is not on it. */
    #disk(path: string): string | null {
        const mount = this.#mount;
        if (mount === null) return path;
        if (path === mount.at) return mount.dir;
        return path.startsWith(`${mount.at}/`) ? join(mount.dir, ...path.slice(mount.at.length + 1).split('/')) : null;
    }

    /** Whether `path` is a directory only because the mount is under it. */
    #above(path: string): boolean {
        return this.#mount !== null && this.#mount.at.startsWith(path === '/' ? '/' : `${path}/`);
    }

    /** What the disk says of `path` now, whatever was read before: its kind and, of a file, its size and the time it
     *  was last written. Equal stamps are taken to mean equal contents. */
    stamp(path: string): string {
        const disk = this.#disk(path);
        if (disk === null) return this.#above(path) ? '2' : '0';
        try {
            const s = statSync(disk);
            return s.isFile() ? `1 ${s.size} ${s.mtimeMs}` : s.isDirectory() ? '2' : '0';
        } catch {
            return '0';
        }
    }

    read(path: string): Uint8Array | null {
        const extra = this.#extra.get(path);
        if (extra !== undefined) return extra;
        let data = this.#files.get(path);
        if (data === undefined) {
            const disk = this.#disk(path);
            try {
                data = disk !== null && statSync(disk).isFile() ? new Uint8Array(readFileSync(disk)) : null;
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
            const disk = this.#disk(path);
            try {
                kind = disk === null ? (this.#above(path) ? 2 : 0) : statSync(disk).isDirectory() ? 2 : 0;
            } catch {
                kind = 0;
            }
            if (this.#extraDirs.has(path)) kind = 2;
            this.#kinds.set(path, kind);
        }
        return kind;
    }

    list(path: string): readonly DirEntry[] {
        let list = this.#lists.get(path);
        if (list === undefined) {
            const disk = this.#disk(path);
            const entries = new Map<string, 1 | 2>();
            if (disk === null) {
                // A directory above the mount holds the way to it.
                if (this.#mount !== null && this.#above(path)) entries.set(this.#mount.at.slice(path === '/' ? 1 : path.length + 1).split('/')[0] ?? '', 2);
            } else {
                try {
                    for (const e of readdirSync(disk, { withFileTypes: true })) {
                        if (e.isDirectory() || (e.isSymbolicLink() && this.kind(`${path === '/' ? '' : path}/${e.name}`) === 2)) entries.set(e.name, 2);
                        else if (e.isFile() || e.isSymbolicLink()) entries.set(e.name, 1);
                    }
                } catch {
                    // Not a directory of the disk: it has the extra entries only.
                }
            }
            for (const [name, kind] of this.#extraDirs.get(path) ?? []) entries.set(name, kind);
            list = [...entries].map(([name, kind]): DirEntry => ({ name, kind })).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            this.#lists.set(path, list);
        }
        return list;
    }
}

/** A tree that notes every path it is asked about. */
class Asked implements Tree {
    readonly paths = new Set<string>();
    readonly #tree: Tree;

    constructor(tree: Tree) {
        this.#tree = tree;
    }

    read(path: string): Uint8Array | null {
        this.paths.add(path);
        return this.#tree.read(path);
    }

    kind(path: string): Kind {
        this.paths.add(path);
        return this.#tree.kind(path);
    }

    list(path: string): readonly DirEntry[] {
        this.paths.add(path);
        return this.#tree.list(path);
    }
}

/** What is kept beside a format: what made it. */
interface FormatRecord {
    readonly engine: string;
    readonly program: string;
    readonly time: number;
    /** Every path the dump asked about, with its stamp then. */
    readonly asked: readonly (readonly [path: string, stamp: string])[];
}

function isFormatRecord(x: unknown): x is FormatRecord {
    if (typeof x !== 'object' || x === null) return false;
    const r = x as Partial<Record<keyof FormatRecord, unknown>>;
    return (
        typeof r.engine === 'string' &&
        typeof r.program === 'string' &&
        typeof r.time === 'number' &&
        Array.isArray(r.asked) &&
        r.asked.every((e: unknown) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string')
    );
}

/** The pdfLaTeX format of the installation in `tree` for the engine `pdftex` (the module of the bytes `engine`), and
 *  the time it was dumped at: the one kept in the directory `cache` when this engine dumped it from files that are
 *  on disk as they were then (a format is only good for its engine and its installation), else one dumped now, at
 *  `time`, and kept there. `program` is as for `dumpFormat`, which says what is thrown. */
export function keptFormat(pdftex: WebAssembly.Module, engine: Uint8Array, tree: DiskTree, program: string, time: number, cache: string): { format: Uint8Array; time: number } {
    const id = createHash('sha256').update(engine).digest('hex');
    const file = join(cache, 'pdflatex.fmt');
    const note = join(cache, 'pdflatex.fmt.json');
    try {
        const record: unknown = JSON.parse(readFileSync(note, 'utf8'));
        if (isFormatRecord(record) && record.engine === id && record.program === program && record.asked.every(([path, stamp]) => tree.stamp(path) === stamp))
            return { format: new Uint8Array(readFileSync(file)), time: record.time };
    } catch {
        // Nothing kept, or not whole: made again.
    }
    const asked = new Asked(tree);
    const format = dumpFormat(pdftex, asked, program, time);
    const record: FormatRecord = { engine: id, program, time, asked: [...asked.paths].map(path => [path, tree.stamp(path)] as const) };
    mkdirSync(cache, { recursive: true });
    // The old note goes first and the new one comes last: a format is never used with a note that is not its own.
    rmSync(note, { force: true });
    writeFileSync(file, format);
    writeFileSync(note, JSON.stringify(record));
    return { format, time };
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
