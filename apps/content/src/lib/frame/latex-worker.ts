/// <reference lib="webworker" />
import { Latex, RemoteTree, type Project } from '@yukibana/papers-tex-engine';
import type { FileContents } from '@yukibana/papers-frame-protocol';
import { FORMAT_FILE, FORMAT_PATH, PDFTEX_PATH, TL_FILE_PATH } from '#lib/pdftex-assets.ts';
import type { FromLatexWorker, ToLatexWorker } from './latex-messages.ts';

/** Our pdfTeX in a worker of the content frame, keeping the project's LaTeX document built: after each change, the
 *  passes go on from the last snapshot the change did not reach (packages/tex-engine), and each finished pass is sent
 *  to the frame.
 *
 *  The engine sees a TeX Live installation at `/texlive`: its file database comes with the engine, and each file is
 *  fetched from the store the first time a run reads it, with a synchronous request (the engine cannot wait otherwise),
 *  which the browser's cache answers from then on. */

declare const self: DedicatedWorkerGlobalScope;

/** Where the engine has TeX Live. */
const ROOT = '/texlive';
/** Milliseconds the engine works before the worker looks for a newer message. */
const SLICE_MS = 40;

/** To the frame. A worker's postMessage takes no target origin (the rule is for windows). */
function post(message: FromLatexWorker, transfer: Transferable[] = []): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    self.postMessage(message, transfer);
}

async function download(url: string): Promise<Uint8Array> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.slice(url.lastIndexOf('/') + 1)}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
}

async function compile(file: string): Promise<WebAssembly.Module> {
    const r = await fetch(`${PDFTEX_PATH}${file}`);
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return WebAssembly.compileStreaming(r);
}

/** The file TeX Live has at `path`, fetched now. Throws when the store does not answer with it. */
function fetchNow(path: string): Uint8Array {
    const rel = path.slice(ROOT.length + 1);
    const request = new XMLHttpRequest();
    request.open('GET', `${TL_FILE_PATH}${rel.split('/').map(encodeURIComponent).join('/')}`, false);
    request.responseType = 'arraybuffer';
    request.send();
    const body: unknown = request.response;
    if (request.status !== 200 || !(body instanceof ArrayBuffer)) throw new Error(`TeX Live's ${rel}: HTTP ${request.status}`);
    return new Uint8Array(body);
}

interface Engine {
    readonly pdftex: WebAssembly.Module;
    readonly bibtex: WebAssembly.Module;
    readonly tree: RemoteTree;
}

async function load(): Promise<Engine> {
    const [pdftex, bibtex, format, dist, variable, cnf] = await Promise.all([
        compile('pdftex.wasm'),
        compile('bibtex8.wasm'),
        download(`${PDFTEX_PATH}${FORMAT_FILE}`),
        download(`${TL_FILE_PATH}texmf-dist/ls-R`),
        download(`${TL_FILE_PATH}texmf-var/ls-R`),
        download(`${TL_FILE_PATH}texmf-dist/web2c/texmf.cnf`),
    ]);
    const tree = new RemoteTree(
        new Map([
            // Where an installation has its programs: kpathsea finds TeX Live from there.
            [`${ROOT}/bin/x86_64-linux/pdftex`, new Uint8Array(0)],
            [`${ROOT}/bin/x86_64-linux/bibtex8`, new Uint8Array(0)],
            [`${ROOT}/texmf-dist/ls-R`, dist],
            [`${ROOT}/texmf-var/ls-R`, variable],
            [`${ROOT}/texmf-dist/web2c/texmf.cnf`, cnf],
            [`${ROOT}/${FORMAT_PATH}`, format],
        ]),
        fetchNow,
    );
    return { pdftex, bibtex, tree };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The project as the frame last described it, with the bytes the engine is given for each file: a file that did not
 *  change keeps its array, which is how the engine knows at once. */
const sources = new Map<string, Uint8Array>();

let engine: Engine | null = null;
let latex: Latex | null = null;
/** The local day `latex` was made on: a document's `\today` is that day. */
let day = '';
/** The build the engine works on, and whether the frame still wants it. */
let current = 0;
let wanted = false;
let working = false;
/** A build asked for before the engine was loaded. */
let waiting: Extract<ToLatexWorker, { type: 'build' }> | null = null;

function apply(changes: readonly (readonly [string, FileContents | null])[]): void {
    for (const [path, contents] of changes) {
        if (contents === null) sources.delete(path);
        else sources.set(path, typeof contents === 'string' ? encoder.encode(contents) : contents);
    }
}

/** A turn of the event loop, so that a message that came meanwhile is handled before the engine works on. */
const channel = new MessageChannel();
function turn(): Promise<void> {
    return new Promise(resolve => {
        channel.port1.addEventListener('message', () => resolve(), { once: true });
        channel.port1.start();
        channel.port2.postMessage(null);
    });
}

async function work(): Promise<void> {
    if (working) return;
    working = true;
    try {
        for (;;) {
            const engineNow = latex;
            if (!wanted || engineNow === null || !engineNow.working) return;
            const id = current;
            let finished: boolean;
            try {
                finished = engineNow.work(performance.now() + SLICE_MS);
            } catch (e) {
                // The run is over, and nothing of it is kept: the next build starts from the snapshots before it.
                wanted = false;
                post({ type: 'failed', id, message: e instanceof Error ? e.message : String(e) });
                return;
            }
            const result = engineNow.result;
            if (finished && result !== null) {
                const pdf = result.pdf;
                post(
                    {
                        type: 'pass',
                        id,
                        ok: result.ok,
                        pdf,
                        synctex: result.synctex === null ? null : decoder.decode(result.synctex),
                        log: result.log || result.terminal,
                        pass: result.pass,
                        settled: result.settled,
                        ms: result.ms,
                    },
                    pdf === null ? [] : [pdf.buffer],
                );
            }
            // oxlint-disable-next-line no-await-in-loop -- the engine works a slice at a time, with the messages in between
            await turn();
        }
    } finally {
        working = false;
    }
}

function build(m: Extract<ToLatexWorker, { type: 'build' }>): void {
    apply(m.changes);
    if (engine === null) {
        waiting = { ...m, changes: [] };
        return;
    }
    const today = new Date().toDateString();
    if (latex === null || day !== today) {
        const now = new Date();
        latex = new Latex({
            pdftex: engine.pdftex,
            bibtex: engine.bibtex,
            tree: engine.tree,
            program: `${ROOT}/bin/x86_64-linux/pdftex`,
            format: `${ROOT}/${FORMAT_PATH}`,
            time: Math.floor(now.getTime() / 1000),
            zone: -now.getTimezoneOffset() * 60,
        });
        day = today;
    }
    current = m.id;
    wanted = true;
    const project: Project = new Map(sources);
    latex.set(project, m.root);
    void work();
}

self.addEventListener('message', (e: MessageEvent<ToLatexWorker>) => {
    if (e.data.type === 'stop') wanted = false;
    else build(e.data);
});

const t0 = performance.now();
load().then(
    loaded => {
        engine = loaded;
        post({ type: 'ready', ms: Math.round(performance.now() - t0) });
        if (waiting !== null) build(waiting);
        waiting = null;
    },
    (e: unknown) => post({ type: 'unavailable', detail: e instanceof Error ? e.message : String(e) }),
);
