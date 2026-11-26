import type { Engine, FileContents } from '@yukibana/papers-frame-protocol';
import type { BusyTexRunner as Runner } from 'texlyre-busytex';
import { ASSETS } from '#lib/asset-path.ts';
import { COMMON_TL_FILES } from '#lib/tl-common.ts';

/** What one build produced. `pdf` and `synctex` are set iff `ok`. */
export interface BuildOutput {
    readonly ok: boolean;
    readonly pdf: Uint8Array | null;
    /** The uncompressed .synctex text. */
    readonly synctex: string | null;
    readonly log: string;
    readonly ms: number;
    /** Set when the engine itself could not start (its files did not load): not a problem with the document. */
    readonly failure?: string;
}

/** Where the engine's files and the TeX Live store are served, on this origin. */
const ENGINE_BASE = `${ASSETS}/engine`;
const TL_ENDPOINT = `${ASSETS}/tl/`;

const DRIVERS = { pdflatex: 'pdftex_bibtex8', xelatex: 'xetex_bibtex8_dvipdfmx', lualatex: 'luahbtex_bibtex8' } as const;

/** Which bibliography tool a project needs, read from its sources: biber for biblatex (unless `backend=bibtex`),
 *  BibTeX for `\bibliography{...}`, none otherwise. */
export function bibliographyTool(sources: Iterable<string>): 'biber' | 'bibtex' | null {
    let bibtex = false;
    for (const s of sources) {
        const m = /\\usepackage(\[[^\]]*\])?\{biblatex\}/.exec(s);
        if (m !== null) return /backend\s*=\s*bibtex/.test(m[1] ?? '') ? 'bibtex' : 'biber';
        if (/\\bibliography\{/.test(s)) bibtex = true;
    }
    return bibtex ? 'bibtex' : null;
}

/** Whether a second pass can change the output: cross-references, citations, a table of contents. */
export function needsRerun(sources: Iterable<string>): boolean {
    for (const s of sources) if (/\\(ref|eqref|cref|Cref|autoref|pageref|cite\w*|tableofcontents|listoffigures|listoftables|label)\b/.test(s)) return true;
    return false;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
    const copy = new Uint8Array(bytes);
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

/** The TeX engine (texlyre-busytex, loaded unmodified from `/engine`) in a worker of its own.
 *
 *  `build` runs one build at a time; a call while one runs waits for it. The runner starts on the first build, which
 *  downloads the engine (about 10 MB) and the basic TeX Live data; every other TeX Live file comes from `/tl/` when a
 *  document first asks for it. */
export class TexEngine {
    #runner: Promise<Runner> | null = null;
    #queue: Promise<unknown> = Promise.resolve();

    #start(): Promise<Runner> {
        this.#runner ??= (async (): Promise<Runner> => {
            // The TeX Live files most papers read come together while the engine loads, instead of one by one later.
            const common = fetchCommon();
            const { BusyTexRunner } = await import('texlyre-busytex');
            const runner = new BusyTexRunner({ busytexBasePath: ENGINE_BASE, preloadDataPackages: [`${ENGINE_BASE}/texlive-basic.js`] });
            await runner.initialize(true);
            await handOver(runner, await common);
            return runner;
        })();
        // A failed start is retried on the next build (and on the app's Retry).
        this.#runner.catch(() => {
            this.#runner = null;
        });
        return this.#runner;
    }

    /** Starts loading the engine without building anything. */
    warm(): void {
        void this.#start().catch(() => undefined);
    }

    /** Builds `root` from `files` with `engine`. Never throws: an engine failure is a build that is not `ok`, with the
     *  error in its log. Precondition: `files` has `root`. */
    build(files: ReadonlyMap<string, FileContents>, root: string, engine: Exclude<Engine, 'typst'>): Promise<BuildOutput> {
        const run = this.#queue.then(() => this.#build(files, root, engine));
        this.#queue = run.catch(() => undefined);
        return run;
    }

    async #build(files: ReadonlyMap<string, FileContents>, root: string, engine: Exclude<Engine, 'typst'>): Promise<BuildOutput> {
        const t0 = performance.now();
        let runner: Runner;
        try {
            runner = await this.#start();
        } catch (e) {
            const failure = e instanceof Error ? e.message : String(e);
            return { ok: false, pdf: null, synctex: null, log: `! ${failure}`, ms: performance.now() - t0, failure };
        }
        try {
            const list = [...files].map(([path, content]) => ({ path, content }));
            const sources = [...files.values()].filter((c): c is string => typeof c === 'string');
            const bib = bibliographyTool(sources);
            const result = await runner.compile(
                list,
                root,
                bib === 'bibtex',
                bib === 'biber',
                null,
                bib !== null || needsRerun(sources),
                'silent',
                DRIVERS[engine],
                null,
                new URL(TL_ENDPOINT, location.href).href,
            );
            const ok = result.success && result.pdf !== undefined;
            const synctex = ok && result.synctex !== undefined ? await gunzip(result.synctex).catch(() => null) : null;
            return { ok, pdf: ok ? (result.pdf ?? null) : null, synctex, log: result.log, ms: performance.now() - t0 };
        } catch (e) {
            return { ok: false, pdf: null, synctex: null, log: `! ${e instanceof Error ? e.message : String(e)}`, ms: performance.now() - t0 };
        }
    }
}

/** How many TeX Live requests the prefetch keeps in flight. */
const PARALLEL = 12;

interface Fetched {
    readonly files: { name: string; format: number; content: Uint8Array }[];
    readonly misses: string[];
}

/** The files of `COMMON_TL_FILES` as the store has them now: those it has with their bytes, those it does not as
 *  misses (`format/name`). Never throws; a request that fails is left out, and the engine asks for it itself. */
async function fetchCommon(): Promise<Fetched> {
    const out: Fetched = { files: [], misses: [] };
    const todo = [...COMMON_TL_FILES.hits, ...COMMON_TL_FILES.misses];
    const base = new URL(TL_ENDPOINT, location.href);
    const next = async (): Promise<void> => {
        for (let item = todo.shift(); item !== undefined; item = todo.shift()) {
            const [format, name] = item;
            try {
                const r = await fetch(new URL(`${format}/${encodeURIComponent(name)}`, base));
                if (r.ok) out.files.push({ name, format, content: new Uint8Array(await r.arrayBuffer()) });
                else if (r.status === 404) out.misses.push(`${format}/${name}`);
            } catch {
                // Left to the engine.
            }
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, next));
    return out;
}

/** Gives the engine what `fetchCommon` found, so it reads those files (and skips those misses) without asking. */
async function handOver(runner: Runner, fetched: Fetched): Promise<void> {
    try {
        if (fetched.files.length > 0) await runner.writeTexliveRemoteFiles(fetched.files.map(f => ({ name: f.name, format: f.format, content: f.content })));
        if (fetched.misses.length > 0) await runner.writeTexliveRemoteMisses(fetched.misses);
    } catch {
        // The engine asks for them itself.
    }
}
