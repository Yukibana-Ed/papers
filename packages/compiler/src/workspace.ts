import { copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectFiles } from '@yukibana/papers-project';
import { prepareWrite } from './safe-fs.ts';

/** Copies the project files `paths` from `projectDir` into `workDir` at the same relative paths, skipping files whose
 *  size and contents are already there. Returns the paths copied. A build then runs on the copy, so a sandbox needs
 *  write access to `workDir` only, never to the user's project.
 *
 *  `workDir` is the build's: a link a build left there (to a file or a folder outside) is removed, never followed, so
 *  copying cannot write outside `workDir`. */
export function syncInto(projectDir: string, files: ProjectFiles, workDir: string, paths: readonly string[] = files.list()): string[] {
    const copied: string[] = [];
    for (const p of paths) {
        const from = join(projectDir, p);
        const to = join(workDir, p);
        if (!existsSync(from)) continue;
        prepareWrite(workDir, to);
        const same = (() => {
            try {
                const st = lstatSync(to);
                return st.isFile() && st.size === lstatSync(from).size && readFileSync(to).equals(readFileSync(from));
            } catch {
                return false;
            }
        })();
        if (same) continue;
        copyFileSync(from, to);
        copied.push(p);
    }
    return copied;
}
