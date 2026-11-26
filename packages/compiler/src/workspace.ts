import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectFiles } from '@yukibana/papers-project';

/** Copies the project files `paths` from `projectDir` into `workDir` at the same relative paths, skipping files whose
 *  size and contents are already there. Returns the paths copied. A build then runs on the copy, so a sandbox needs
 *  write access to `workDir` only, never to the user's project. */
export function syncInto(projectDir: string, files: ProjectFiles, workDir: string, paths: readonly string[] = files.list()): string[] {
    const copied: string[] = [];
    for (const p of paths) {
        const from = join(projectDir, p);
        const to = join(workDir, p);
        if (!existsSync(from)) continue;
        if (existsSync(to) && statSync(to).size === statSync(from).size && readFileSync(to).equals(readFileSync(from))) continue;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        copied.push(p);
    }
    return copied;
}
