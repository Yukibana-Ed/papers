import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Splits a byte stream into LSP messages (`Content-Length` framing) and frames messages for writing. */
export class LspFraming {
    private buffer = Buffer.alloc(0);

    /** Adds bytes; returns the complete messages they finish, parsed. Malformed JSON is skipped. */
    push(chunk: Buffer): unknown[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const out: unknown[] = [];
        for (;;) {
            const end = this.buffer.indexOf('\r\n\r\n');
            if (end < 0) break;
            const header = this.buffer.subarray(0, end).toString('ascii');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) {
                this.buffer = this.buffer.subarray(end + 4);
                continue;
            }
            const length = Number(m[1]);
            if (this.buffer.length < end + 4 + length) break;
            const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
            this.buffer = this.buffer.subarray(end + 4 + length);
            try {
                out.push(JSON.parse(body));
            } catch {
                // A message the server could not have meant; skip it.
            }
        }
        return out;
    }

    static frame(message: unknown): Buffer {
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
    }
}

/** `value` with every string that starts with `from` starting with `to` instead, at any depth. */
export function rewriteUris(value: unknown, from: string, to: string): unknown {
    if (typeof value === 'string') return value.startsWith(from) ? to + value.slice(from.length) : value;
    if (Array.isArray(value)) return value.map(v => rewriteUris(v, from, to));
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = rewriteUris(v, from, to);
        return out;
    }
    return value;
}

/** A language server process for one project copy. */
export interface LanguageServerProcess {
    send(message: unknown): void;
    onMessage(listener: (message: unknown) => void): void;
    close(): void;
}

/** The URI the browser uses for the project's root folder; the server sees the copy's real folder instead. */
export const CLIENT_ROOT = 'file:///project/';

/** Starts `command` (texlab) in `workDir` and talks LSP to it. URIs under `CLIENT_ROOT` in messages to the server
 *  become URIs under `workDir`, and back, so the browser never learns the copy's path and the server never sees one
 *  outside its folder. */
export function startLanguageServer(command: string, workDir: string, args: readonly string[] = []): LanguageServerProcess {
    const real = pathToFileURL(workDir.endsWith('/') || workDir.endsWith('\\') ? workDir : `${workDir}/`).href;
    const child = spawn(command, [...args], { cwd: workDir, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const framing = new LspFraming();
    const listeners: ((m: unknown) => void)[] = [];
    child.stdout.on('data', (b: Buffer) => {
        for (const m of framing.push(b)) for (const l of listeners) l(rewriteUris(m, real, CLIENT_ROOT));
    });
    child.on('error', () => undefined);
    return {
        send(message) {
            if (child.stdin.writable) child.stdin.write(LspFraming.frame(rewriteUris(message, CLIENT_ROOT, real)));
        },
        onMessage(listener) {
            listeners.push(listener);
        },
        close() {
            child.kill();
        },
    };
}
