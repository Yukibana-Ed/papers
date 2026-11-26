import { describe, expect, it } from 'vitest';
import { charBoxes, type Glyph } from '#lib/glyphs.ts';
import type { PageText } from '#lib/sourcemap.ts';

const glyph = (text: string, x: number, width: number): Glyph => ({ text, box: { page: 1, x, y: 0, width, height: 10 } });
const text = (str: string): PageText => ({ page: 1, str, x: 0, y: 10, width: 1, height: 10 });

describe('charBoxes', () => {
    it('gives each character its glyph, and none to the spaces text extraction adds', () => {
        const boxes = charBoxes([text('a b')], [glyph('a', 0, 5), glyph('b', 8, 6)]);
        expect(boxes).toEqual([[{ page: 1, x: 0, y: 0, width: 5, height: 10 }, null, { page: 1, x: 8, y: 0, width: 6, height: 10 }]]);
    });

    it("shares a ligature's box among its letters, across runs too", () => {
        const [first, second] = charBoxes([text('of'), text('fice')], [glyph('o', 0, 5), glyph('ffi', 5, 9), glyph('c', 14, 4), glyph('e', 18, 4)]);
        expect(first?.[1]).toMatchObject({ x: 5, width: 3 });
        expect(second?.map(b => b?.x)).toEqual([8, 11, 14, 18]);
    });

    it('matches an accented letter with its glyph, and skips glyphs the text does not have', () => {
        const boxes = charBoxes([text('né')], [glyph('n', 0, 5), glyph(' ', 5, 3), glyph('é', 8, 4)]);
        expect(boxes[0]?.[1]).toMatchObject({ x: 8, width: 4 });
    });

    it('leaves a character without a box when no glyph nearby shows it, and goes on', () => {
        const boxes = charBoxes([text('a?b')], [glyph('a', 0, 5), glyph('b', 5, 5)]);
        expect(boxes[0]?.map(b => b?.x ?? null)).toEqual([0, null, 5]);
    });
});
