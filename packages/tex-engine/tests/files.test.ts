import { describe, expect, it } from 'vitest';
import { absolute, commonPrefix, projectKind, projectList } from '../src/index.ts';
import { project } from './support.ts';

describe('paths', () => {
    it('are made absolute and normal', () => {
        expect(absolute('/project', 'a/./b//c.tex')).toBe('/project/a/b/c.tex');
        expect(absolute('/project', '../x/../y')).toBe('/y');
        expect(absolute('/project', '/tex/../fmt/latex.fmt')).toBe('/fmt/latex.fmt');
        expect(absolute('/project', '.')).toBe('/project');
        expect(absolute('/', '../..')).toBe('/');
    });
});

describe('a project', () => {
    const p = project({ 'main.tex': '', 'figures/a.pdf': '', 'figures/raw/b.png': '', 'refs.bib': '' });
    it('has the directories its files are in', () => {
        expect(projectKind(p, '')).toBe(2);
        expect(projectKind(p, 'figures')).toBe(2);
        expect(projectKind(p, 'figures/raw')).toBe(2);
        expect(projectKind(p, 'figures/a.pdf')).toBe(1);
        expect(projectKind(p, 'figures/c.pdf')).toBe(0);
        expect(projectKind(p, 'fig')).toBe(0);
    });
    it('lists a directory sorted, files and directories', () => {
        expect(projectList(p, '')).toEqual([
            { name: 'figures', kind: 2 },
            { name: 'main.tex', kind: 1 },
            { name: 'refs.bib', kind: 1 },
        ]);
        expect(projectList(p, 'figures')).toEqual([
            { name: 'a.pdf', kind: 1 },
            { name: 'raw', kind: 2 },
        ]);
        expect(projectList(p, 'main.tex')).toBeNull();
    });
});

describe('the common prefix', () => {
    it('is counted to the byte, whatever the lengths', () => {
        for (const n of [0, 1, 7, 8, 9, 63, 64, 65, 1000]) {
            const a = Uint8Array.from({ length: n }, (_, i) => i % 251);
            expect(commonPrefix(a, a.slice())).toBe(n);
            expect(commonPrefix(a, a.slice(0, n >> 1))).toBe(n >> 1);
            for (const at of [0, 3, 8, 15, 16, 999].filter(i => i < n)) {
                const b = a.slice();
                b[at] = 255;
                expect(commonPrefix(a, b)).toBe(at);
                expect(commonPrefix(b.subarray(1), a.subarray(1))).toBe(at === 0 ? n - 1 : at - 1);
            }
        }
    });
});
