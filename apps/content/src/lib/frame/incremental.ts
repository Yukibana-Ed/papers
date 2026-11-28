import type { FileContents } from '@yukibana/papers-frame-protocol';
import type { BuildOutput } from './engine.ts';
import type { FromLatexWorker, ToLatexWorker } from './latex-messages.ts';

/** How a build that gave no output ended: a newer build took its place, or the engine cannot run here (its files are
 *  not there), and the caller builds another way. */
export type NoBuild = 'superseded' | 'unavailable';

interface Pending {
    readonly id: number;
    readonly t0: number;
    readonly shown: (out: BuildOutput) => void;
    readonly resolve: (out: BuildOutput | NoBuild) => void;
}

/** The LaTeX document kept built by our pdfTeX, in a worker of its own (latex-worker.ts): a build after a change goes
 *  on from where the last one was still the same, and gives the same PDF as a build from nothing.
 *
 *  pdfLaTeX with BibTeX only. The worker starts with the first build, which downloads the engine (about 1 MB), the
 *  format and TeX Live's file database. */
export class IncrementalTex {
    #worker: Worker | null = null;
    #unavailable = false;
    #crashes = 0;
    /** What the worker was told the project is. */
    #sent = new Map<string, FileContents>();
    #id = 0;
    #pending: Pending | null = null;

    /** False once the engine could not be loaded: builds answer `unavailable`. */
    get available(): boolean {
        return !this.#unavailable;
    }

    #start(): Worker {
        if (this.#worker !== null) return this.#worker;
        const worker = new Worker(new URL('./latex-worker.ts', import.meta.url), { type: 'module', name: 'latex' });
        worker.addEventListener('message', (e: MessageEvent<FromLatexWorker>) => this.#receive(e.data));
        // A worker that cannot load or breaks: the next build starts another, twice at most.
        worker.addEventListener('error', e => {
            worker.terminate();
            this.#worker = null;
            this.#sent = new Map();
            if (++this.#crashes >= 2) this.#unavailable = true;
            this.#end({ ok: false, pdf: null, synctex: null, log: `! ${e.message || 'the engine stopped'}`, ms: 0, failure: e.message || 'the engine stopped' });
        });
        this.#worker = worker;
        return worker;
    }

    #send(m: ToLatexWorker): void {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker, not a window
        this.#start().postMessage(m);
    }

    #end(out: BuildOutput | NoBuild): void {
        const pending = this.#pending;
        this.#pending = null;
        pending?.resolve(typeof out === 'string' ? out : { ...out, ms: performance.now() - pending.t0 });
    }

    #receive(m: FromLatexWorker): void {
        if (m.type === 'ready') return;
        if (m.type === 'unavailable') {
            this.#unavailable = true;
            this.#worker?.terminate();
            this.#worker = null;
            return this.#end('unavailable');
        }
        const pending = this.#pending;
        if (pending === null || m.id !== pending.id) return;
        if (m.type === 'failed') return this.#end({ ok: false, pdf: null, synctex: null, log: `! ${m.message}`, ms: 0, failure: m.message });
        this.#crashes = 0;
        const ok = m.ok && m.pdf !== null;
        const out: BuildOutput = { ok, pdf: ok ? m.pdf : null, synctex: ok ? m.synctex : null, log: m.log, ms: performance.now() - pending.t0 };
        if (m.settled) this.#end(out);
        else if (ok) pending.shown(out);
    }

    /** Starts loading the engine without building anything. */
    warm(): void {
        if (!this.#unavailable) this.#start();
    }

    /** Builds `root` from `files`. Resolves with the build when no further pass would change it; `shown` is given each
     *  earlier pass that made a PDF (references may still be open in it). A build asked for while another runs takes
     *  its place, and the earlier one resolves `superseded`. Never rejects: a failure of the engine itself is a build
     *  that is not `ok`, with `failure` set. Precondition: `files` has `root`, and is not changed in place. */
    build(files: ReadonlyMap<string, FileContents>, root: string, shown: (out: BuildOutput) => void): Promise<BuildOutput | NoBuild> {
        this.#end('superseded');
        if (this.#unavailable) return Promise.resolve('unavailable');
        // Only what changed crosses to the worker: figures stay where they are while the text is typed.
        const changes: [string, FileContents | null][] = [];
        for (const [path, contents] of files) if (this.#sent.get(path) !== contents) changes.push([path, contents]);
        for (const path of this.#sent.keys()) if (!files.has(path)) changes.push([path, null]);
        const id = ++this.#id;
        return new Promise(resolve => {
            this.#pending = { id, t0: performance.now(), shown, resolve };
            this.#send({ type: 'build', id, changes, root });
            this.#sent = new Map(files);
        });
    }

    /** Ends the running build, which resolves `superseded`: the caller is about to ask for another. */
    stop(): void {
        if (this.#pending === null) return;
        this.#send({ type: 'stop' });
        this.#end('superseded');
    }

    /** Ends the worker and what it holds. A later build starts another. */
    close(): void {
        this.#worker?.terminate();
        this.#worker = null;
        this.#sent = new Map();
        this.#end('superseded');
    }
}
