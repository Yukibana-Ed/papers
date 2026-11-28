/** Builds with our pdfTeX, the WebAssembly engine the site runs, on this computer: a build of a document goes on from
 *  where its last build was still the same, and gives the bytes a build from the start gives.
 *
 *  The engine reads the TeX Live folder and the project's files through this process and can do nothing else: it
 *  starts no program and writes no file. So these builds need no sandbox. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseLog, realFileInside, type Diagnostic } from '@yukibana/papers-compiler';
import type { ProjectDocument } from '@yukibana/papers-project';
import { Latex } from '@yukibana/papers-tex-engine';
import { DiskTree, keptFormat } from '@yukibana/papers-tex-engine/node';
import type { Toolchain } from './toolchain.ts';

/** What an incremental build made. Nothing is written: the caller puts the files where it wants them. */
export interface IncrementalBuild {
    /** A PDF was made and the log has no error. */
    readonly ok: boolean;
    readonly pdf: Uint8Array | null;
    /** The SyncTeX of `pdf`, gzipped, as `-synctex=1` writes it. */
    readonly synctex: Uint8Array | null;
    readonly log: string;
    readonly pages: number;
    /** Errors first, then warnings, then box notes; paths are project paths. */
    readonly diagnostics: readonly Diagnostic[];
    /** The programs that ran, in order: `pdflatex` once per pass, `bibtex` when BibTeX ran. */
    readonly steps: readonly string[];
    readonly ms: number;
}

/** Where the installation is in the engine's file system, and where the engine takes itself to be: among the
 *  installation's programs, so that it finds the installation's configuration as they do. */
const AT = '/texlive';
const PROGRAM = `${AT}/bin/wasm/pdftex`;
const FORMAT = '/format/pdflatex.fmt';
/** Documents kept at most. */
const KEEP = 2;

/** Whether `doc` can be built incrementally with `toolchain`: pdfLaTeX, with BibTeX or no bibliography tool, no index
 *  tool and no shell escape, on a TeX Live installation. Anything else is built by the installation's own programs. */
export function incrementalFits(doc: ProjectDocument, toolchain: Toolchain, shellEscape: boolean): boolean {
    return (
        doc.engine === 'pdflatex' &&
        doc.bibliography !== 'biber' &&
        doc.index === 'none' &&
        !(doc.shellEscape && shellEscape) &&
        existsSync(join(toolchain.root, 'texmf-dist', 'web2c', 'texmf.cnf'))
    );
}

/** The folder with the engine's modules: `PAPERS_PDFTEX` when set, else the one beside the bundled program
 *  (`../native/pdftex` from `lib/`), else the installed `@yukibana/pdftex-wasm`; null when there is none. */
export function engineFolder(): string | null {
    const named = process.env['PAPERS_PDFTEX'];
    if (named !== undefined && named !== '') return named;
    const beside = fileURLToPath(new URL('../native/pdftex', import.meta.url));
    if (existsSync(join(beside, 'pdftex.wasm'))) return beside;
    try {
        return dirname(createRequire(import.meta.url).resolve('@yukibana/pdftex-wasm/package.json'));
    } catch {
        return null;
    }
}

/** One document being built again and again. */
interface Kept {
    readonly latex: Latex;
    /** The files read so far, with what the disk said of each then. */
    readonly files: Map<string, { readonly stamp: string; readonly bytes: Uint8Array }>;
}

export class IncrementalBuilds {
    readonly #engine: string;
    readonly #cache: string;
    readonly #documents = new Map<string, Kept>();
    #modules: { readonly pdftex: WebAssembly.Module; readonly bytes: Uint8Array; readonly bibtex: WebAssembly.Module } | null = null;

    /** Builds with the engine in the folder `engine` (`pdftex.wasm` and `bibtex8.wasm`, of the `@yukibana/pdftex-wasm`
     *  package), keeping what is made once per installation (its format) under the folder `cache`. */
    constructor(engine: string, cache: string) {
        this.#engine = engine;
        this.#cache = cache;
    }

