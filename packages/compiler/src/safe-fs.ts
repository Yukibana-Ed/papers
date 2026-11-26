import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** File-system operations on a build's work folder that never follow a link a build left there.
 *
 *  A sandboxed build can write anywhere in its work folder, including symbolic links and (on Windows) junctions that
 *  point outside it. Everything that runs outside the sandbox — copying the project in, reading the PDF and the logs
 *  out — must therefore treat the work folder as hostile: links are removed, never followed. */

function lstatOrNull(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch {
        return null;
    }
}

/** Removes the link at `path` (a symbolic link to a file or folder, or a junction), without touching its target. */
function removeLink(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // A link to a folder on Windows (and a junction) is removed as a folder; `rmSync` without `recursive` never
        // descends into a target.
        rmSync(path, { force: true });
    }
}

/** Whether `path` is `root` or inside it, lexically. Precondition: both absolute. */
function lexicallyInside(root: string, path: string): boolean {
    const r = relative(root, path);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Makes sure every folder from `root` down to `dir` is a real folder: a link on the way is removed and replaced by a
 *  folder. Precondition: `dir` is inside `root`; throws otherwise. */
export function realFolders(root: string, dir: string): void {
    const absRoot = resolve(root);
    const abs = resolve(dir);
    if (!lexicallyInside(absRoot, abs)) throw new Error(`${dir} is outside ${root}`);
    let at = absRoot;
    for (const part of relative(absRoot, abs).split(sep).filter(Boolean)) {
        at = join(at, part);
        const st = lstatOrNull(at);
        if (st?.isSymbolicLink()) removeLink(at);
        else if (st && !st.isDirectory()) rmSync(at, { force: true });
        if (!st?.isDirectory() || st.isSymbolicLink()) mkdirSync(at);
    }
}

/** Prepares `file` under `root` for writing: its folders are real folders and `file` itself is not a link (a link
 *  there is removed). Writing to `file` afterwards cannot land outside `root`. Precondition: `file` is inside `root`. */
export function prepareWrite(root: string, file: string): void {
    realFolders(root, dirname(resolve(file)));
    if (lstatOrNull(file)?.isSymbolicLink()) removeLink(file);
}

/** Removes every link (symbolic link or junction) anywhere under `root`, never descending into one. Returns the
 *  removed paths, relative to `root`. Run after every program a build runs. */
export function sweepLinks(root: string): string[] {
    const removed: string[] = [];
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = join(dir, e.name);
            if (e.isSymbolicLink()) {
                removeLink(p);
                removed.push(relative(root, p));
            } else if (e.isDirectory()) walk(p);
        }
    };
    walk(resolve(root));
    return removed;
}

/** `path` if it is a regular file whose real location is inside `root`, else null: a build's output is read only
 *  through this, so a link the build made cannot point the reader at another file. */
export function realFileInside(root: string, path: string): string | null {
    const st = lstatOrNull(path);
    if (!st?.isFile()) return null;
    try {
        const real = realpathSync(path);
        const realRoot = realpathSync(root);
        return lexicallyInside(realRoot, real) ? real : null;
    } catch {
        return null;
    }
}
