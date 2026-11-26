import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveToolchain } from '../src/toolchain.ts';

describe('resolveToolchain', () => {
    it('takes an explicit TeX Live root or bin folder', () => {
        const root = mkdtempSync(join(tmpdir(), 'papers-tex-'));
        const bin = join(root, 'bin', process.platform === 'win32' ? 'windows' : 'x86_64-linux');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, process.platform === 'win32' ? 'pdflatex.exe' : 'pdflatex'), '');
        for (const given of [root, bin]) {
            const t = resolveToolchain({ kind: 'managed', texlive: '2026', packages: [] }, given);
            expect(t.root).toBe(root);
            expect(t.bin).toBe(bin);
        }
        expect(() => resolveToolchain({ kind: 'system' }, tmpdir())).toThrow(/no pdflatex/);
    });

    it('never swaps the declared environment for another', () => {
        const saved = process.env['PAPERS_TEX'];
        delete process.env['PAPERS_TEX'];
        try {
            expect(() => resolveToolchain({ kind: 'managed', texlive: '1999', packages: [] }, undefined)).toThrow(/not installed/);
            expect(() => resolveToolchain({ kind: 'oci', image: `x@sha256:${'0'.repeat(64)}` }, undefined)).toThrow(/not supported/);
            expect(() => resolveToolchain({ kind: 'nix', flake: 'github:o/r' }, undefined)).toThrow(/nix develop/);
        } finally {
            if (saved !== undefined) process.env['PAPERS_TEX'] = saved;
        }
    });
});
