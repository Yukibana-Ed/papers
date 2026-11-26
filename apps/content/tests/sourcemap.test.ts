import { describe, expect, it } from 'vitest';
import { textMap, typstLineWords, type PageText } from '#lib/sourcemap.ts';

/** A page of text runs, one per line, 10 pt high, 6 pt per character, lines 14 pt apart. */
function page(n: number, lines: string[], top = 72): PageText[] {
    return lines.map((str, i) => ({ page: n, str, x: 72, y: top + i * 14, width: str.length * 6, height: 10 }));
}

const sources = new Map([
    [
        'main.typ',
        [
            '#set heading(numbering: "1.")',
            '= Introduction <intro>',
            'Learning to program is _central_ for every',
            'student, yet the first weeks are hard @becker.',
            '',
            '#include "method.typ"',
        ].join('\n'),
    ],
    ['method.typ', ['= Method', 'We ran the study in the winter term', 'of 2025 with *412* students.'].join('\n')],
]);

const texts = [
    ...page(1, ['1 Introduction', 'Learning to program is central for every student, yet the', 'first weeks are hard [1].']),
    ...page(2, ['2 Method', 'We ran the study in the winter term of 2025 with 412', 'students.']),
];

describe('textMap', () => {
    const map = textMap(texts, sources);

    it('reads the words of a Typst line that show', () => {
        expect(typstLineWords('= Introduction <intro>')).toEqual(['introduction']);
        expect(typstLineWords('#set heading(numbering: "1.")')).toEqual(['heading', 'numbering', '1']);
        expect(typstLineWords('hard @becker. // todo')).toEqual(['hard']);
    });

    it('finds where a source line shows, across a line break', () => {
        const segs = map.segments('main.typ', 4);
        expect(segs.length).toBe(2);
        expect(segs[0]).toMatchObject({ page: 1 });
        expect(segs[0]?.x).toBeGreaterThan(72 + 30 * 6);
        expect(map.segments('method.typ', 2)[0]).toMatchObject({ page: 2, x: 72 });
    });

    it('falls back to a neighbouring line for a line with no text', () => {
        expect(map.segments('main.typ', 5).length).toBeGreaterThan(0);
        expect(map.segments('main.typ', 5, false)).toEqual([]);
    });

    it('maps a click back to its source line', () => {
        // "students." on page 2's third line, and "Learning" on page 1's second line.
        expect(map.backward(2, 75, 100)).toEqual({ file: 'method.typ', line: 3 });
        expect(map.backward(1, 80, 86)).toEqual({ file: 'main.typ', line: 3 });
        expect(map.backward(1, 400, 300)).toBeNull();
    });
});
