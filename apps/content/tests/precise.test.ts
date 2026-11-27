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

describe('with glyph boxes', () => {
    // "Will fill" where W is 3 pt wide, i and l 0.5 pt, f 1 pt: the glyphs are where the font puts them, not at shares
    // of the run's width. The second run ends "ta-" and the third starts "ble": one word over two lines.
    const widths: Record<string, number> = { W: 3, i: 0.5, l: 0.5, f: 1, ' ': 1, t: 1, a: 1, b: 1, e: 1, '-': 1 };
    const run = (str: string, y: number): PageText => {
        let x = 10;
        const chars = str.split('').map(c => {
            const box = c === ' ' ? null : { page: 1, x, y: y - 8, width: widths[c] ?? 1, height: 10 };
            x += widths[c] ?? 1;
            return box;
        });
        return { page: 1, str, x: 10, y, width: x - 10, height: 10, chars };
    };
    const texts = [run('Will fill ta-', 20), run('ble', 34)];
    const source = 'Will fill table';
    const lines: SourceMap = { segments: (_f, line) => (line === 1 ? [LINE_BAND(20), LINE_BAND(34)] : []), backward: () => ({ file: 'main.tex', line: 1 }) };
    const exact = preciseMap(lines, docWords(texts), new Map([['main.tex', source]]), 'latex');

    it('boxes a word around its glyphs', () => {
        const [will, fill] = docWords(texts);
        expect(will?.parts[0]).toMatchObject({ x: 10, width: 4.5 });
        expect(fill?.parts[0]).toMatchObject({ x: 15.5, width: 2.5 });
    });

    it('places a source column on its glyph', () => {
        // The "i" of "Will" follows a W three points wide.
        expect(exact.locate({ file: 'main.tex', line: 1, column: 1 })).toMatchObject({ x: 13, width: 0.5 });
    });

    it('finds the character whose glyph is under a point', () => {
        // x = 12.5 is still inside the W; by shares of the width it would be the second "l".
        expect(exact.pointToSource(1, 12.5, 15)).toMatchObject({ column: 0, exact: true });
        expect(exact.pointToSource(1, 14.2, 15)).toMatchObject({ column: 3, exact: true });
    });

    it('cuts a range to the glyphs at its ends, on each line of a hyphenated word', () => {
        // "ill fil": the end of "Will" and the start of "fill".
        expect(exact.range({ file: 'main.tex', line: 1, column: 1 }, { file: 'main.tex', line: 1, column: 8 })).toMatchObject([
            { x: 13, width: 1.5 },
            { x: 15.5, width: 2 },
        ]);
        // The "b" of "table" is on the second line.
        expect(exact.locate({ file: 'main.tex', line: 1, column: 12 })).toMatchObject({ x: 10, y: 34 - 8.5, width: 1 });
    });
});

describe("words the line's own place does not show", () => {
    // Page 1 is prose with "of" three times; page 2 has a table whose rows are a source line each and end in "of"
    // between two numbers that come from macros, and a footnote set away from its paragraph.
    const band = (page: number, y: number): { page: number; x: number; y: number; width: number; height: number } => ({ page, x: 0, y: y - 10, width: 200, height: 13 });
    const texts: PageText[] = [
        { page: 1, str: 'A list of words of little weight of its own', x: 0, y: 20, width: 43, height: 10 },
        { page: 2, str: 'T03 hiding 58 of 67', x: 0, y: 20, width: 19, height: 10 },
        { page: 2, str: 'T04 revealing 59 of 68', x: 0, y: 34, width: 22, height: 10 },
        { page: 2, str: 'T05 hiding 60 of 67', x: 0, y: 48, width: 19, height: 10 },
        { page: 2, str: 'Prose with a note', x: 0, y: 80, width: 17, height: 10 },
        { page: 2, str: 'kept at the foot here', x: 0, y: 300, width: 21, height: 10 },
        { page: 2, str: 'said twice over again', x: 0, y: 320, width: 21, height: 10 },
        { page: 2, str: 'said twice over again', x: 0, y: 340, width: 21, height: 10 },
    ];
    const table = ['T03 & hiding & \\A{} of \\B{} \\\\', 'T04 & revealing & \\A{} of \\B{} \\\\', 'T05 & hiding & \\A{} of \\B{} \\\\'].join('\n');
    const prose = ['Prose with a note\\footnote{kept at the foot here}', '', '', '', '', '', '', '', 'Other\\footnote{said twice over again}'].join('\n');
    const lines: SourceMap = {
        segments: (file, line) => (file === 'table.tex' ? [band(2, 6 + line * 14)] : line === 1 ? [band(2, 80)] : []),
        backward: () => null,
    };
    const far = preciseMap(
        lines,
        docWords(texts),
        new Map([
            ['table.tex', table],
            ['prose.tex', prose],
        ]),
        'latex',
    );

    it("pairs a row's word with its own row, never with the same word elsewhere", () => {
        const of = (table.split('\n')[1] ?? '').indexOf(' of ') + 1;
        expect(far.locate({ file: 'table.tex', line: 2, column: of })).toMatchObject({ page: 2, y: 25.5 });
        for (let line = 1; line <= 3; line++) {
            for (let column = 0; column < 40; column++) expect(far.locate({ file: 'table.tex', line, column })?.page ?? 2).toBe(2);
        }
    });

    it('finds words set elsewhere when the document has them in a row in one place', () => {
        const at = (prose.split('\n')[0] ?? '').lastIndexOf('foot');
        expect(far.locate({ file: 'prose.tex', line: 1, column: at })).toMatchObject({ page: 2, x: 12, width: 1 });
    });

    it('says nothing about words the document has in a row in two places', () => {
        const at = (prose.split('\n')[8] ?? '').indexOf('twice');
        expect(far.locate({ file: 'prose.tex', line: 9, column: at })).toBeNull();
    });
});
