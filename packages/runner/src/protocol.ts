/** The protocol between the web app and the local build server (`papers serve`), for "Build on this computer".
 *
 *  1. The user starts `papers serve`; it listens on 127.0.0.1 only and prints a one-time pairing code.
 *  2. The app (only from an allowed origin) sends `POST /pair` with `{ code }` and gets `{ token }`. A wrong code
 *     counts against a small limit, after which the server makes a new code. Requests from any other origin, or with
 *     a Host header other than the server's own loopback address, are refused (DNS rebinding).
 *  3. The app opens a WebSocket to `/ws` and sends `hello` with the token. Everything else goes over that socket.
 *
 *  JSON messages are text frames. Files' bytes and build outputs travel as one binary frame each, right after the
 *  text frame that announces them (`artifact`), so the two are paired by order. */

export const RUNNER_PROTOCOL = 1;

/** The default port of `papers serve`. */
export const DEFAULT_PORT = 47_115;

/** A file of the project: text, or bytes as base64 (images, fonts). */
export type FileBody = { readonly text: string } | { readonly base64: string };

export type ClientMessage =
    | { readonly type: 'hello'; readonly token: string; readonly protocol: number }
    /** The whole project: replaces every file the server holds for this connection. */
    | { readonly type: 'project'; readonly files: Readonly<Record<string, FileBody>> }
    /** Changed files; `null` removes one. */
    | { readonly type: 'files'; readonly changes: readonly { readonly path: string; readonly body: FileBody | null }[] }
    /** Build `root` (a project path). `id` comes back on every message about this build. */
    | { readonly type: 'build'; readonly id: string; readonly root: string }
    /** Starts the local language server for this connection; its messages then flow as `lsp`. */
    | { readonly type: 'lsp-start' }
    | { readonly type: 'lsp'; readonly message: unknown };

export interface RunnerDiagnostic {
    readonly file: string | null;
    readonly line: number | null;
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
}

export type ServerMessage =
    /** After a valid `hello`: what this machine builds with. */
    | { readonly type: 'ready'; readonly protocol: number; readonly sandbox: string; readonly toolchain: string }
    | { readonly type: 'status'; readonly id: string; readonly step: string }
    /** The build is done; its `artifact`s, if any, came before this. */
    | { readonly type: 'built'; readonly id: string; readonly ok: boolean; readonly pages: number; readonly ms: number; readonly diagnostics: readonly RunnerDiagnostic[] }
    /** The next frame is binary: this build's PDF or SyncTeX (gzip) bytes. */
    | { readonly type: 'artifact'; readonly id: string; readonly name: 'pdf' | 'synctex'; readonly bytes: number }
    | { readonly type: 'lsp'; readonly message: unknown }
    | { readonly type: 'error'; readonly message: string };

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isBody(x: unknown): x is FileBody {
    return isRecord(x) && (typeof x['text'] === 'string' || typeof x['base64'] === 'string');
}

/** `x` as a client message, or null for anything malformed. Paths are checked separately (`safePath`). */
export function parseClientMessage(x: unknown): ClientMessage | null {
    if (!isRecord(x) || typeof x['type'] !== 'string') return null;
    switch (x['type']) {
        case 'hello':
            return typeof x['token'] === 'string' && typeof x['protocol'] === 'number' ? { type: 'hello', token: x['token'], protocol: x['protocol'] } : null;
        case 'project': {
            const f = x['files'];
            if (!isRecord(f)) return null;
            const files: Record<string, FileBody> = {};
            for (const [path, body] of Object.entries(f)) {
                if (!isBody(body)) return null;
                files[path] = body;
            }
            return { type: 'project', files };
        }
        case 'files': {
            const c = x['changes'];
            if (!Array.isArray(c)) return null;
            const changes: { path: string; body: FileBody | null }[] = [];
            for (const e of c) {
                if (!isRecord(e) || typeof e['path'] !== 'string' || !(e['body'] === null || isBody(e['body']))) return null;
                changes.push({ path: e['path'], body: e['body'] });
            }
            return { type: 'files', changes };
        }
        case 'build':
            return typeof x['id'] === 'string' && typeof x['root'] === 'string' ? { type: 'build', id: x['id'], root: x['root'] } : null;
        case 'lsp-start':
            return { type: 'lsp-start' };
        case 'lsp':
            return { type: 'lsp', message: x['message'] };
        default:
            return null;
    }
}

/** `p` as a project path if it is one: relative, `/`-separated, no `..`, no drive, no empty or dot segments, no
 *  characters Windows cannot hold; else null. */
export function safePath(p: string): string | null {
    if (p.length === 0 || p.length > 512 || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
    const parts = p.split('/');
    if (
        parts.some(
            s => s === '' || s === '.' || s === '..' || /[<>:"|?*]/.test(s) || Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)).some(c => c < 32) || /[. ]$/.test(s),
        )
    )
        return null;
    if (parts.some(s => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s))) return null;
    return p;
}

const SERVER_TYPES: ReadonlySet<string> = new Set(['ready', 'status', 'built', 'artifact', 'lsp', 'error']);

/** Whether the value is shaped as a server message (an object with a known type), for the app's side. */
export function isServerMessage(x: unknown): x is ServerMessage {
    return isRecord(x) && typeof x['type'] === 'string' && SERVER_TYPES.has(x['type']);
}
