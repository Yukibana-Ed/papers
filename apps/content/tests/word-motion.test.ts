import { array, assert, boolean, constant, constantFrom, nat, oneof, pre, property, tuple } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extendByWord, isWordChar, nextWordEnd, prevWordStart, wordBeside } from '#lib/word-motion.ts';

/** Text as a page shows it: words (with accents, digits, a combining mark), spaces, punctuation, line feeds between
 *  runs, hyphens, and words hyphenated across a line break. Many short pieces, so every kind of boundary comes up. */
const piece = oneof(
    { weight: 6, arbitrary: constantFrom('a', 'word', 'É', 'naïve', '42', 'ét', 'x1', 'größer', '字') },
    { weight: 4, arbitrary: constantFrom(' ', '  ', '\n', ' \n') },
    { weight: 2, arbitrary: constantFrom('.', ',', ', ', '(', ')', '—', '-', '--', "'", '. ') },
    { weight: 1, arbitrary: constantFrom('ta-\nble', 'well-\nknown', '-\n', 'a-\n', '-\nb') },
);
const text = array(piece, { maxLength: 30 }).map(p => p.join(''));
/** A text and a position in it. */
const at = text.chain(t => tuple(constant(t), nat({ max: t.length })));

/** The words of `t` by a reading of the rules that shares nothing with the module's loops: [start, end) pairs. */
function words(t: string): [number, number][] {
    const out: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= t.length; i++) {
        const inWord = i < t.length && isWordChar(t, i);
        if (inWord && start < 0) start = i;
        if (!inWord && start >= 0) {
            out.push([start, i]);
            start = -1;
        }
    }
    return out;
}

describe('what counts as a word', () => {
    it('is letters, digits and marks, and the break of a word hyphenated across lines', () => {
        expect(words('The naïve ét, 42.')).toEqual([
            [0, 3],
            [4, 9],
            [10, 13],
            [15, 17],
        ]);
        expect(words('a ta-\nble b')).toEqual([
            [0, 1],
            [2, 9],
            [10, 11],
        ]);
        // A hyphen within a line, a dash before a break, and a break without a hyphen all end a word.
        expect(words('well-known x -\ny a\nb').map(([s, e]) => 'well-known x -\ny a\nb'.slice(s, e))).toEqual(['well', 'known', 'x', 'y', 'a', 'b']);
    });
});

describe('nextWordEnd', () => {
    it('goes forward to a word end, the first one after the position, and stays only when there is none', () => {
        assert(
            property(at, ([t, i]) => {
                const ends = words(t).map(w => w[1]);
                const expected = ends.find(e => e > i) ?? i;
                expect(nextWordEnd(t, i)).toBe(expected);
            }),
        );
    });

    it('pressed again and again visits every word end once, in order', () => {
        assert(
            property(text, t => {
                const visited: number[] = [];
                for (let i = 0, j = nextWordEnd(t, 0); j !== i; i = j, j = nextWordEnd(t, i)) visited.push(j);
                expect(visited).toEqual(words(t).map(w => w[1]));
            }),
        );
    });
});

describe('prevWordStart', () => {
    it('goes backward to a word start, the last one before the position, and stays only when there is none', () => {
        assert(
            property(at, ([t, i]) => {
                const starts = words(t).map(w => w[0]);
                const expected = starts.findLast(s => s < i) ?? i;
                expect(prevWordStart(t, i)).toBe(expected);
            }),
        );
    });

    it('undoes nextWordEnd to the start of that same word', () => {
        assert(
            property(at, ([t, i]) => {
                const end = nextWordEnd(t, i);
                if (end === i) return;
                const word = words(t).find(w => w[1] === end);
                expect(prevWordStart(t, end)).toBe(word?.[0]);
            }),
        );
    });
});

