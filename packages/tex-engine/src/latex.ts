/** A LaTeX document kept built while its sources are edited: pdfLaTeX passes that go on from snapshots, BibTeX when
 *  the document asks for it, and passes again until nothing a pass reads has changed. */
import type { Project, Tree } from './files.ts';
import { Machine } from './memory.ts';
import { Run, type JobSettings } from './run.ts';
import { Session } from './session.ts';

export interface LatexSettings {
    /** pdfTeX and, to make bibliographies, BibTeX (bibtex8): the modules of the pdftex-wasm package, compiled. */
    readonly pdftex: WebAssembly.Module;
    readonly bibtex: WebAssembly.Module | null;
    readonly tree: Tree;
    /** The path, in `tree`, that kpathsea takes the program to be at: its configuration is looked for from there. */
    readonly program: string;
    /** The path of the LaTeX format in `tree`, made by this pdfTeX. */
    readonly format: string;
    /** The time the document is told it is, in seconds since 1970. */
    readonly time: number;
    /** Milliseconds of engine time between snapshots. Default 30. */
    readonly snapshotEvery?: number;
    /** Bytes the snapshots may hold. Default 256 MiB. */
    readonly budget?: number;
    /** Passes of pdfLaTeX at most for one state of the sources. Default 5. */
    readonly maxPasses?: number;
    readonly now?: () => number;
}

/** What the latest finished pass made. */
export interface LatexResult {
    /** The pass ended without an error and wrote a PDF. */
    readonly ok: boolean;
    readonly pdf: Uint8Array | null;
    /** The SyncTeX of `pdf`, as text. */
    readonly synctex: Uint8Array | null;
    readonly log: string;
    /** What the engine printed: all there is to go by when it could not start the job. */
    readonly terminal: string;
    /** BibTeX's log, when BibTeX ran for these sources. */
    readonly bibtexLog: string | null;
    /** Which pass of the current sources this is, from 1. */
    readonly pass: number;
    /** No further pass would change anything: this is the document. */
    readonly settled: boolean;
    /** Milliseconds of work since the sources were set. */
    readonly ms: number;
}

/** Where the project is in the engine's file system. */
const ROOT = '/project';
/** Outputs that no later pass reads. */
const FINAL = /\.(pdf|log|synctex|blg)$/;

