import { DEFAULT_PORT, RUNNER_PROTOCOL, isServerMessage, type FileBody, type RunnerDiagnostic } from '@yukibana/papers-runner/protocol';

/** One build from the user's computer. */
export interface LocalBuild {
    readonly ok: boolean;
    readonly pages: number;
    readonly ms: number;
    readonly diagnostics: readonly RunnerDiagnostic[];
    readonly pdf: Uint8Array | null;
    readonly synctex: Uint8Array | null;
}

export interface RunnerEvents {
    ready(info: { sandbox: string; toolchain: string }): void;
    status(step: string): void;
    built(b: LocalBuild): void;
    closed(reason: string): void;
}

const ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;

/** Pairs this page with `papers serve` on this computer: the code it printed buys a token for this page's lifetime
 *  (kept in memory only). Throws with a message to show when the code is wrong or nothing listens. */
export async function pair(code: string): Promise<string> {
    let r: Response;
    try {
        r = await fetch(`${ORIGIN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) });
    } catch (e) {
        throw new Error('Nothing answers: run papers serve', { cause: e });
    }
    if (r.status === 403 || r.status === 401) throw new Error('Wrong code');
    if (!r.ok) throw new Error(`papers serve answered ${r.status}`);
    const { token } = (await r.json()) as { token: string };
    return token;
}

function body(contents: string | Uint8Array): FileBody {
    if (typeof contents === 'string') return { text: contents };
    let bin = '';
    for (let i = 0; i < contents.length; i += 0x8000) bin += String.fromCharCode(...contents.subarray(i, i + 0x8000));
    return { base64: btoa(bin) };
}

/** The app's end of `papers serve`: the project's files, mirrored; builds on request; each build's PDF and SyncTeX
 *  back. Only the app talks to it (the server checks the Origin and the token); the outputs go on to the content frame,
 *  which renders them, as it renders its own.
 *
 *  Promises: `closed` is reported once, when the server stops or refuses, and never after `close`; a build asked for
 *  before the server is ready runs once it is (the last one asked for). */
export class RunnerClient {
    private readonly ws: WebSocket;
    private sent: Record<string, string | Uint8Array> = {};
    private pending: { name: 'pdf' | 'synctex'; id: string } | null = null;
    private outputs = new Map<string, { pdf: Uint8Array | null; synctex: Uint8Array | null }>();
    private seq = 0;
    private latest = '';
    private open = false;
    private ended = false;
    private queued: { files: Readonly<Record<string, string | Uint8Array>>; root: string } | null = null;

    constructor(
        token: string,
        private readonly on: RunnerEvents,
    ) {
        this.ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}/ws`);
        this.ws.binaryType = 'arraybuffer';
        this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', token, protocol: RUNNER_PROTOCOL })));
        this.ws.addEventListener('close', () => this.end('papers serve stopped'));
        this.ws.addEventListener('message', (e: MessageEvent) => this.message(e.data));
    }

    private message(data: unknown): void {
        if (this.ended) return;
        if (data instanceof ArrayBuffer) {
            const p = this.pending;
            this.pending = null;
            if (!p) return;
            const out = this.outputs.get(p.id) ?? { pdf: null, synctex: null };
            out[p.name] = new Uint8Array(data);
            this.outputs.set(p.id, out);
            return;
        }
        if (typeof data !== 'string') return;
        let m: unknown;
        try {
            m = JSON.parse(data);
        } catch {
            return;
        }
        if (!isServerMessage(m)) return;
        switch (m.type) {
            case 'ready':
                this.open = true;
                this.on.ready({ sandbox: m.sandbox, toolchain: m.toolchain });
                if (this.queued) {
                    const q = this.queued;
                    this.queued = null;
                    this.build(q.files, q.root);
                }
                break;
            case 'status':
                if (m.id === this.latest) this.on.status(m.step);
                break;
            case 'artifact':
                this.pending = { name: m.name, id: m.id };
                break;
            case 'built': {
                const out = this.outputs.get(m.id) ?? { pdf: null, synctex: null };
                this.outputs.delete(m.id);
                // An older build that finished after a newer one started is not shown.
                if (m.id === this.latest) this.on.built({ ok: m.ok, pages: m.pages, ms: m.ms, diagnostics: m.diagnostics, ...out });
                break;
            }
            case 'error':
                this.end(m.message);
                this.ws.close();
                break;
            case 'lsp':
                break;
        }
    }

    private end(reason: string): void {
        this.open = false;
        if (this.ended) return;
        this.ended = true;
        this.on.closed(reason);
    }

    /** Sends what changed in `files` since the last call (everything the first time), then builds `root`; before the
     *  server is ready, remembers it for then. Does nothing once closed. */
    build(files: Readonly<Record<string, string | Uint8Array>>, root: string): void {
        if (this.ended) return;
        if (!this.open) {
            this.queued = { files, root };
            return;
        }
        const first = Object.keys(this.sent).length === 0;
        if (first) this.ws.send(JSON.stringify({ type: 'project', files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, body(c)])) }));
        else {
            const changes: { path: string; body: FileBody | null }[] = [];
            for (const [p, c] of Object.entries(files)) if (this.sent[p] !== c) changes.push({ path: p, body: body(c) });
            for (const p of Object.keys(this.sent)) if (!(p in files)) changes.push({ path: p, body: null });
            if (changes.length) this.ws.send(JSON.stringify({ type: 'files', changes }));
        }
        this.sent = { ...files };
        this.latest = `b${++this.seq}`;
        this.ws.send(JSON.stringify({ type: 'build', id: this.latest, root }));
    }

    /** Disconnects; no event is reported after it. */
    close(): void {
        this.ended = true;
        this.open = false;
        this.queued = null;
        this.ws.close();
    }
}