describe('extendByWord (Ctrl+Shift+Left/Right)', () => {
    it('from a word, k presses forward select exactly that word and the next k words', () => {
        assert(
            property(text, nat({ max: 40 }), nat({ max: 6 }), (t, pick, k) => {
                const all = words(t);
                pre(all.length > 0);
                const first = pick % all.length;
                const [anchor, end] = all[first] ?? [0, 0];
                let focus = end;
                for (let n = 0; n < k; n++) focus = extendByWord(t, anchor, focus, true);
                expect(focus).toBe(all[Math.min(first + k, all.length - 1)]?.[1]);
            }),
        );
    });

    it('from a word selected backward, k presses backward select exactly that word and the k words before it', () => {
        assert(
            property(text, nat({ max: 40 }), nat({ max: 6 }), (t, pick, k) => {
                const all = words(t);
                pre(all.length > 0);
                const first = pick % all.length;
                const [start, anchor] = all[first] ?? [0, 0];
                let focus = start;
                for (let n = 0; n < k; n++) focus = extendByWord(t, anchor, focus, false);
                expect(focus).toBe(all[Math.max(first - k, 0)]?.[0]);
            }),
        );
    });

    it('moves the end the way asked or not at all, never onto the anchor, and stops tight on a word', () => {
        assert(
            property(at, nat({ max: 200 }), boolean(), ([t, focus], a, forward) => {
                const anchor = a % (t.length + 1);
                pre(anchor !== focus);
                const to = extendByWord(t, anchor, focus, forward);
                expect(to).not.toBe(anchor);
                if (forward) expect(to).toBeGreaterThanOrEqual(focus);
                else expect(to).toBeLessThanOrEqual(focus);
                if (to === focus) return;
                // The selection's later end is on a word's end, its earlier end on a word's start.
                const all = words(t);
                expect(all.some(w => (to > anchor ? w[1] : w[0]) === to)).toBe(true);
            }),
        );
    });

    it('moves whenever a word lies beyond both ends that way', () => {
        assert(
            property(at, nat({ max: 200 }), boolean(), ([t, focus], a, forward) => {
                const anchor = a % (t.length + 1);
                pre(anchor !== focus);
                const all = words(t);
                const beyond = forward ? all.some(w => w[1] > Math.max(anchor, focus)) : all.some(w => w[0] < Math.min(anchor, focus));
                if (beyond) expect(extendByWord(t, anchor, focus, forward)).not.toBe(focus);
            }),
        );
    });

    it('a step back after a step forward from a word end returns to that word end, and the other way round', () => {
        assert(
            property(text, nat({ max: 40 }), (t, pick) => {
                const all = words(t);
                pre(all.length > 1);
                const first = pick % (all.length - 1);
                const [start, end] = all[first] ?? [0, 0];
                expect(extendByWord(t, start, extendByWord(t, start, end, true), false)).toBe(end);
                const [nextStart, nextEnd] = all[first + 1] ?? [0, 0];
                expect(extendByWord(t, nextEnd, extendByWord(t, nextEnd, nextStart, false), true)).toBe(nextStart);
            }),
        );
    });
});

describe('wordBeside (Ctrl+Left/Right)', () => {
    it('from a selected word gives the next word, then the one after, and back again', () => {
        assert(
            property(text, nat({ max: 40 }), (t, pick) => {
                const all = words(t);
                pre(all.length > 0);
                const k = pick % all.length;
                const [start, end] = all[k] ?? [0, 0];
                const [ns, ne] = all[k + 1] ?? [start, end];
                const [ps, pe] = all[k - 1] ?? [start, end];
                expect(wordBeside(t, start, end, true)).toEqual({ start: ns, end: ne });
                expect(wordBeside(t, start, end, false)).toEqual({ start: ps, end: pe });
            }),
        );
    });

    it('gives a whole word that lies beyond the selection, or leaves the selection as it is', () => {
        assert(
            property(at, nat({ max: 200 }), boolean(), ([t, a], b, forward) => {
                const other = b % (t.length + 1);
                const start = Math.min(a, other);
                const end = Math.max(a, other);
                const got = wordBeside(t, start, end, forward);
                if (got.start === start && got.end === end) return;
                expect(words(t)).toContainEqual([got.start, got.end]);
                if (forward) expect(got.start).toBeGreaterThanOrEqual(end);
                else expect(got.end).toBeLessThanOrEqual(start);
            }),
        );
    });
});
