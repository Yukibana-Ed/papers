import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DiskTree, keptFormat } from '../src/node.ts';
import { engine } from './support.ts';

const dir = mkdtempSync(join(tmpdir(), 'tex-engine-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A directory with the least an installation needs to dump a format called pdflatex. */
function installation(): string {
    const root = join(dir, 'tl');
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'tex'), { recursive: true });
    writeFileSync(join(root, 'bin', 'texmf.cnf'), 'TEXINPUTS = /tl/tex\nTEXFORMATS = .\nTEXPOOL = .\nWEB2C = /tl/tex\nopenout_any = p\nopenin_any = a\n');
    writeFileSync(join(root, 'tex', 'cp227.tcx'), '');
    writeFileSync(join(root, 'tex', 'pdflatex.ini'), '\\catcode`\\{=1 \\catcode`\\}=2 \\def\\made{here}\\dump\n');
    return root;
}

describe('a directory of this computer as a tree', () => {
    const root = installation();
    const tree = new DiskTree(new Map([['/extra/file', new Uint8Array([1])]]), { at: '/tl', dir: root });

    it('holds the directory at its path and nothing else of the disk', () => {
        expect(tree.kind('/tl')).toBe(2);
        expect(tree.kind('/tl/tex/pdflatex.ini')).toBe(1);
        expect(tree.read('/tl/tex/pdflatex.ini')).toEqual(new Uint8Array(readFileSync(join(root, 'tex', 'pdflatex.ini'))));
        expect(tree.list('/tl').map(e => e.name)).toEqual(['bin', 'tex']);
        expect(tree.kind('/')).toBe(2);
        // The way to the mount and to the extra file.
        expect(tree.list('/')).toEqual([
            { name: 'extra', kind: 2 },
            { name: 'tl', kind: 2 },
        ]);
        expect(tree.kind('/extra')).toBe(2);
        expect(tree.list('/extra')).toEqual([{ name: 'file', kind: 1 }]);
        expect(tree.kind(root)).toBe(0);
        expect(tree.read('/etc/passwd')).toBeNull();
        expect(tree.kind('/tlx')).toBe(0);
        expect(tree.read('/extra/file')).toEqual(new Uint8Array([1]));
    });

    it('stamps a file by what the disk says now', () => {
        const file = join(root, 'tex', 'stamped.tex');
        writeFileSync(file, 'a');
        const first = tree.stamp('/tl/tex/stamped.tex');
        expect(tree.stamp('/tl/tex/stamped.tex')).toBe(first);
        writeFileSync(file, 'ab');
        expect(tree.stamp('/tl/tex/stamped.tex')).not.toBe(first);
        expect(tree.stamp('/tl/tex/none.tex')).toBe('0');
        expect(tree.stamp('/tl/tex')).toBe('2');
    });
});

describe.runIf(engine !== null)('a kept format', () => {
    it('is dumped once for an engine and an installation, and again when a file it was dumped from changes', () => {
        if (engine === null) return;
        const root = installation();
        const cache = join(dir, 'cache');
        const bytes = new Uint8Array([1, 2, 3]);
        // The engine's own place need not be on the disk: it is given.
        const tree = (): DiskTree => new DiskTree(new Map([['/tl/bin/pdftex', new Uint8Array(0)]]), { at: '/tl', dir: root });
        const first = keptFormat(engine, bytes, tree(), '/tl/bin/pdftex', 1_700_000_000, cache);
        expect(first.time).toBe(1_700_000_000);
        expect(first.format.length).toBeGreaterThan(1000);
        // Kept: the time it was dumped at comes back, not the one asked for now.
        const second = keptFormat(engine, bytes, tree(), '/tl/bin/pdftex', 1_800_000_000, cache);
        expect(second.time).toBe(1_700_000_000);
        expect(second.format).toEqual(first.format);
        // Another engine: its own format.
        expect(keptFormat(engine, new Uint8Array([4]), tree(), '/tl/bin/pdftex', 1_800_000_000, cache).time).toBe(1_800_000_000);
        // A file the dump read has changed.
        const ini = join(root, 'tex', 'pdflatex.ini');
        writeFileSync(ini, '\\catcode`\\{=1 \\catcode`\\}=2 \\def\\made{there}\\dump\n');
        utimesSync(ini, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
        const third = keptFormat(engine, new Uint8Array([4]), tree(), '/tl/bin/pdftex', 1_850_000_000, cache);
        expect(third.time).toBe(1_850_000_000);
        expect(third.format).not.toEqual(first.format);
    });
});