    /** Whether the engine's files are there. */
    get available(): boolean {
        return existsSync(join(this.#engine, 'pdftex.wasm')) && existsSync(join(this.#engine, 'bibtex8.wasm'));
    }

    /** Builds `doc` from the files `paths` (project paths) of the folder `dir`, until no further pass would change
     *  anything, and keeps what a later build of the same document from the same folder can go on from. `onStep` is
     *  called as each program starts.
     *
     *  Precondition: `available`, and `incrementalFits(doc, toolchain, …)`. Throws when the installation cannot make
     *  a format. A file that is a link out of `dir`, or cannot be read, is not part of the build. */
    build(dir: string, paths: readonly string[], doc: ProjectDocument, toolchain: Toolchain, onStep?: (program: string) => void): IncrementalBuild {
        const started = performance.now();
        const kept = this.#kept(dir, doc, toolchain);
        const sources = new Map<string, Uint8Array>();
        for (const path of paths) {
            const file = realFileInside(dir, join(dir, ...path.split('/')));
            if (file === null) continue;
            try {
                const s = statSync(file);
                const stamp = `${s.size} ${s.mtimeMs}`;
                let had = kept.files.get(path);
                if (had?.stamp !== stamp) {
                    // Read again; a file with the bytes it had keeps its array, which the engine's snapshots know.
                    const bytes = new Uint8Array(readFileSync(file));
                    had = { stamp, bytes: had !== undefined && Buffer.compare(had.bytes, bytes) === 0 ? had.bytes : bytes };
                    kept.files.set(path, had);
                }
                sources.set(path, had.bytes);
            } catch {
                // Gone since it was listed.
            }
        }
        for (const path of kept.files.keys()) if (!sources.has(path)) kept.files.delete(path);

        const steps: string[] = [];
        const step = (program: string): void => {
            steps.push(program);
            onStep?.(program);
        };
        const { latex } = kept;
        latex.set(sources, doc.root);
        let bibtexLog = latex.result?.bibtexLog ?? null;
        step('pdflatex');
        while (latex.working) {
            if (!latex.work(Infinity)) continue;
            const log = latex.result?.bibtexLog ?? null;
            if (log !== bibtexLog) step('bibtex');
            bibtexLog = log;
            if (latex.working) step('pdflatex');
        }
        const result = latex.result;
        if (result === null) throw new Error('the engine made nothing');

        const folder = posix.dirname(doc.root) === '.' ? '' : posix.dirname(doc.root);
        const summary = parseLog(result.log, folder === '' ? '/project' : `/project/${folder}`);
        const rank = { error: 0, warning: 1, info: 2 } as const;
        const diagnostics = summary.diagnostics
            .map(d => (d.file !== null && folder !== '' ? { ...d, file: posix.normalize(posix.join(folder, d.file)) } : d))
            .toSorted((a, b) => rank[a.severity] - rank[b.severity]);
        // The engine could not start the job: all there is to say is what it printed.
        if (result.log === '' && result.terminal !== '') diagnostics.unshift({ file: null, line: null, severity: 'error', message: result.terminal.trim().slice(-300) });
        return {
            ok: result.ok && !diagnostics.some(d => d.severity === 'error'),
            pdf: result.pdf,
            synctex: result.synctex === null ? null : gzipSync(result.synctex),
            log: result.log,
            pages: summary.pages,
            diagnostics,
            steps,
            ms: performance.now() - started,
        };
    }

    /** Forgets what was kept for the folder `dir`. */
    forget(dir: string): void {
        for (const key of this.#documents.keys()) if (key.startsWith(`${dir}\n`)) this.#documents.delete(key);
    }

    #kept(dir: string, doc: ProjectDocument, toolchain: Toolchain): Kept {
        const bibtex = doc.bibliography === 'bibtex';
        const now = new Date();
        // The day is part of what a document is told (`\\today`): a document kept overnight starts again.
        const key = `${dir}\n${doc.root}\n${toolchain.root}\n${bibtex}\n${now.toDateString()}`;
        let kept = this.#documents.get(key);
        if (kept !== undefined) {
            // Used last, dropped last.
            this.#documents.delete(key);
            this.#documents.set(key, kept);
            return kept;
        }
        this.#modules ??= (() => {
            const bytes = new Uint8Array(readFileSync(join(this.#engine, 'pdftex.wasm')));
            return { pdftex: new WebAssembly.Module(bytes), bytes, bibtex: new WebAssembly.Module(readFileSync(join(this.#engine, 'bibtex8.wasm'))) };
        })();
        const mount = { at: AT, dir: toolchain.root };
        const place = new Map([[PROGRAM, new Uint8Array(0)]]);
        const cache = join(this.#cache, createHash('sha256').update(toolchain.root).digest('hex').slice(0, 16));
        const { format } = keptFormat(this.#modules.pdftex, this.#modules.bytes, new DiskTree(place, mount), PROGRAM, Math.floor(now.getTime() / 1000), cache);
        kept = {
            latex: new Latex({
                pdftex: this.#modules.pdftex,
                bibtex: bibtex ? this.#modules.bibtex : null,
                tree: new DiskTree(new Map([...place, [FORMAT, format]]), mount),
                program: PROGRAM,
                format: FORMAT,
                time: Math.floor(now.getTime() / 1000),
                zone: -now.getTimezoneOffset() * 60,
            }),
            files: new Map(),
        };
        // Snapshots are most of what this process holds: only the documents used last are kept.
        while (this.#documents.size >= KEEP) {
            const oldest = this.#documents.keys().next();
            if (oldest.done === true) break;
            this.#documents.delete(oldest.value);
        }
        this.#documents.set(key, kept);
        return kept;
    }
}
