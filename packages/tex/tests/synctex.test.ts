import { describe, expect, it } from 'vitest';
import { backward, forward, inputPath, lineSegments, nearestForward, parseSynctex } from '../src/index.ts';

// One point (bp) is 65781.76 sp; with Unit:1 the numbers below are sp.
const bp = (n: number): number => Math.round(n * 65781.76);
const text = [
    'SyncTeX Version:1',
    'Input:1:/build/./paper.tex',
    'Input:2:/build/./sections/intro.tex',
    'Output:pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '{1',
    `[1,10:${bp(72)},${bp(720)}:${bp(468)},${bp(648)},0`,
    `(2,3:${bp(72)},${bp(100)}:${bp(468)},${bp(8)},${bp(2)}`,
    `x2,3:${bp(72)},${bp(100)}`,
    `x2,3:${bp(200)},${bp(100)}`,
    ')',
    `(2,4:${bp(72)},${bp(112)}:${bp(468)},${bp(8)},${bp(2)}`,
    `g2,4:${bp(90)},${bp(112)}`,
    ')',
    ']',
    '}1',
].join('\n');

describe('synctex', () => {
    const sync = parseSynctex(text);

    it('reads inputs and converts sp to points from the top-left', () => {
        expect(inputPath(sync.inputs.get(2) ?? '')).toBe('sections/intro.tex');
        const box = sync.records.find(r => r.kind === '(');
        expect(box?.x).toBeCloseTo(72, 3);
        expect(box?.y).toBeCloseTo(100, 3);
        expect(box?.width).toBeCloseTo(468, 3);
    });

    it('searches forward to the line boxes, top at baseline minus height', () => {
        const [b] = forward(sync, 'sections/intro.tex', 3);
        expect(b?.page).toBe(1);
        expect(b?.y).toBeCloseTo(92, 3);
        expect(b?.height).toBeCloseTo(10, 3);
    });

    it('falls back to the nearest line that has records', () => {
        expect(forward(sync, 'sections/intro.tex', 2)).toEqual([]);
        expect(nearestForward(sync, 'sections/intro.tex', 9)[0]?.y).toBeCloseTo(104, 3);
    });

    it('finds the segment of a typeset line that a source line covers', () => {
        // Line 3's hbox holds only line-3 records: the whole box. Line 4's box starts with its g record at x=90, but
        // as the box's first child the segment starts at the box's left edge.
        const three = lineSegments(sync, 'sections/intro.tex', 3);
        expect(three).toHaveLength(1);
        expect(three[0]?.x).toBeCloseTo(72, 3);
        expect(three[0]?.width).toBeCloseTo(468, 3);
        expect(lineSegments(sync, 'sections/intro.tex', 4)[0]?.y).toBeCloseTo(104, 3);
    });

    it('searches backward from a point on a text line', () => {
        expect(backward(sync, 1, 250, 96)).toMatchObject({ file: 'sections/intro.tex', line: 3 });
        expect(backward(sync, 1, 100, 108)).toMatchObject({ file: 'sections/intro.tex', line: 4 });
        expect(backward(sync, 2, 100, 100)).toBeNull();
    });

    it('takes the source of a typeset line from its kerns and glue, as pdfTeX writes them', () => {
        // The first line of a paragraph read from lines 2-5 (from a real pdflatex run): the box and the first character
        // record carry line 6, where the paragraph ended; the kerns carry the lines the words were read on.
        const para = parseSynctex(
            [
                'SyncTeX Version:1',
                'Input:2:./sections/intro.tex',
                'Output:pdf',
                'Unit:1',
                'X Offset:0',
                'Y Offset:0',
                'Content:',
                '{1',
                `[1,10:${bp(72)},${bp(720)}:${bp(468)},${bp(648)},0`,
                `(2,6:${bp(72)},${bp(323)}:${bp(468)},${bp(8)},${bp(2)}`,
                `x2,6:${bp(114)},${bp(323)}`,
                `k2,2:${bp(117)},${bp(323)}`,
                `x2,2:${bp(127)},${bp(323)}`,
                `k2,2:${bp(396)},${bp(323)}`,
                `k2,3:${bp(438)},${bp(323)}`,
                `x2,3:${bp(444)},${bp(323)}`,
                `k2,3:${bp(540)},${bp(323)}`,
                ')',
                ']',
                '}1',
            ].join('\n'),
        );
        expect(backward(para, 1, 76, 322)).toMatchObject({ file: 'sections/intro.tex', line: 2 });
        expect(backward(para, 1, 250, 322)).toMatchObject({ file: 'sections/intro.tex', line: 2 });
        expect(backward(para, 1, 500, 322)).toMatchObject({ file: 'sections/intro.tex', line: 3 });
        // Line 2's words start the typeset line: its highlight starts at the box's left edge, not at the first kern.
        expect(lineSegments(para, 'sections/intro.tex', 2)[0]?.x).toBeCloseTo(72, 3);
        expect(lineSegments(para, 'sections/intro.tex', 3)[0]?.x).toBeCloseTo(438, 3);
    });
});
