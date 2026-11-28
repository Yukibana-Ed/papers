/** The files a run sees: a project, which changes between runs, over a tree, which does not. */

/** What a path names: nothing, a file or a directory. */
export type Kind = 0 | 1 | 2;

/** An entry of a directory. */
export interface DirEntry {
    readonly name: string;
    readonly kind: 1 | 2;
}

/** The files outside the project (TeX Live, the format): read-only, and the same for every run that shares snapshots.
 *  Paths are absolute and normalized, with `/` between components. */
export interface Tree {
    /** The bytes of the file at `path`; null when `path` is not a file. The same array for the same path. */
    read(path: string): Uint8Array | null;
    /** What `path` names. */
    kind(path: string): Kind;
    /** The entries of the directory at `path`, sorted by name. Precondition: `kind(path) === 2`. */
    list(path: string): readonly DirEntry[];
}

/** A state of the project: the bytes of each file, by its path relative to the project's root (`/` between
 *  components, no leading `/`). A project and its arrays never change; an edit is another project, which shares the
 *  arrays of the files it did not touch. */
export type Project = ReadonlyMap<string, Uint8Array>;

const listings = new WeakMap<Project, Map<string, readonly DirEntry[]>>();

/** The directories of `project` (relative paths, '' for the root) with their entries, sorted by name. */
function directories(project: Project): Map<string, readonly DirEntry[]> {
    let dirs = listings.get(project);
    if (dirs !== undefined) return dirs;
    const entries = new Map<string, Map<string, 1 | 2>>([['', new Map()]]);
    for (const path of project.keys()) {
        const parts = path.split('/');
        let dir = '';
        for (const [i, name] of parts.entries()) {
            const last = i === parts.length - 1;
            entries.get(dir)?.set(name, last ? 1 : 2);
            if (last) break;
            dir = dir === '' ? name : `${dir}/${name}`;
            if (!entries.has(dir)) entries.set(dir, new Map());
        }
    }
    dirs = new Map(
        [...entries].map(([dir, names]) => [dir, [...names].map(([name, kind]) => ({ name, kind })).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))]),
    );
    listings.set(project, dirs);
    return dirs;
}

/** What the relative path `rel` names in `project` ('' is its root). */
export function projectKind(project: Project, rel: string): Kind {
    if (project.has(rel)) return 1;
    return directories(project).has(rel) ? 2 : 0;
}

/** The entries of the directory `rel` of `project`, sorted by name; null when `rel` is not a directory of it. */
export function projectList(project: Project, rel: string): readonly DirEntry[] | null {
    return directories(project).get(rel) ?? null;
}

/** `path` made absolute against `cwd` and normalized: no `.`, `..` or empty components. Precondition: `cwd` is
 *  absolute. */
export function absolute(cwd: string, path: string): string {
    const out: string[] = [];
    for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
    }
    return `/${out.join('/')}`;
}

/** How many leading bytes `a` and `b` have in common. */
export function commonPrefix(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    // Eight bytes at a time while both arrays allow an aligned view.
    if (a.byteOffset % 8 === 0 && b.byteOffset % 8 === 0) {
        const wa = new BigUint64Array(a.buffer, a.byteOffset, n >> 3);
        const wb = new BigUint64Array(b.buffer, b.byteOffset, n >> 3);
        let w = 0;
        while (w < wa.length && wa[w] === wb[w]) w++;
        i = w * 8;
    }
    while (i < n && a[i] === b[i]) i++;
    return i;
}
