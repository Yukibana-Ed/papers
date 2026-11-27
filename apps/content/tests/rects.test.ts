import { describe, expect, it } from 'vitest';
import { lineOf, mergeLineRects } from '#lib/rects.ts';

describe('mergeLineRects', () => {
    it('merges the runs of one line into one rectangle spanning them', () => {
        const out = mergeLineRects([
            { x: 10, y: 100, width: 30, height: 12 },
            { x: 45, y: 101, width: 20, height: 10 },
            { x: 70, y: 99, width: 5, height: 13 },
        ]);
        expect(out).toEqual([{ x: 10, y: 99, width: 65, height: 13 }]);
    });

    it('keeps separate lines separate, sorted, and meeting halfway when they overlap', () => {
        const out = mergeLineRects([
            { x: 10, y: 120, width: 50, height: 14 },
            { x: 10, y: 100, width: 80, height: 14 },
        ]);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ y: 100, height: 14 });
        expect(out[1]).toMatchObject({ y: 120 });
    });

    it('splits overlapping neighbours at the middle', () => {
        const out = mergeLineRects([
            { x: 0, y: 0, width: 10, height: 12 },
            { x: 0, y: 10, width: 10, height: 12 },
        ]);
        expect(out[0]?.height).toBe(11);
        expect(out[1]?.y).toBe(11);
    });

    it('drops empty rectangles and pads the rest', () => {
        expect(mergeLineRects([{ x: 5, y: 5, width: 0, height: 10 }])).toEqual([]);
        expect(mergeLineRects([{ x: 5, y: 5, width: 10, height: 10 }], 2)).toEqual([{ x: 3, y: 3, width: 14, height: 14 }]);
    });

    it('takes a subscript into its line', () => {
        const out = mergeLineRects([
            { x: 0, y: 100, width: 40, height: 10 },
            { x: 40, y: 105, width: 8, height: 7 },
        ]);
        expect(out).toEqual([{ x: 0, y: 100, width: 48, height: 12 }]);
    });

    it('grows lines by their leading, meeting halfway between close lines', () => {
        expect(mergeLineRects([{ x: 0, y: 100, width: 10, height: 10 }], 0, 0.2)).toEqual([{ x: 0, y: 98, width: 10, height: 14 }]);
        const out = mergeLineRects(
            [
                { x: 0, y: 100, width: 10, height: 10 },
                { x: 0, y: 113, width: 10, height: 10 },
            ],
            0,
            0.2,
        );
        expect(out.map(r => [r.y, r.height])).toEqual([
            [98, 13.5],
            [111.5, 13.5],
        ]);
    });
});

describe('lineOf', () => {
    const run = (left: number, top: number, width: number, height = 10): { left: number; right: number; top: number; bottom: number } => ({
        left,
        right: left + width,
        top,
        bottom: top + height,
    });
    // Two columns, 20 apart: three lines in the left one (the second in two runs, with a raised mark after it), two in
    // the right one, level with the left's.
    const boxes = [run(0, 0, 100), run(0, 12, 40), run(43, 12, 57), run(100.5, 10, 3, 6), run(0, 24, 60), run(120, 0, 100), run(120, 12, 100)];

    it('is the runs of the line clicked, in its column only', () => {
        expect(lineOf(boxes, 50, 17)).toEqual([1, 2, 3]);
        expect(lineOf(boxes, 150, 17)).toEqual([6]);
        expect(lineOf(boxes, 10, 5)).toEqual([0]);
    });

    it('takes the nearest run for a click beside a line, and none for one far from any', () => {
        expect(lineOf(boxes, 70, 29)).toEqual([4]);
        expect(lineOf(boxes, 108, 29)).toEqual([]);
        expect(lineOf(boxes, 50, 60)).toEqual([]);
    });
});
