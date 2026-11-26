import { isAbsolute, relative, resolve } from 'node:path';

/** What a confined build may touch. Everything else, the network included, is out of reach. */
export interface SandboxOptions {
    /** The TeX tree's root (the folder holding `bin/` and `texmf-dist/`): read and execute only. */
    readonly texRoot: string;
    /** Its programs, `<texRoot>/bin/<platform>`. */
    readonly texBin: string;
    /** The build's own folder (a copy of the project): the only place it can write. */
    readonly workDir: string;
    /** More read-only folders (a Python for minted, a relocatable biber). */
    readonly readOnly?: readonly string[];
    /** Default 120 s per program; the whole process tree is killed. */
    readonly timeoutMs?: number;
    /** Memory cap for the build's processes together, where the platform can enforce one. Default 2048 MB. */
    readonly memoryMb?: number;
    /** Process cap, where the platform can enforce one. Default 32. */
    readonly processes?: number;
}

/** Whether `child` is `parent` or inside it. Both are resolved first. */
export function isInside(parent: string, child: string): boolean {
    const r = relative(resolve(parent), resolve(child));
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** The error a runner gives for a working folder outside the build's own. */
export function outsideWorkDir(cwd: string): Error {
    return new Error(`the sandbox runs programs only inside its work folder, not in ${cwd}`);
}

/** The variables every confined run gets, so TeX writes its caches into the work folder and nothing else. */
export function texEnv(workDir: string, sep: string): Record<string, string> {
    return {
        TEXMFVAR: `${workDir}${sep}.texmf-var`,
        TEXMFCONFIG: `${workDir}${sep}.texmf-var`,
        TEXMFHOME: `${workDir}${sep}texmf`,
        SOURCE_DATE_EPOCH: '0',
        FORCE_SOURCE_DATE: '1',
    };
}
