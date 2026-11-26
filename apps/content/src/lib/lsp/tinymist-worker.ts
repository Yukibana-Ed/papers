/// <reference lib="webworker" />
import init, { TinymistLanguageServer } from './vendor/tinymist/tinymist.js';

/** tinymist, the Typst language server, in a worker of the content frame: its official web build driven the way its
 *  VS Code web worker drives it (editors/vscode/src/web/server.ts at v0.15.12). JSON-RPC messages come and go as plain
 *  objects over `postMessage`; the frame relays them to and from the editor.
 *
 *  The server's own requests (configuration, workspace edits) go out with its ids, and their responses come back to
 *  `on_response`. Events the server queues while handling a message are run after the reply is sent, as upstream does. */

declare const self: DedicatedWorkerGlobalScope;

interface Rpc {
    readonly jsonrpc?: '2.0';
    readonly id?: number | string;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
}

import { ASSETS } from '#lib/asset-path.ts';

const WASM = `${ASSETS}/engine/tinymist/tinymist_bg.wasm`;

/** To the frame. A worker's postMessage takes no target origin (the rule is for windows). */
function post(message: unknown): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    self.postMessage(message);
}

let server: TinymistLanguageServer | null = null;
const events: number[] = [];
const pending: Rpc[] = [];

/** Runs the events the server queued, until there are none. */
function drain(): void {
    while (events.length > 0) for (const e of events.splice(0)) server?.on_event(e);
}

function isErrorShape(x: unknown): x is { code: number; message: string } {
    return typeof x === 'object' && x !== null && 'code' in x && 'message' in x && !('result' in x);
}

async function handle(m: Rpc): Promise<void> {
    const s = server;
    if (s === null) return void pending.push(m);
    if (m.method !== undefined && m.id !== undefined) {
        let result: unknown;
        try {
            result = await Promise.resolve(s.on_request(m.method, m.params ?? null));
        } catch (e) {
            post({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } });
            drain();
            return;
        }
        // Upstream returns an error object instead of throwing; an LSP result is never shaped like one.
        if (isErrorShape(result)) post({ jsonrpc: '2.0', id: m.id, error: result });
        else post({ jsonrpc: '2.0', id: m.id, result: result ?? null });
        drain();
        return;
    }
    if (m.method !== undefined) {
        s.on_notification(m.method, m.params ?? null);
        drain();
        return;
    }
    if (m.id !== undefined) {
        s.on_response(m.error === undefined ? { id: m.id, result: m.result ?? null } : { id: m.id, error: m.error });
        drain();
    }
}

self.addEventListener('message', (e: MessageEvent<Rpc>) => void handle(e.data));

void (async () => {
    const t0 = performance.now();
    try {
        // Fetched first, so a missing file is reported with its HTTP status rather than as a WebAssembly error.
        const wasm = await fetch(WASM);
        if (!wasm.ok) throw new Error(`assets missing: ${WASM} answered HTTP ${wasm.status}`);
        await init({ module_or_path: wasm });
        server = new TinymistLanguageServer({
            sendEvent: (event: number): void => void events.push(event),
            sendRequest: (r: { id: number; method: string; params: unknown }): void => post({ jsonrpc: '2.0', id: r.id, method: r.method, params: r.params }),
            sendNotification: (n: { method: string; params: unknown }): void => post({ jsonrpc: '2.0', method: n.method, params: n.params }),
            // Typst Universe packages are not available to the language server yet: imports of @preview packages show as
            // unresolved here, while the compiler (typst.ts) resolves them for the preview.
            resolveFn: (): undefined => undefined,
        });
        post({ ready: true, ms: Math.round(performance.now() - t0), version: TinymistLanguageServer.version() });
        for (const m of pending.splice(0)) await handle(m);
    } catch (e) {
        post({ failed: e instanceof Error ? e.message : String(e) });
    }
})();
