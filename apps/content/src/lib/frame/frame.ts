import type { AppMessage, ServiceFailure, Engine, FileContents, LanguageServer, SelectionAction, SourceLines } from '@yukibana/papers-frame-protocol';
import { syncTexMap, textMap } from '#lib/sourcemap.ts';
import { parseSynctex } from '@yukibana/papers-tex';
import { parseTexLog } from '#lib/texlog.ts';
import { Bridge } from './bridge.ts';
import { bibliographyTool, TexEngine, type BuildOutput } from './engine.ts';
import { IncrementalTex } from './incremental.ts';
import { PDFTEX_PATH } from '#lib/pdftex-assets.ts';
import { TypstEngine } from './typst-engine.ts';
import { spansMap } from '#lib/typst-spans.ts';
import { Viewer, type ToolbarAnchor } from './viewer.ts';

/** How long the frame waits after the last change before building. */
const DEBOUNCE_MS = 300;
/** The same when the build goes on from where the last one was: long enough to take a burst of changes as one. */
const INCREMENTAL_DEBOUNCE_MS = 40;

/** The selection toolbar's state, for the page to draw: where it goes, in the scroller's content coordinates. */
export type ToolbarState = ToolbarAnchor;

/** The content frame: the bridge to the app, the project's files, the engine and the viewer, wired together.
 *
 *  Builds the root after every change (debounced), keeps the last good pages when a build fails, and answers the app's
 *  navigation and overlay messages from the latest good build's SyncTeX. */
export class Frame {
    readonly #bridge: Bridge;
    readonly #viewer: Viewer;
    #engine = new TexEngine();
    /** Our pdfTeX, which keeps a pdfLaTeX document built while it is typed; `#engine` builds what it cannot. */
    #incremental = new IncrementalTex();
    /** Whether the user wants builds to go on from where the last one was: the app says so. */
    #incrementalOn = false;
    #typst = new TypstEngine();
    /** The part of the build service that last failed to start, until a build works again. */
    #failure: ServiceFailure | null = null;
    readonly #servers = new Map<LanguageServer, Worker>();
    readonly #files = new Map<string, FileContents>();
    #root: string | null = null;
    #engineName: Engine = 'pdflatex';
    #timer = 0;
    #building = false;
    #again = false;
    #started = false;
    #selection: { lines: SourceLines | null; text: string } = { lines: null, text: '' };
    #builder: 'browser' | 'external' = 'browser';
    readonly #onToolbar: (state: ToolbarState | null) => void;

