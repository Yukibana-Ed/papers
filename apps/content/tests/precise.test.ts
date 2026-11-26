import { describe, expect, it } from 'vitest';
import { docWords, preciseMap } from '#lib/precise.ts';
import type { PageText, SourceMap } from '#lib/sourcemap.ts';

// A one-page document typeset from main.tex: two text lines, 10 pt high, 1 pt per character, the second starting
// with the end of a hyphenated word. Its coarse map knows lines only, as SyncTeX does.
const SOURCE = ['\\section{Intro}', 'The quick brown fox jumps over', 'the lazy dog and Erd\\H{o}s naps.'].join('\n');
const TEXTS: PageText[] = [
    { page: 1, str: 'The quick brown fox jumps over the la-', x: 0, y: 20, width: 38, height: 10 },
    { page: 1, str: 'zy dog and Erdős naps.', x: 0, y: 34, width: 22, height: 10 },
];
const LINE_BAND = (y: number): { page: number; x: number; y: number; width: number; height: number } => ({ page: 1, x: 0, y: y - 10, width: 100, height: 13 });
const coarse: SourceMap = {
    segments: (_file, line) => (line === 2 ? [LINE_BAND(20)] : line === 3 ? [LINE_BAND(20), LINE_BAND(34)] : []),
    backward: (_page, _x, y) => ({ file: 'main.tex', line: y < 25 ? 2 : 3 }),
};
const map = preciseMap(coarse, docWords(TEXTS), new Map([['main.tex', SOURCE]]), 'latex');

describe('docWords', () => {
    it('joins a word hyphenated across lines into one word with two boxes', () => {
        const lazy = docWords(TEXTS).find(w => w.key === 'lazy');
        expect(lazy?.parts).toHaveLength(2);
        expect(lazy?.text).toBe('lazy');
    });
});

describe('preciseMap', () => {
    it('places a source column on its character in the document', () => {
        // "quick" starts at column 4 of line 2, and at x = 4 in the document; its "i" is two characters on.
        expect(map.locate({ file: 'main.tex', line: 2, column: 6 })).toMatchObject({ page: 1, x: 6, width: 1 });
    });

    it('places a word the source spells differently as a whole word', () => {
        const at = (SOURCE.split('\n')[2] ?? '').indexOf('Erd');
        const box = map.locate({ file: 'main.tex', line: 3, column: at + 4 });
        expect(box).toMatchObject({ x: 11, width: 5 });
    });

    it('maps a click to the character under it, and back to the word where spelt differently', () => {
        expect(map.pointToSource(1, 6.5, 15)).toMatchObject({ file: 'main.tex', line: 2, column: 6, start: 4, exact: true });
        const erdos = map.pointToSource(1, 13.5, 29);
        expect(erdos).toMatchObject({ line: 3, exact: false });
        expect(erdos?.column).toBe(erdos?.start);
    });

    it('gives the boxes of a range across lines, trimmed to the characters at its ends', () => {
        // From "brown" (line 2, column 10) to the end of "dog" (line 3, column 11).
        const boxes = map.range({ file: 'main.tex', line: 2, column: 10 }, { file: 'main.tex', line: 3, column: 12 });
        expect(boxes?.[0]).toMatchObject({ x: 10 });
        expect(boxes?.at(-1)).toMatchObject({ x: 3, width: 3 });
    });

    it('says nothing rather than guess: a click between lines, a word the document does not show', () => {
        expect(map.pointToSource(1, 50, 15)).toBeNull();
        expect(map.locate({ file: 'main.tex', line: 1, column: 9 })).toBeNull();
    });
});
