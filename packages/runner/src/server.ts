import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { parseClientMessage, RUNNER_PROTOCOL, safePath, type FileBody, type RunnerDiagnostic, type ServerMessage } from './protocol.ts';

/** What a build of one document produced, as the server sends it back. */
export interface RunnerBuild {
    readonly ok: boolean;
    readonly pages: number;
    readonly ms: number;
    readonly diagnostics: readonly RunnerDiagnostic[];
    readonly pdf: string | null;
    readonly synctex: string | null;
}

/** Builds `root` in `workDir` (the connection's copy of the project), reporting each program as it starts. */
export type Builder = (workDir: string, root: string, onStep: (step: string) => void) => Promise<RunnerBuild>;

/** A language server for one connection: messages in, messages out. */
export interface LanguageServer {
    send(message: unknown): void;
    onMessage(listener: (message: unknown) => void): void;
    close(): void;
}

export interface RunnerOptions {
    /** Default `DEFAULT_PORT`; 0 picks a free one. */
    readonly port?: number;
    /** Origins allowed to pair and connect, e.g. `https://papers.yukibana.dev`. */
    readonly origins: readonly string[];
    /** Where connections' project copies live; each gets a folder of its own, removed when it closes. */
    readonly workRoot: string;
    readonly build: Builder;
    /** Starts a language server for a connection that asks for one, rooted at its project copy. */
    readonly languageServer?: (workDir: string, server: 'texlab' | 'tinymist') => LanguageServer;
    /** Shown in `ready`: e.g. `appcontainer`, `TeX Live 2026`. */
    readonly sandbox: string;
    readonly toolchain: string;
    /** Called with each new pairing code; the CLI prints it. */
    readonly onCode: (code: string) => void;
    /** Limits on what a connection may upload. */
    readonly maxFileBytes?: number;
    readonly maxProjectBytes?: number;
}

export interface Runner {
    readonly port: number;
    close(): Promise<void>;
}

