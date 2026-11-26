import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { isServerMessage, RUNNER_PROTOCOL, safePath, startRunner, type Runner, type ServerMessage } from '../src/index.ts';

const APP = 'https://papers.yukibana.dev';

/** A server message, trusted as such in a test. */
function decode(text: string): ServerMessage {
    const x: unknown = JSON.parse(text);
    if (!isServerMessage(x)) throw new Error('not a message');
    return x;
}

function post(port: number, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: unknown; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as unknown) : null, headers: res.headers }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

describe('the local build server', () => {
    let runner: Runner;
    let code = '';
    const work = mkdtempSync(join(tmpdir(), 'papers-runner-'));
    const seen: string[] = [];

    beforeAll(async () => {
        runner = await startRunner({
            port: 0,
            origins: [APP],
            workRoot: work,
            sandbox: 'test',
            toolchain: 'none',
            onCode: c => (code = c),
            build: async (dir, root, onStep) => {
                onStep('pdflatex');
                seen.push(readFileSync(join(dir, root), 'utf8'));
                const pdf = join(dir, 'out.pdf');
                writeFileSync(pdf, '%PDF-1.7 fake');
                return { ok: true, pages: 1, ms: 5, diagnostics: [{ file: root, line: 1, severity: 'warning', message: 'w' }], pdf, synctex: null };
            },
        });
    });
    afterAll(() => runner.close());

    it('refuses other origins and other hosts', async () => {
        expect((await post(runner.port, '/pair', { code }, { Origin: 'https://evil.example' })).status).toBe(403);
        expect((await post(runner.port, '/pair', { code }, { Origin: APP, Host: `attacker.example:${runner.port}` })).status).toBe(403);
    });

    it('replaces the code after five wrong guesses', async () => {
        const before = code;
        for (let i = 0; i < 5; i++) expect((await post(runner.port, '/pair', { code: 'WRONG' }, { Origin: APP })).status).toBe(401);
        expect(code).not.toBe(before);
    });

    it('pairs, then builds over the socket and returns the PDF', async () => {
        const paired = await post(runner.port, '/pair', { code }, { Origin: APP });
        expect(paired.status).toBe(200);
        expect(paired.headers['access-control-allow-private-network']).toBe('true');
        const body = paired.body;
        const token = typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string' ? body.token : '';
        // A code works once.
        expect((await post(runner.port, '/pair', { code: 'X' }, { Origin: APP })).status).toBe(401);

        const ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`, { origin: APP });
        const messages: (ServerMessage | Buffer)[] = [];
        const waitFor = (pred: () => boolean): Promise<void> =>
            new Promise(resolve => {
                const t = setInterval(() => {
                    if (pred()) {
                        clearInterval(t);
                        resolve();
                    }
                }, 10);
            });
        ws.on('message', (data: RawData, binary) => {
            const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            messages.push(binary ? bytes : decode(bytes.toString('utf8')));
        });
        await new Promise(r => ws.once('open', r));
        ws.send(JSON.stringify({ type: 'hello', token, protocol: RUNNER_PROTOCOL }));
        ws.send(JSON.stringify({ type: 'project', files: { 'paper/main.tex': { text: 'hello' }, 'img.png': { base64: 'AAEC' } } }));
        ws.send(JSON.stringify({ type: 'files', changes: [{ path: '../escape.tex', body: { text: 'x' } }] }));
        ws.send(JSON.stringify({ type: 'build', id: 'b1', root: 'paper/main.tex' }));
        await waitFor(() => messages.some(m => Buffer.isBuffer(m)));
        ws.close();
        const json = messages.filter((m): m is ServerMessage => !Buffer.isBuffer(m));
        expect(json[0]).toMatchObject({ type: 'ready', sandbox: 'test' });
        expect(json.some(m => m.type === 'error' && m.message.includes('not a project path'))).toBe(true);
        expect(json.some(m => m.type === 'status' && m.step === 'pdflatex')).toBe(true);
        expect(json.find(m => m.type === 'built')).toMatchObject({ ok: true, pages: 1 });
        expect(json.find(m => m.type === 'artifact')).toMatchObject({ name: 'pdf', bytes: 13 });
        expect(String(messages.find(m => Buffer.isBuffer(m)))).toBe('%PDF-1.7 fake');
        expect(seen).toEqual(['hello']);
    });

    it('closes a socket without a valid token', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`, { origin: APP });
        await new Promise(r => ws.once('open', r));
        ws.send(JSON.stringify({ type: 'hello', token: 'nope', protocol: RUNNER_PROTOCOL }));
        const closeCode = await new Promise<number>(r => ws.once('close', c => r(c)));
        expect(closeCode).toBe(4401);
    });

    it('accepts only safe project paths', () => {
        for (const ok of ['main.tex', 'a/b.tex', 'fig/x.png']) expect(safePath(ok)).toBe(ok);
        for (const bad of ['', '../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', 'con.tex', 'a/./b', 'x. ']) expect(safePath(bad)).toBeNull();
    });
});
