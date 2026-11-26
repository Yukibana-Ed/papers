import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_ROOT, ensureProgram, tarCommand, LspFraming, rewriteUris, startLanguageServer, type Pinned } from '../src/index.ts';

/** A tar.gz holding one fake program, and its digest. */
function fakeArchive(): { bytes: Uint8Array; sha256: string } {
    const dir = mkdtempSync(join(tmpdir(), 'papers-lsp-src-'));
    writeFileSync(join(dir, 'fakels'), '#!/bin/sh\necho fake\n');
    writeFileSync(join(dir, 'fakels.exe'), 'MZ fake');
    execFileSync(tarCommand(), ['-czf', join(dir, 'a.tar.gz'), '-C', dir, 'fakels', 'fakels.exe']);
    const bytes = new Uint8Array(readFileSync(join(dir, 'a.tar.gz')));
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

describe('ensureProgram', () => {
    const a = fakeArchive();
    const platform = `${process.platform}-${process.arch}`;
    const pin = (sha256: string): Pinned => ({
        version: '1.0.0',
        url: 'https://example.invalid/{version}/{name}',
        binary: 'fakels',
        assets: { [platform]: { name: 'a.tar.gz', sha256 } },
    });

    it('downloads once, checks the digest, and installs the program', async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), 'papers-lsp-'));
        const urls: string[] = [];
        const download = (url: string): Promise<Uint8Array> => {
            urls.push(url);
            return Promise.resolve(a.bytes);
        };
        const path = await ensureProgram({ cacheDir, pinned: pin(a.sha256), download });
        expect(existsSync(path)).toBe(true);
        expect(await ensureProgram({ cacheDir, pinned: pin(a.sha256), download })).toBe(path);
        expect(urls).toEqual(['https://example.invalid/1.0.0/a.tar.gz']);
    });

    it('refuses an archive with another digest and installs nothing', async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), 'papers-lsp-'));
        await expect(ensureProgram({ cacheDir, pinned: pin('0'.repeat(64)), download: () => Promise.resolve(a.bytes) })).rejects.toThrow(/refusing/);
        expect(existsSync(join(cacheDir, 'fakels', '1.0.0', process.platform === 'win32' ? 'fakels.exe' : 'fakels'))).toBe(false);
    });

    it('says so for a platform without a build', async () => {
        await expect(ensureProgram({ cacheDir: tmpdir(), pinned: pin(a.sha256), platform: 'plan9-mips' })).rejects.toThrow(/no fakels build/);
    });
});

describe('LSP plumbing', () => {
    it('frames and unframes messages, across chunk boundaries', () => {
        const f = new LspFraming();
        const bytes = Buffer.concat([LspFraming.frame({ id: 1, ü: 'é' }), LspFraming.frame({ id: 2 })]);
        expect(f.push(bytes.subarray(0, 10))).toEqual([]);
        expect(f.push(bytes.subarray(10))).toEqual([{ id: 1, ü: 'é' }, { id: 2 }]);
    });

    it('rewrites URIs at any depth', () => {
        expect(rewriteUris({ a: [`${CLIENT_ROOT}main.tex`, 'x'], b: { uri: `${CLIENT_ROOT}a/b.tex` } }, CLIENT_ROOT, 'file:///C:/work/')).toEqual({
            a: ['file:///C:/work/main.tex', 'x'],
            b: { uri: 'file:///C:/work/a/b.tex' },
        });
    });

    it('talks to a language server process with the client URIs mapped', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'papers-lsp-echo-'));
        mkdirSync(dir, { recursive: true });
        // A server that answers each request with the URI it was given.
        const script = join(dir, 'echo.mjs');
        writeFileSync(
            script,
            `let buf = Buffer.alloc(0);
process.stdin.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    const body = JSON.stringify({ id: msg.id, result: msg.params.uri });
    process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
});
`,
        );
        const ls = startLanguageServer(process.execPath, dir, [script]);
        const got = new Promise<unknown>(resolve => ls.onMessage(resolve));
        ls.send({ jsonrpc: '2.0', id: 7, method: 'test', params: { uri: `${CLIENT_ROOT}main.tex` } });
        const reply = await got;
        ls.close();
        expect(reply).toEqual({ id: 7, result: `${CLIENT_ROOT}main.tex` });
    });
});