/** A text frame's contents. */
function text(data: RawData): string {
    return (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8');
}

/** Removes a folder, retrying while a process that just ended still holds it; leaves it if it cannot. Never throws. */
function removeFolder(dir: string): void {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
        // Left for the next start of the server; it holds nothing secret beyond the user's own project.
    }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A pairing code: 8 characters a person can read out, about 40 bits. */
function newCode(): string {
    return [...randomBytes(8)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function same(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

/** Starts the local build server on 127.0.0.1. It answers only requests whose Origin is in `o.origins` and whose
 *  Host is its own loopback address; pairing hands out a bearer token for one session of the app; every connection
 *  then builds in a folder of its own through `o.build`, which decides the sandbox.
 *
 *  A wrong pairing code counts; after 5 the code is replaced (and `onCode` called), so it cannot be guessed. */
export async function startRunner(o: RunnerOptions): Promise<Runner> {
    const tokens = new Set<string>();
    let code = newCode();
    let misses = 0;
    const maxFile = o.maxFileBytes ?? 50 << 20;
    const maxProject = o.maxProjectBytes ?? 500 << 20;
    let port = 0;

    const allowedHost = (req: IncomingMessage): boolean => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    const allowedOrigin = (req: IncomingMessage): string | null => {
        const origin = req.headers.origin;
        return origin !== undefined && o.origins.includes(origin) ? origin : null;
    };
    const cors = (res: ServerResponse, origin: string): void => {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        // Chrome's Private Network Access: a public site may reach this loopback server only if it says so.
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Max-Age', '600');
    };
    const json = (res: ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };

    const http = createServer((req, res) => {
        const origin = allowedOrigin(req);
        if (!allowedHost(req) || origin === null) return json(res, 403, { error: 'forbidden' });
        cors(res, origin);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }
        if (req.method === 'GET' && req.url === '/') return json(res, 200, { name: 'yukibana-papers', protocol: RUNNER_PROTOCOL });
        if (req.method === 'POST' && req.url === '/pair') {
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (c: string) => {
                body += c;
                if (body.length > 1024) req.destroy();
            });
            req.on('end', () => {
                let given = '';
                try {
                    const parsed: unknown = JSON.parse(body);
                    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed && typeof parsed.code === 'string') given = parsed.code.trim().toUpperCase();
                } catch {
                    given = '';
                }
                if (given && same(given, code)) {
                    const token = randomBytes(32).toString('base64url');
                    tokens.add(token);
                    code = newCode(); // one use
                    misses = 0;
                    o.onCode(code);
                    return json(res, 200, { token });
                }
                if (++misses >= 5) {
                    code = newCode();
                    misses = 0;
                    o.onCode(code);
                }
                return json(res, 401, { error: 'wrong code' });
            });
            return;
        }
        return json(res, 404, { error: 'not found' });
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: maxFile * 2 });
    http.on('upgrade', (req, socket, head) => {
        if (!allowedHost(req) || allowedOrigin(req) === null || req.url !== '/ws') {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => connection(ws));
    });

    const connection = (ws: WebSocket): void => {
        let authed = false;
        const dir = join(o.workRoot, randomBytes(8).toString('hex'));
        const sizes = new Map<string, number>();
        let lsp: LanguageServer | null = null;
        let busy: Promise<unknown> = Promise.resolve();
        const send = (m: ServerMessage): void => ws.send(JSON.stringify(m));
        const fail = (message: string): void => send({ type: 'error', message });
        const write = (path: string, body: FileBody | null): boolean => {
            const p = safePath(path);
            if (p === null) {
                fail(`not a project path: ${path.slice(0, 100)}`);
                return false;
            }
            const full = join(dir, p);
            if (body === null) {
                rmSync(full, { force: true });
                sizes.delete(p);
                return true;
            }
            const bytes = 'text' in body ? Buffer.from(body.text, 'utf8') : Buffer.from(body.base64, 'base64');
            const total = [...sizes.values()].reduce((a, b) => a + b, 0) - (sizes.get(p) ?? 0) + bytes.length;
            if (bytes.length > maxFile || total > maxProject) {
                fail(`too large: ${p}`);
                return false;
            }
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, bytes);
            sizes.set(p, bytes.length);
            return true;
        };
        ws.on('message', (data, isBinary) => {
            if (isBinary) return fail('unexpected binary frame');
            let raw: unknown;
            try {
                raw = JSON.parse(text(data));
            } catch {
                return fail('not JSON');
            }
            const m = parseClientMessage(raw);
            if (!m) return fail('malformed message');
            if (!authed) {
                if (m.type !== 'hello' || ![...tokens].some(t => same(t, m.token))) {
                    ws.close(4401, 'unauthorized');
                    return;
                }
                if (m.protocol !== RUNNER_PROTOCOL) {
                    ws.close(4400, `protocol ${RUNNER_PROTOCOL} expected`);
                    return;
                }
                authed = true;
                mkdirSync(dir, { recursive: true });
                send({ type: 'ready', protocol: RUNNER_PROTOCOL, sandbox: o.sandbox, toolchain: o.toolchain });
                return;
            }
            switch (m.type) {
                case 'hello':
                    return;
                case 'project':
                    removeFolder(dir);
                    mkdirSync(dir, { recursive: true });
                    sizes.clear();
                    for (const [p, body] of Object.entries(m.files)) if (!write(p, body)) return;
                    return;
                case 'files':
                    for (const c of m.changes) if (!write(c.path, c.body)) return;
                    return;
                case 'build': {
                    const root = safePath(m.root);
                    if (root === null || !root.endsWith('.tex')) return fail(`not a document: ${m.root.slice(0, 100)}`);
                    // One build at a time per connection, in order.
                    busy = busy.then(async () => {
                        try {
                            const r = await o.build(dir, root, step => send({ type: 'status', id: m.id, step }));
                            // The outputs first, then `built`: a client can show the build as soon as it hears that it is done.
                            for (const [name, path] of [
                                ['pdf', r.pdf],
                                ['synctex', r.synctex],
                            ] as const) {
                                if (!path) continue;
                                const bytes = readFileSync(path);
                                send({ type: 'artifact', id: m.id, name, bytes: bytes.length });
                                ws.send(bytes, { binary: true });
                            }
                            send({ type: 'built', id: m.id, ok: r.ok, pages: r.pages, ms: Math.round(r.ms), diagnostics: r.diagnostics });
                        } catch (e) {
                            fail(e instanceof Error ? e.message : String(e));
                        }
                    });
                    return;
                }
                case 'lsp-start':
                    if (!o.languageServer) return fail('no language server on this machine');
                    if (!lsp) {
                        lsp = o.languageServer(dir, m.server ?? 'texlab');
                        lsp.onMessage(message => send({ type: 'lsp', message }));
                    }
                    return;
                case 'lsp':
                    if (!lsp) return fail('language server not started');
                    lsp.send(m.message);
                    return;
            }
        });
        ws.on('close', () => {
            lsp?.close();
            void busy.finally(() => setTimeout(() => removeFolder(dir), 500));
        });
    };

    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(o.port ?? 47_115, '127.0.0.1', () => resolve());
    });
    const address = http.address();
    port = typeof address === 'object' && address ? address.port : 0;
    o.onCode(code);
    return {
        port,
        close: () =>
            new Promise(resolve => {
                for (const c of wss.clients) c.terminate();
                wss.close();
                http.close(() => resolve());
            }),
    };
}
