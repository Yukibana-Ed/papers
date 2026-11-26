import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { ProjectDocument } from '@yukibana/papers-project';
import { parseLog, type Diagnostic } from './log.ts';
import type { ProcessRunner, RunResult } from './runner.ts';

/** One program run of a build. */
export interface BuildStep {
    readonly program: string;
    readonly code: number | null;
    readonly ms: number;
}

export interface BuildResult {
    /** Whether a PDF was written and no step failed. A PDF with errors in the log is not `ok`. */
    readonly ok: boolean;
    /** Absolute paths, in the work folder; null when the file was not written. */
    readonly pdf: string | null;
    readonly synctex: string | null;
    readonly log: string | null;
    readonly pages: number;
    /** Errors first, then warnings, then box notes. Paths are project-relative (the root's folder is prefixed back
     *  on). */
    readonly diagnostics: readonly Diagnostic[];
    readonly steps: readonly BuildStep[];
    readonly ms: number;
}

export interface BuildOptions {
    /** The folder holding a copy of the project's files, writable: the build writes next to the root. */
    readonly workDir: string;
    readonly document: ProjectDocument;
    readonly runner: ProcessRunner;
    /** Use latexmk instead of our loop (for projects with a latexmkrc that does more than we know). */
    readonly latexmk?: boolean;
    /** At most this many engine runs. Default 5. */
    readonly maxRuns?: number;
    /** Per program. Default 120 s. */
    readonly timeoutMs?: number;
    /** Stop at the first error (TeX's -halt-on-error). Default true: a failed build fails fast. */
    readonly haltOnError?: boolean;
    /** Called as each program starts. */
    readonly onStep?: (program: string) => void;
}

/** The engine arguments every run gets. */
function engineArgs(doc: ProjectDocument, file: string, haltOnError: boolean): string[] {
    return ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', ...(haltOnError ? ['-halt-on-error'] : []), doc.shellEscape ? '-shell-escape' : '-no-shell-escape', file];
}

function hashFile(path: string): string {
    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '';
}

/** The citations and bibliography databases in an .aux (and the .aux files it includes), to tell whether BibTeX has
 *  anything to do. */
function auxNeedsBibtex(path: string): boolean {
    if (!existsSync(path)) return false;
    return /\\bibdata\{/.test(readFileSync(path, 'utf8'));
}

/** Diagnostics from a .blg of BibTeX or Biber. */
function parseBlg(text: string, bibtex: boolean): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (bibtex) {
            const w = /^Warning--(.*)$/.exec(line);
            if (w) out.push({ file: null, line: null, severity: 'warning', message: `BibTeX: ${w[1] ?? ''}` });
            const e = /^(I couldn't open .*|I found no .*|.*---line (\d+) of file (.*))$/.exec(line);
            if (e) out.push({ file: e[3] ?? null, line: e[2] ? Number(e[2]) : null, severity: 'error', message: `BibTeX: ${e[1] ?? ''}` });
        } else {
            const m = /^\[\d+\] .*?> (ERROR|WARN) - (.*)$/.exec(line);
            if (m) out.push({ file: null, line: null, severity: m[1] === 'ERROR' ? 'error' : 'warning', message: `Biber: ${m[2] ?? ''}` });
        }
    }
    return out;
}

/** Builds one document: the engine, then the bibliography and index tools when their inputs exist, then the engine
 *  again until LaTeX stops asking for a rerun and the .aux settles, at most `maxRuns` engine runs. Every program
 *  runs through `runner`, so the sandbox decides what they can touch.
 *
 *  Precondition: `workDir` holds the document's inputs at their project paths. Never throws for a failed build;
 *  throws only when the runner itself cannot start programs. */