const decoder = new TextDecoder();

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
    if (a === undefined || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export class Latex {
    readonly #settings: LatexSettings;
    readonly #now: () => number;
    #root = '';
    #session: Session | null = null;
    #sources: Project = new Map();
    /** What passes and BibTeX wrote for later passes to read (.aux, .toc, .bbl, ...), by project path. */
    #generated = new Map<string, Uint8Array>();
    /** The BibTeX run whose .bbl is in `#generated`. */
    #bibtex: Run | null = null;
    #bibtexLog: string | null = null;
    #pass = 0;
    #working = false;
    #ms = 0;
    #result: LatexResult | null = null;

    constructor(settings: LatexSettings) {
        this.#settings = settings;
        this.#now = settings.now ?? ((): number => performance.now());
    }

    /** The latest finished pass of the current or an earlier state of the sources; null before the first. */
    get result(): LatexResult | null {
        return this.#result;
    }

    /** Whether `work` has something to do. */
    get working(): boolean {
        return this.#working;
    }

    /** Bytes the snapshots hold. */
    get held(): number {
        return this.#session?.held ?? 0;
    }

    /** Sets the sources: the project's files by path, and `root`, the path of the document's main file among them.
     *  What was generated for the earlier sources is kept: the new sources mostly write the same. */
    set(sources: Project, root: string): void {
        if (root !== this.#root) {
            // Another document: another job, with nothing to go on from.
            const slash = root.lastIndexOf('/');
            const name = root.slice(slash + 1);
            const job: JobSettings = {
                tree: this.#settings.tree,
                root: ROOT,
                cwd: slash < 0 ? ROOT : `${ROOT}/${root.slice(0, slash)}`,
                args: [this.#settings.program, `-fmt=${this.#settings.format}`, '-progname=pdflatex', '-interaction=nonstopmode', '-synctex=-1', '-no-shell-escape', name],
                env: {},
                time: this.#settings.time,
            };
            this.#session = new Session({
                module: this.#settings.pdftex,
                job,
                ...(this.#settings.snapshotEvery === undefined ? {} : { snapshotEvery: this.#settings.snapshotEvery }),
                ...(this.#settings.budget === undefined ? {} : { budget: this.#settings.budget }),
                ...(this.#settings.now === undefined ? {} : { now: this.#settings.now }),
            });
            this.#root = root;
            this.#generated = new Map();
            this.#bibtex = null;
            this.#bibtexLog = null;
        }
        this.#sources = sources;
        this.#pass = 0;
        this.#ms = 0;
        this.#working = true;
        this.#session?.edit(this.#project());
    }

    /** Works until the clock passes `deadline` or nothing is left to do. Returns true when a pass finished, so that
     *  `result` is new. */
    work(deadline: number): boolean {
        const session = this.#session;
        if (session === null || !this.#working) return false;
        const t0 = this.#now();
        try {
            if (session.advance({ deadline }) !== 'done') return false;
            this.#pass++;
            const run = session.run;
            const out = run.outputs();
            const base = `${run.job.cwd}/${this.#name()}`;
            const next = this.#collect(out);
            const changedBibliography = this.#bibliography(next);
            // A pass on what is generated now would be this pass again exactly when it would be told the same things.
            const settled = !changedBibliography && run.repeats(this.#merge(next));
            this.#generated = next;
            const again = !settled && this.#pass < (this.#settings.maxPasses ?? 5);
            this.#working = again;
            const pdf = out.get(`${base}.pdf`)?.slice() ?? null;
            this.#result = {
                ok: run.exitCode === 0 && pdf !== null,
                pdf,
                synctex: out.get(`${base}.synctex`)?.slice() ?? null,
                log: decoder.decode(out.get(`${base}.log`)),
                terminal: decoder.decode(out.get('<stdout>')) + decoder.decode(out.get('<stderr>')),
                bibtexLog: this.#bibtexLog,
                pass: this.#pass,
                settled: !again,
                ms: this.#ms + (this.#now() - t0),
            };
            if (again) session.edit(this.#project());
            return true;
        } finally {
            this.#ms += this.#now() - t0;
        }
    }

    /** The main file's name without its directory and `.tex`: the name of the job. */
    #name(): string {
        return this.#root.slice(this.#root.lastIndexOf('/') + 1).replace(/\.tex$/, '');
    }

    #merge(generated: ReadonlyMap<string, Uint8Array>): Project {
        // A source wins over a generated file of the same path: a .bbl that the project brings is the bibliography.
        return new Map([...generated, ...this.#sources]);
    }

    #project(): Project {
        return this.#merge(this.#generated);
    }

    /** What a pass wrote for later passes, by project path. A file with the bytes it had keeps its array, so that a
     *  snapshot that read it still fits. */
    #collect(out: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
        const next = new Map<string, Uint8Array>();
        for (const [path, bytes] of out) {
            if (!path.startsWith(`${ROOT}/`) || FINAL.test(path)) continue;
            const rel = path.slice(ROOT.length + 1);
            const old = this.#generated.get(rel);
            next.set(rel, sameBytes(old, bytes) ? (old ?? bytes) : bytes.slice());
        }
        // The bibliography is BibTeX's, not a pass's: it stays until BibTeX runs again.
        for (const [rel, bytes] of this.#generated) if (rel.endsWith('.bbl') && !next.has(rel)) next.set(rel, bytes);
        return next;
    }

    /** Runs BibTeX when the document asks for a bibliography that the project does not bring, and what BibTeX reads has
     *  changed since it last ran; puts its .bbl into `generated`. Returns whether the .bbl changed. */
    #bibliography(generated: Map<string, Uint8Array>): boolean {
        const module = this.#settings.bibtex;
        const session = this.#session;
        if (module === null || session === null) return false;
        const dir = session.job.cwd === ROOT ? '' : `${session.job.cwd.slice(ROOT.length + 1)}/`;
        const name = this.#name();
        const aux = generated.get(`${dir}${name}.aux`);
        const bbl = `${dir}${name}.bbl`;
        if (aux === undefined || this.#sources.has(bbl) || !/\\bibdata\{/.test(decoder.decode(aux))) return false;
        const project = this.#merge(generated);
        if (this.#bibtex?.repeats(project) === true) return false;
        const job: JobSettings = {
            tree: this.#settings.tree,
            root: ROOT,
            cwd: session.job.cwd,
            args: [this.#settings.program.replace(/[^/]*$/, 'bibtex8'), name],
            env: {},
            time: this.#settings.time,
        };
        const run = new Run({ machine: new Machine(module), job, project });
        run.go();
        this.#bibtex = run;
        const out = run.outputs();
        this.#bibtexLog = decoder.decode(out.get(`${session.job.cwd}/${name}.blg`));
        const made = out.get(`${session.job.cwd}/${bbl.slice(dir.length)}`);
        if (made === undefined) return false;
        const old = generated.get(bbl);
        if (sameBytes(old, made)) return false;
        generated.set(bbl, made.slice());
        return true;
    }
}
