import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProcessRunner, RunResult } from '@yukibana/papers-compiler';
import { sandboxRunner, sandboxSupport } from '../src/index.ts';

/** A TeX tree to build with: `PAPERS_TEST_TEXBIN` (its `bin/<platform>`); without it the TeX checks are skipped. */
const texBin = process.env['PAPERS_TEST_TEXBIN'] ?? null;
const texRoot = texBin ? dirname(dirname(texBin)) : null;
const windows = process.platform === 'win32';
const support = await sandboxSupport();

/** The sandbox must exist where it is promised; CI sets PAPERS_REQUIRE_SANDBOX so a missing one fails, not skips. */
const required = process.env['PAPERS_REQUIRE_SANDBOX'] === '1';

describe.skipIf(!support.available && !required)(`the ${support.kind ?? 'missing'} sandbox`, () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'papers-sbx-')));
    const work = join(base, 'work');
    const outside = join(base, 'outside');
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    let runner: ProcessRunner;
    /** Runs a shell command line in the work folder. */
    const sh = (line: string): Promise<RunResult> =>
        windows
            ? runner.run({ program: 'cmd', args: ['/c', line], cwd: work, timeoutMs: 30_000 })
            : runner.run({ program: 'sh', args: ['-c', line], cwd: work, timeoutMs: 30_000 });

    beforeAll(async () => {
        expect(support.available, support.detail).toBe(true);
        // Without a TeX tree an empty one stands in: the confinement checks need no TeX.
        const root = texRoot ?? join(base, 'tex');
        const bin = texBin ?? join(root, 'bin', 'none');
        mkdirSync(bin, { recursive: true });
        runner = await sandboxRunner('auto', { texRoot: root, texBin: bin, workDir: work });
        expect(runner.kind).toBe(support.kind);
    }, 120_000);

    it('runs programs that write in the work folder', async () => {
        const r = await sh('echo inside> made.txt');
        expect(r.code, r.stderr).toBe(0);
        expect(readFileSync(join(work, 'made.txt'), 'utf8').trim()).toBe('inside');
    }, 60_000);

    it('cannot read or write outside it', async () => {
        const read = await sh(`${windows ? 'type' : 'cat'} "${join(outside, 'secret.txt')}"`);
        expect(read.stdout).not.toContain('TOP SECRET');
        expect(read.code).not.toBe(0);
        await sh(`echo x> "${join(outside, 'written.txt')}"`);
        expect(existsSync(join(outside, 'written.txt'))).toBe(false);
    }, 60_000);

    it('has no network, not even the host loopback', async () => {
        let connected = false;
        const server = createServer(s => {
            connected = true;
            s.end('HTTP/1.0 200 OK\r\n\r\nhello');
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const r = await runner.run({ program: 'curl', args: ['-s', '-S', '-m', '5', `http://127.0.0.1:${port}/`], cwd: work });
        server.close();
        expect(r.stdout).not.toContain('hello');
        expect(r.code).not.toBe(0);
        expect(connected).toBe(false);
    }, 60_000);

    it('refuses a working folder outside the work folder', async () => {
        await expect(runner.run({ program: 'cmd', args: [], cwd: outside })).rejects.toThrow(/work folder/);
    });

    it.skipIf(texBin === null)(
        'builds with pdfLaTeX inside, and \\input of an outside file fails',
        async () => {
            writeFileSync(join(work, 'ok.tex'), '\\documentclass{article}\\begin{document}Inside.\\end{document}\n');
            const ok = await runner.run({ program: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', 'ok.tex'], cwd: work });
            expect(ok.code, ok.stderr + ok.stdout.slice(-500)).toBe(0);
            expect(existsSync(join(work, 'ok.pdf'))).toBe(true);
            const secret = join(outside, 'secret.txt').replace(/\\/g, '/');
            writeFileSync(join(work, 'leak.tex'), `\\documentclass{article}\\begin{document}\\input{${secret}}\\end{document}\n`);
            const leak = await runner.run({ program: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', 'leak.tex'], cwd: work });
            expect(leak.code).not.toBe(0);
            expect(readFileSync(join(work, 'leak.log'), 'utf8')).not.toContain('TOP SECRET');
        },
        120_000,
    );
});
