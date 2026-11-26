import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { buildDocument, syncInto, type BuildResult } from '@yukibana/papers-compiler';
import type { ProjectDocument, ProjectFiles } from '@yukibana/papers-project';
import { cacheDir, sandboxRunner, type SandboxChoice } from '@yukibana/papers-sandbox';
import type { Toolchain } from './toolchain.ts';

/** The build folder of a project: a copy in the cache, one per project folder, kept between builds so reruns and
 *  TeX's caches stay warm. */
export function workDirOf(projectDir: string): string {
    return join(cacheDir(), 'builds', createHash('sha256').update(resolve(projectDir).toLowerCase()).digest('hex').slice(0, 16));
}

export interface LocalBuild {
    readonly result: BuildResult;
    readonly workDir: string;
    /** Where the PDF was copied to in the project, if one was written. */
    readonly output: string | null;
}

/** Builds `doc` of the project in `projectDir`: copies its files into the project's build folder, builds there with
 *  `toolchain` under `sandbox`, and copies the PDF (and SyncTeX) into `<project>/.papers/out/`. The build never
 *  writes into the project otherwise. */
export async function buildLocal(
    projectDir: string,
    files: ProjectFiles,
    doc: ProjectDocument,
    toolchain: Toolchain,
    sandbox: SandboxChoice,
    onStep?: (program: string) => void,
): Promise<LocalBuild> {
    const workDir = workDirOf(projectDir);
    mkdirSync(workDir, { recursive: true });
    syncInto(projectDir, files, workDir);
    const runner = await sandboxRunner(sandbox, { texRoot: toolchain.root, texBin: toolchain.bin, workDir });
    const result = await buildDocument({ workDir, document: doc, runner, ...(onStep ? { onStep } : {}) });
    let output: string | null = null;
    if (result.pdf) {
        const out = join(projectDir, '.papers', 'out');
        mkdirSync(out, { recursive: true });
        output = join(out, basename(result.pdf));
        copyFileSync(result.pdf, output);
        if (result.synctex) copyFileSync(result.synctex, join(out, basename(result.synctex)));
    }
    return { result, workDir, output };
}
