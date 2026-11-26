import { describe, expect, it } from 'vitest';
import { SPAN_FIELDS, readSpans, spansMap, type GlyphSpans } from '#lib/typst-spans.ts';

// main.typ, typeset on one page at 10 pt, 5 pt per character: the heading "1 Intro" (its number is the heading
// node's, not a character's) on a line with its baseline at y = 20, and "a fi b" with "fi" as one ligature at y = 40.
const SOURCE = '= Intro\na fi b\n';
const glyph = (x: number, y: number, width: number, start: number, end: number, exact = 1): number[] => [x, y, x + width, y, 10, 0, start, end, exact];
const PAGE = [
    ...glyph(0, 20, 5, 0, 7, 0), // "1", from the whole heading
    ...Array.from({ length: 'Intro'.length }, (_, i) => glyph(10 + i * 5, 20, 5, 2 + i, 3 + i)).flat(),
    ...glyph(0, 40, 5, 8, 9), // a
    ...glyph(10, 40, 8, 10, 12), // fi
    ...glyph(23, 40, 5, 13, 14), // b
];
const spans: GlyphSpans = { files: ['main.typ'], pages: [new Float64Array(PAGE)] };
const map = spansMap(spans, new Map([['main.typ', SOURCE]]));

describe('readSpans', () => {
    it('reads the numbers of each page from the bytes the compiler gives, wherever they start', () => {
        const numbers = new Float64Array(PAGE);
        const shifted = new Uint8Array(numbers.byteLength + 3);
        shifted.set(new Uint8Array(numbers.buffer), 3);
        const read = readSpans({ files: ['main.typ'], pages: [shifted.subarray(3)] });
        expect(read.pages[0]?.length).toBe(PAGE.length);
        expect([...(read.pages[0] ?? [])].slice(0, SPAN_FIELDS)).toEqual(PAGE.slice(0, SPAN_FIELDS));
    });
});

describe('spansMap', () => {
    it('places a source character on its glyph', () => {
        // "t" of Intro: line 1, column 4.
        expect(map.locate({ file: 'main.typ', line: 1, column: 4 })).toMatchObject({ page: 1, x: 20, width: 5 });
        // Either character of the ligature is on the ligature.
        expect(map.locate({ file: 'main.typ', line: 2, column: 3 })).toMatchObject({ x: 10, width: 8 });
    });

    it('places a column between words on the next glyph of its line, else the one before', () => {
        expect(map.locate({ file: 'main.typ', line: 2, column: 1 })).toMatchObject({ x: 10 });
        expect(map.locate({ file: 'main.typ', line: 2, column: 6 })).toMatchObject({ x: 23 });
    });

    it('places markup that shows as something else on what it made', () => {
        // The "=" of the heading shows as its number.
        expect(map.locate({ file: 'main.typ', line: 1, column: 0 })).toMatchObject({ x: 0, y: 12 });
    });

    it('gives the glyphs of a range, and none for text the document does not show', () => {
        const boxes = map.range({ file: 'main.typ', line: 2, column: 0 }, { file: 'main.typ', line: 2, column: 3 });
        expect(boxes?.map(b => b.x)).toEqual([0, 10]);
        expect(map.range({ file: 'main.typ', line: 2, column: 1 }, { file: 'main.typ', line: 2, column: 2 })).toBeNull();
        // The whole heading takes its number too; part of it does not.
        expect(map.range({ file: 'main.typ', line: 1, column: 0 }, { file: 'main.typ', line: 1, column: 7 })).toHaveLength(6);
        expect(map.range({ file: 'main.typ', line: 1, column: 2 }, { file: 'main.typ', line: 1, column: 7 })).toHaveLength(5);
    });

    it('tells the source of a point to the character', () => {
        expect(map.pointToSource(1, 17, 18)).toEqual({ file: 'main.typ', line: 1, column: 3, start: 3, length: 1, exact: true });
        // A ligature stands for both its characters, a number for its heading.
        expect(map.pointToSource(1, 14, 38)).toEqual({ file: 'main.typ', line: 2, column: 2, start: 2, length: 2, exact: false });
        expect(map.pointToSource(1, 2, 18)).toMatchObject({ line: 1, start: 0, length: 7, exact: false });
    });

    it('takes the nearest glyph of the line for a point beside it, and none far from any', () => {
        expect(map.pointToSource(1, 7, 38)).toMatchObject({ line: 2, column: 0 });
        expect(map.pointToSource(1, 60, 38)).toBeNull();
        expect(map.pointToSource(1, 2, 70)).toBeNull();
        expect(map.pointToSource(2, 2, 18)).toBeNull();
    });
});
