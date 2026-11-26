/** One row of the file list: a folder, which can be closed, or a file in it. `depth` is how many folders it is in. */
export type TreeRow =
    | { readonly kind: 'folder'; readonly path: string; readonly name: string; readonly depth: number; readonly open: boolean }
    | { readonly kind: 'file'; readonly path: string; readonly name: string; readonly depth: number };

/** The folders `path` is in, outermost first: `a/b/c.tex` is in `a` and `a/b`. */
export function foldersOf(path: string): string[] {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Every folder that holds one of `paths`. */
export function allFolders(paths: readonly string[]): Set<string> {
    return new Set(paths.flatMap(foldersOf));
}

/** The rows of the file list for `paths`: each folder as a row before what it holds, and nothing of a folder in
 *  `closed` but its own row.
 *  Precondition: the files of a folder are together in `paths` (as `sortPaths` orders them).
 *  Promises: every file whose folders are all open has a row, in the order of `paths`, after the rows of its folders. */
export function treeRows(paths: readonly string[], closed: ReadonlySet<string>): TreeRow[] {
    const rows: TreeRow[] = [];
    let shown: string[] = [];
    for (const path of paths) {
        const folders = foldersOf(path);
        // The folders this file shares with the one before are already shown.
        let common = 0;
        while (common < folders.length && shown[common] === folders[common]) common++;
        const hidden = folders.slice(0, common).some(f => closed.has(f));
        let visible = !hidden;
        for (let i = common; i < folders.length && visible; i++) {
            const folder = folders[i] ?? '';
            const open = !closed.has(folder);
            rows.push({ kind: 'folder', path: folder, name: folder.split('/').at(-1) ?? folder, depth: i, open });
            visible = open;
        }
        shown = folders;
        if (visible) rows.push({ kind: 'file', path, name: path.split('/').at(-1) ?? path, depth: folders.length });
    }
    return rows;
}