    /** Precondition: `scroller` is an empty element that scrolls vertically; `appOrigin` is the app's origin. */
    constructor(scroller: HTMLElement, appOrigin: string, onToolbar: (state: ToolbarState | null) => void) {
        this.#onToolbar = onToolbar;
        this.#viewer = new Viewer(scroller, {
            scale: scale => this.#bridge.send({ type: 'scale', scale }),
            zoomed: zoom => this.#bridge.send({ type: 'zoomed', zoom }),
            jump: (at, word) => this.#bridge.send({ type: 'jump', at, word }),
            selection: (lines, text, anchor) => {
                this.#selection = { lines, text };
                this.#bridge.send({ type: 'selection', lines, text });
                this.#onToolbar(anchor === null || lines === null ? null : anchor);
            },
        });
        this.#bridge = new Bridge(
            appOrigin,
            m => this.#handle(m),
            () => {
                this.#bridge.send({ type: 'scale', scale: this.#viewer.scale });
                this.#bridge.send({ type: 'status', status: 'idle' });
            },
        );
        window.addEventListener('keydown', this.#onKey, true);
    }

    /** The toolbar's buttons: sends the action with the selection's source lines. */
    act(action: SelectionAction): void {
        const sel = this.#selection.lines === null ? this.#viewer.selectionLines() : { lines: this.#selection.lines, text: this.#selection.text };
        if (sel === null) return;
        this.#bridge.send({ type: 'action', action, lines: sel.lines, text: sel.text });
    }

    #handle(m: AppMessage): void {
        switch (m.type) {
            case 'project':
                this.#files.clear();
                for (const [path, contents] of Object.entries(m.files)) this.#files.set(path, contents);
                this.#root = m.root;
                this.#engineName = m.engine;
                this.#schedule(0);
                return;
            case 'files':
                for (const c of m.changes) {
                    if (c.contents === null) this.#files.delete(c.path);
                    else this.#files.set(c.path, c.contents);
                }
                this.#schedule(this.#incrementally() ? INCREMENTAL_DEBOUNCE_MS : DEBOUNCE_MS);
                return;
            case 'root':
                this.#root = m.root;
                this.#engineName = m.engine;
                this.#schedule(0);
                return;
            case 'reveal':
                this.#viewer.reveal(m.at, m.mode);
                return;
            case 'mirror':
                this.#viewer.setMirror(m.lines);
                return;
            case 'marks':
                this.#viewer.setMarks(m.marks);
                return;
            case 'presence':
                this.#viewer.setPresence(m.presence);
                return;
            case 'zoom':
                this.#viewer.setZoom(m.zoom);
                return;
            case 'centre?':
                this.#bridge.send({ type: 'centre', at: this.#viewer.centre() });
                return;
            case 'theme':
                document.documentElement.dataset['theme'] = m.dark ? 'dark' : 'light';
                return;
            case 'builder':
                this.#builder = m.builder;
                if (m.builder === 'browser') this.#schedule(0);
                else clearTimeout(this.#timer);
                return;
            case 'incremental':
                if (m.on === this.#incrementalOn) return;
                this.#incrementalOn = m.on;
                // What the engine held is given back at once.
                if (!m.on) this.#incremental.close();
                this.#schedule(0);
                return;
            case 'output':
                void this.#showOutput(m);
                return;
            case 'lsp-start':
                this.#startServer(m.server);
                return;
            case 'lsp':
                this.#servers.get(m.server)?.postMessage(m.message);
                return;
            case 'retry':
                // Fresh engines: whatever failed to load is fetched again.
                this.#engine = new TexEngine();
                this.#incremental.close();
                this.#incremental = new IncrementalTex();
                this.#typst = new TypstEngine();
                this.#schedule(0);
                return;
            case 'print':
                void this.#viewer.print();
                return;
            case 'download':
                this.#viewer.download(m.name);
                return;
            case 'lsp-stop':
                this.#servers.get(m.server)?.terminate();
                this.#servers.delete(m.server);
                return;
        }
    }

    /** Reports that a part of the build service could not start, with what the browser got for its files. */
    async #fail(what: ServiceFailure['what'], message: string, probe: readonly string[]): Promise<void> {
        const statuses = await Promise.all(
            probe.map(async url => {
                try {
                    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                    return r.ok ? null : `${url.split('/').pop() ?? url}: HTTP ${r.status}`;
                } catch {
                    return `${url.split('/').pop() ?? url}: unreachable`;
                }
            }),
        );
        const missing = statuses.filter((x): x is string => x !== null);
        this.#failure = { what, detail: missing.length ? missing.join(', ') : message };
        this.#bridge.send({ type: 'service', failure: this.#failure });
    }

    /** After a build that ran: the service works (again). */
    #recovered(): void {
        if (this.#failure === null) return;
        this.#failure = null;
        this.#bridge.send({ type: 'service', failure: null });
    }

    /** A build from the user's computer: shown like one of ours. Only PDFs and SyncTeX cross; the frame parses both, as
     *  for its own builds, since they come from the project's (untrusted) sources either way. */
    async #showOutput(m: Extract<AppMessage, { type: 'output' }>): Promise<void> {
        if (m.ok && m.pdf !== null) {
            this.#viewer.setSources(textSources(this.#files), 'latex');
            const sync = m.synctex === null ? null : syncTexMap(parseSynctex(await synctexText(m.synctex)));
            await this.#viewer.show(m.pdf, sync);
        }
        this.#bridge.send({ type: 'built', ok: m.ok, pages: this.#viewer.pageCount, ms: m.ms, diagnostics: m.diagnostics });
    }

    #schedule(delay: number): void {
        clearTimeout(this.#timer);
        if (this.#builder !== 'browser') return;
        this.#timer = window.setTimeout(() => void this.#build(), delay);
    }

    /** Whether the document is one our pdfTeX keeps built: pdfLaTeX, without biber, while the user wants it and the
     *  engine could be loaded. */
    #incrementally(): boolean {
        if (!this.#incrementalOn || this.#engineName !== 'pdflatex' || !this.#incremental.available) return false;
        const sources: string[] = [];
        for (const c of this.#files.values()) if (typeof c === 'string') sources.push(c);
        return bibliographyTool(sources) !== 'biber';
    }

    async #build(): Promise<void> {
        if (this.#building) {
            this.#again = true;
            // The build that runs is of a text that is gone: it gives way.
            this.#incremental.stop();
            return;
        }
        const root = this.#root;
        if (root === null || !this.#files.has(root)) return;
        this.#building = true;
        try {
            this.#bridge.send({ type: 'status', status: this.#started ? 'compiling' : 'loading' });
            this.#started = true;
            const files = new Map(this.#files);
            this.#viewer.setSources(textSources(files), this.#engineName === 'typst' ? 'typst' : 'latex');
            if (this.#engineName === 'typst') {
                await this.#buildTypst(files, root);
                return;
            }
            if (this.#incrementally()) {
                const out = await this.#incremental.build(files, root, pass => void this.#showPass(pass));
                if (out === 'superseded') return;
                if (out !== 'unavailable') {
                    if (out.failure !== undefined) await this.#fail('tex-engine', out.failure, [`${PDFTEX_PATH}pdftex.wasm`, `${PDFTEX_PATH}pdflatex.fmt`]);
                    else await this.#built(out, files, root);
                    return;
                }
            }
            const out = await this.#engine.build(files, root, this.#engineName);
            if (out.failure !== undefined) {
                await this.#fail('tex-engine', out.failure, ['/engine/busytex.js', '/engine/busytex.wasm', '/engine/texlive-basic.data']);
                return;
            }
            await this.#built(out, files, root);
        } finally {
            this.#building = false;
            this.#bridge.send({ type: 'status', status: 'idle' });
            if (this.#again) {
                this.#again = false;
                this.#schedule(0);
            }
        }
    }

    /** A pass that is not the build's last: its pages are shown, and the build's report waits for the last. */
    async #showPass(out: BuildOutput): Promise<void> {
        if (out.pdf !== null) await this.#viewer.show(out.pdf, out.synctex === null ? null : syncTexMap(parseSynctex(out.synctex)));
    }

    /** A TeX build that ran: its pages are shown when it made any, and the app is told how it went. */
    async #built(out: BuildOutput, files: ReadonlyMap<string, FileContents>, root: string): Promise<void> {
        this.#recovered();
        const diagnostics = parseTexLog(out.log, root, p => files.has(p));
        if (out.ok && out.pdf !== null) {
            await this.#viewer.show(out.pdf, out.synctex === null ? null : syncTexMap(parseSynctex(out.synctex)));
        }
        this.#bridge.send({
            type: 'built',
            ok: out.ok,
            pages: this.#viewer.pageCount,
            ms: Math.round(out.ms),
            log: out.log.slice(-256 * 1024),
            diagnostics: out.ok
                ? diagnostics
                : diagnostics.some(d => d.severity === 'error')
                  ? diagnostics
                  : [...diagnostics, { file: root, line: 1, severity: 'error', message: lastError(out.log) }],
        });
    }

    /** Starts a language server in a worker, once. Its JSON-RPC goes to the app as it comes; the worker's first message
     *  says whether it started. */
    #startServer(server: LanguageServer): void {
        if (this.#servers.has(server)) return;
        this.#bridge.send({ type: 'lsp-status', server, status: 'starting' });
        const worker = new Worker(new URL('../lsp/tinymist-worker.ts', import.meta.url), { type: 'module', name: server });
        worker.addEventListener('message', (e: MessageEvent<unknown>) => {
            const data = e.data;
            if (typeof data === 'object' && data !== null && 'ready' in data) {
                const ms = 'ms' in data ? Number(data.ms) : 0;
                return this.#bridge.send({ type: 'lsp-status', server, status: 'ready', detail: `${ms} ms` });
            }
            if (typeof data === 'object' && data !== null && 'failed' in data)
                return this.#bridge.send({ type: 'lsp-status', server, status: 'failed', detail: String(data.failed) });
            this.#bridge.send({ type: 'lsp', server, message: data });
        });
        // A worker that cannot load or throws: the server crashed, and says so instead of leaving the editor waiting.
        worker.addEventListener('error', e => this.#bridge.send({ type: 'lsp-status', server, status: 'failed', detail: `crashed: ${e.message || 'the worker failed'}` }));
        worker.addEventListener('messageerror', () => this.#bridge.send({ type: 'lsp-status', server, status: 'failed', detail: 'crashed: a message could not be read' }));
        this.#servers.set(server, worker);
    }

    /** A Typst build: typst.ts to PDF, then a source map from the PDF's text and the project's Typst sources (Typst's PDF
     *  carries no SyncTeX). */
    async #buildTypst(files: Map<string, FileContents>, root: string): Promise<void> {
        const out = await this.#typst.build(files, root);
        if (out.failure !== undefined) {
            await this.#fail('typst-compiler', out.failure, ['/engine/typst/typst_ts_web_compiler_bg.wasm']);
            return;
        }
        this.#recovered();
        if (out.ok && out.pdf !== null) {
            // To the character from the compiler's own record of each glyph's source; the text map stays for lines.
            await this.#viewer.show(out.pdf, null, out.spans === null ? null : spansMap(out.spans, textSources(files)));
            const sources = new Map<string, string>();
            for (const [path, c] of files) if (path.endsWith('.typ') && typeof c === 'string') sources.set(path, c);
            this.#viewer.setSourceMap(textMap(await this.#viewer.pageTexts(), sources));
        }
        this.#bridge.send({
            type: 'built',
            ok: out.ok,
            pages: this.#viewer.pageCount,
            ms: Math.round(out.ms),
            diagnostics: out.diagnostics,
            packages: await this.#typst.packages(),
        });
    }

    /** Keyboard shortcuts belong to the app: the frame forwards Ctrl/⌘ combinations, except copying, selecting all and
     *  the keys that move a selection's end, which act on the preview's text. */
    #onKey = (e: KeyboardEvent): void => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl) return;
        const k = e.key.toLowerCase();
        if (!e.altKey && !e.shiftKey && (k === 'c' || k === 'a')) return;
        if (k === 'control' || k === 'meta' || k === 'shift' || k === 'alt') return;
        // The arrows, Home and End move the end of the preview's selection (`Viewer`).
        if (k.startsWith('arrow') || k === 'home' || k === 'end') return;
        e.preventDefault();
        e.stopPropagation();
        this.#bridge.send({ type: 'key', key: e.key, code: e.code, ctrl, shift: e.shiftKey, alt: e.altKey });
    };

    dispose(): void {
        for (const w of this.#servers.values()) w.terminate();
        this.#incremental.close();
        window.removeEventListener('keydown', this.#onKey, true);
        this.#bridge.dispose();
        this.#viewer.dispose();
    }
}

/** SyncTeX's text from its bytes, gunzipped when they are gzip (magic 1f 8b). */
async function synctexText(bytes: Uint8Array): Promise<string> {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

/** The log's last `!` line, or a generic message when there is none (the engine failed before TeX ran). */
function lastError(log: string): string {
    const lines = log.split('\n').filter(l => l.startsWith('!'));
    return (lines.at(-1) ?? '! Build failed').slice(1).trim();
}

/** The project's text files (path → text), which the preview aligns with the document for its sync to the word. */
function textSources(files: ReadonlyMap<string, FileContents>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, c] of files) if (typeof c === 'string') out.set(path, c);
    return out;
}