export async function buildDocument(o: BuildOptions): Promise<BuildResult> {
    const started = performance.now();
    const doc = o.document;
    const dir = posix.dirname(doc.root) === '.' ? '' : posix.dirname(doc.root);
    const cwd = join(o.workDir, dir);
    const file = posix.basename(doc.root);
    const base = file.replace(/\.tex$/, '');
    const at = (p: string): string => join(cwd, p);
    const steps: BuildStep[] = [];
    const extra: Diagnostic[] = [];
    const timeoutMs = o.timeoutMs ?? 120_000;
    const run = async (program: string, args: string[]): Promise<RunResult> => {
        o.onStep?.(program);
        const r = await o.runner.run({ program, args, cwd, timeoutMs });
        steps.push({ program, code: r.code, ms: r.ms });
        if (r.code === null && !r.timedOut && r.stderr)
            extra.push({ file: null, line: null, severity: 'error', message: `${program} did not start: ${r.stderr.trim().slice(0, 300)}` });
        if (r.timedOut) extra.push({ file: null, line: null, severity: 'error', message: `${program} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped` });
        return r;
    };
    const relative = (d: Diagnostic): Diagnostic => (d.file !== null && dir ? { ...d, file: posix.normalize(posix.join(dir, d.file)) } : d);

    if (o.latexmk) {
        const flag = doc.engine === 'xelatex' ? '-pdfxe' : doc.engine === 'lualatex' ? '-pdflua' : '-pdf';
        const r = await run('latexmk', [flag, ...engineArgs(doc, file, o.haltOnError ?? true)]);
        return finish(r.code === 0);
    }

    let engineRuns = 0;
    let failed = false;
    const engine = async (): Promise<boolean> => {
        engineRuns++;
        const r = await run(doc.engine, engineArgs(doc, file, o.haltOnError ?? true));
        return r.code === 0;
    };

    let auxBefore = hashFile(at(`${base}.aux`));
    if (!(await engine())) failed = true;
    else {
        let tools = false;
        if (doc.bibliography === 'biber' && existsSync(at(`${base}.bcf`))) {
            const r = await run('biber', [base]);
            extra.push(...parseBlg(existsSync(at(`${base}.blg`)) ? readFileSync(at(`${base}.blg`), 'utf8') : '', false));
            tools = true;
            if (r.code !== 0) failed = true;
        } else if (doc.bibliography === 'bibtex' && auxNeedsBibtex(at(`${base}.aux`))) {
            const r = await run('bibtex', [base]);
            extra.push(...parseBlg(existsSync(at(`${base}.blg`)) ? readFileSync(at(`${base}.blg`), 'utf8') : '', true));
            tools = true;
            if (r.code !== 0 && r.code !== 1) failed = true; // BibTeX exits 1 for warnings
        }
        if (doc.index !== 'none' && existsSync(at(`${base}.idx`))) {
            const r =
                doc.index === 'xindy'
                    ? await run('texindy', [`${base}.idx`])
                    : doc.index === 'upmendex'
                      ? await run('upmendex', [`${base}.idx`])
                      : await run('makeindex', [`${base}.idx`]);
            tools = true;
            if (r.code !== 0) failed = true;
        }
        const max = o.maxRuns ?? 5;
        let again = tools;
        for (;;) {
            if (failed || engineRuns >= max) break;
            const log = existsSync(at(`${base}.log`)) ? parseLog(readFileSync(at(`${base}.log`), 'utf8'), cwd) : null;
            const aux = hashFile(at(`${base}.aux`));
            if (!again && !log?.rerun && aux === auxBefore) break;
            auxBefore = aux;
            again = false;
            if (!(await engine())) failed = true;
        }
    }
    return finish(!failed);

    function finish(succeeded: boolean): BuildResult {
        const logPath = at(`${base}.log`);
        const summary = existsSync(logPath) ? parseLog(readFileSync(logPath, 'utf8'), cwd) : null;
        const rank = { error: 0, warning: 1, info: 2 } as const;
        const diagnostics = [...(summary?.diagnostics ?? []), ...extra].map(relative).toSorted((a, b) => rank[a.severity] - rank[b.severity]);
        const pdf = existsSync(at(`${base}.pdf`)) ? at(`${base}.pdf`) : null;
        const synctex = existsSync(at(`${base}.synctex.gz`)) ? at(`${base}.synctex.gz`) : existsSync(at(`${base}.synctex`)) ? at(`${base}.synctex`) : null;
        const ok = succeeded && pdf !== null && !diagnostics.some(d => d.severity === 'error');
        return { ok, pdf, synctex, log: existsSync(logPath) ? logPath : null, pages: summary?.pages ?? 0, diagnostics, steps, ms: performance.now() - started };
    }
}
