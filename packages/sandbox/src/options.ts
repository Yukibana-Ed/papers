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

/** The start of `now`'s UTC day, in seconds: the build's date. Builds of one day are byte-identical, and `	oday` is
 *  today (an epoch of 0 printed January 1, 1970). */
export function buildDate(now = Date.now()): string {
    const d = new Date(now);
    return String(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** The variables every confined run gets, so TeX writes its caches into the work folder and nothing else. */
export function texEnv(workDir: string, sep: string): Record<string, string> {
    return {
        TEXMFVAR: `${workDir}${sep}.texmf-var`,
        TEXMFCONFIG: `${workDir}${sep}.texmf-var`,
        TEXMFHOME: `${workDir}${sep}texmf`,
        SOURCE_DATE_EPOCH: buildDate(),
        FORCE_SOURCE_DATE: '1',
    };
}
