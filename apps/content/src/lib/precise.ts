import type { PageBox } from '@yukibana/papers-tex';
import { align, keyOf, latexTokens, typstTokens, type SourceToken } from '#lib/align.ts';
import type { PageText, SourceMap } from '#lib/sourcemap.ts';

/** A word the document shows, from the PDF's text: its key, its text as shown, and its boxes in PDF points from the
 *  page's top-left (two when a hyphenated word breaks across lines: the part before the break, then the one after). */
export interface DocWord {
    readonly key: string;
    readonly text: string;
    /** From its glyphs where they are known (`chars`). Otherwise first from shares of its run's width, which the viewer
     *  replaces with the text layer's own boxes once a page's text layer is drawn (`refineWords`). */
    readonly parts: PageBox[];
    /** The box of each character of `text` as the page draws its glyph, when every one is known: exact, where shares
     *  of a width are not. */
    readonly chars?: readonly PageBox[];
    /** Where its first part's characters are in the text layer: the page, the run (its span) and the offset there. */
    readonly at?: { readonly page: number; readonly run: number; readonly offset: number };
}

/** A source position, 1-based line, 0-based column. */
export interface SourceAt {
    readonly file: string;
    readonly line: number;
    readonly column: number;
}

/** Where a point of the document comes from: the word in the source (`start`, `length`) and the column of the
 *  character under the point, which is `start` unless the source spells the word as shown (`exact`). */
export interface SourceHit extends SourceAt {
    readonly start: number;
    readonly length: number;
    readonly exact: boolean;
}

/** The preview's sync to the word: positions in the source to boxes on the pages and back, through an alignment of
 *  the source's words with the document's around the line the coarse map (SyncTeX, or the text map of a Typst build)
 *  points at. Every method returns null when the alignment does not pair the word in question; callers then fall back
 *  to the coarse map's lines, so a position is either right to the word or not given. */
export interface PreciseMap {
    /** The box of the word at `at` (of the character, when the source spells the word as shown), or null. A column
     *  between words takes the next word on its line, else the previous one. */
    locate(at: SourceAt): PageBox | null;
    /** The boxes of the text from `start` to `end` (exclusive), word by word, trimmed to the characters at either end
     *  where the source spells those words as shown; null when either end has no paired word. */
    range(start: SourceAt, end: SourceAt): PageBox[] | null;
    /** The source of the word under (`x`, `y`) on `page`, to the character where the source spells it as shown. */
    pointToSource(page: number, x: number, y: number): SourceHit | null;
    /** The source of character `offset` of text run `run` on `page` (a text-layer span and an offset in its text):
     *  exact where geometry is not, since a run's glyphs are not all the same width. */
    charToSource(page: number, run: number, offset: number): SourceHit | null;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The smallest box around `boxes`, between `top` and `top + height`. Precondition: `boxes` is not empty. */
function around(boxes: readonly PageBox[], top: number, height: number): PageBox {
    const x = Math.min(...boxes.map(b => b.x));
    return { page: boxes[0]?.page ?? 0, x, y: top, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height };
}

/** The document's words in reading order, from the text layer's runs: each word's box is around its glyphs where the
 *  run has them (`PageText.chars`), else its share of the run's width by its characters.
 *  A word that ends its run with a hyphen and goes on at the start of the next line is joined to that next word. */
export function docWords(texts: readonly PageText[]): DocWord[] {
    const out: { key: string; text: string; parts: PageBox[]; chars: PageBox[] | null; hyphen: boolean; y: number; at?: { page: number; run: number; offset: number } }[] = [];
    for (const t of texts) {
        if (!t.str || t.width <= 0) continue;
        const per = t.width / t.str.length;
        const top = t.y - t.height * 0.85;
        const matches = [...t.str.matchAll(WORD)];
        matches.forEach((m, k) => {
            const i = m.index ?? 0;
            const glyphs = t.chars?.slice(i, i + m[0].length).filter(b => b !== null) ?? [];
            const chars = glyphs.length === m[0].length ? glyphs : null;
            const box: PageBox = chars !== null ? around(chars, top, t.height * 1.1) : { page: t.page, x: t.x + i * per, y: top, width: m[0].length * per, height: t.height * 1.1 };
            const prev = out.at(-1);
            if (k === 0 && prev !== undefined && prev.hyphen && (box.page !== prev.parts[0]?.page || box.y > prev.y + t.height * 0.5)) {
                prev.key += keyOf(m[0]);
                prev.text += m[0];
                prev.parts.push(box);
                prev.chars = prev.chars !== null && chars !== null ? [...prev.chars, ...chars] : null;
                prev.hyphen = false;
                return;
            }
            const after = t.str.slice(i + m[0].length);
            const hyphen = k === matches.length - 1 && /^[-‐‑]\s*$/.test(after);
            const at = t.run === undefined ? undefined : { page: t.page, run: t.run, offset: i };
            out.push({ key: keyOf(m[0]), text: m[0], parts: [box], chars, hyphen, y: top, ...(at === undefined ? {} : { at }) });
        });
    }
    return out.map(({ key, text, parts, chars, at }): DocWord => {
        const word = { key, text, parts };
        return Object.assign(word, chars === null ? {} : { chars }, at === undefined ? {} : { at });
    });
}

/** Replaces the boxes of `page`'s one-part words without glyph boxes with `boxOf(run, from, to)`: the box of
 *  characters [`from`, `to`) of text run `run`, in PDF points from the page's top-left, or null where it cannot say.
 *  Hyphenated words keep their shares. */
export function refineWords(words: readonly DocWord[], page: number, boxOf: (run: number, from: number, to: number) => PageBox | null): void {
    for (const w of words) {
        if (w.chars !== undefined || w.at === undefined || w.at.page !== page || w.parts.length !== 1) continue;
        const box = boxOf(w.at.run, w.at.offset, w.at.offset + w.text.length);
        if (box !== null) w.parts[0] = box;
    }
}

/** How many lines either side of the one in question take part in its alignment: a paragraph's source lines and
 *  typeset lines rarely break at the same places. */
const CONTEXT = 3;

/** How many lines after one the coarse map does not know are looked at for the line that typeset it. */
const READ_AHEAD = 200;

/** The first line after `line` (1-based) of the LaTeX `source` that closes an environment `line` is in and that
 *  `known` accepts, within `READ_AHEAD` lines; null when there is none before the document's own end. */
export function closingLine(source: string, line: number, known: (line: number) => boolean): number | null {
    const lines = source.split('\n');
    let depth = 0;
    for (let next = line + 1; next <= Math.min(lines.length, line + READ_AHEAD); next++) {
        let closes = false;
        for (const m of (lines[next - 1] ?? '').replace(/(?<!\\)%.*$/, '').matchAll(/\\(begin|end)\{([^}]*)\}/g)) {
            if (m[1] === 'begin') depth++;
            else if (m[2] === 'document') return null;
            else if (--depth < 0) closes = true;
        }
        if (closes && known(next)) return next;
    }
    return null;
}

/** Bands of typeset lines closer sideways than this (PDF points) are of one column: less than the space between two. */
const COLUMN_GAP = 4;

/** How many words in a row a search over the whole document needs to agree on. */
const FAR_RUN = 3;

/** `sorted` (increasing integers) cut into its runs of consecutive numbers. */
function runsOf(sorted: readonly number[]): number[][] {
    const out: number[][] = [];
    for (const i of sorted) {
        const run = out.at(-1);
        if (run !== undefined && run.at(-1) === i - 1) run.push(i);
        else out.push([i]);
    }
    return out;
}

/** Pairs (index into `keys`, index into `words`) for the stretches of `keys` that `words` shows: at least `FAR_RUN`
 *  keys in a row equal to words in a row none of which is in `used`, where those words' keys appear in a row nowhere
 *  else in `words`. The longest such stretch is taken first; a key is paired at most once.
 *  Precondition: `starts` has, for each key, the indices of the words of that key, increasing.
 *  Promises: a stretch the document shows in two places is not paired with either. */
function soleRuns(
    keys: readonly string[],
    words: readonly { readonly key: string }[],
    starts: ReadonlyMap<string, readonly number[]>,
    used: ReadonlySet<number>,
): [number, number][] {
    const out: [number, number][] = [];
    /** How many keys from `a` on equal the words from `d` on. */
    const length = (a: number, d: number, most: number): number => {
        let n = 0;
        while (n < most && a + n < keys.length && keys[a + n] === words[d + n]?.key) n++;
        return n;
    };
    const taken = new Set<number>();
    const search = (from: number, to: number): void => {
        if (to - from < FAR_RUN) return;
        let best: { a: number; d: number; n: number } | null = null;
        for (let a = from; a + FAR_RUN <= to; a++) {
            for (const d of starts.get(keys[a] ?? '') ?? []) {
                const n = length(a, d, to - a);
                if (n >= FAR_RUN && (best === null || n > best.n)) best = { a, d, n };
            }
        }
        if (best === null) return;
        const { a, d, n } = best;
        const places = (starts.get(keys[a] ?? '') ?? []).filter(e => length(a, e, n) === n).length;
        let free = true;
        for (let k = 0; k < n; k++) free &&= !used.has(d + k) && !taken.has(d + k);
        if (places === 1 && free) {
            for (let k = 0; k < n; k++) {
                out.push([a + k, d + k]);
                taken.add(d + k);
            }
        }
        search(from, a);
        search(a + n, to);
    };
    search(0, keys.length);
    return out.toSorted((x, y) => x[0] - y[0]);
}

/** A `PreciseMap` over `coarse`, for a build whose document shows `words` and whose sources are `sources` (path →
 *  text). Only the files of the build's `format` take part (`.tex` for LaTeX, `.typ` for Typst): a project may hold
 *  both, and the other kind's words must not pair with this document's. */
export function preciseMap(coarse: SourceMap, words: readonly DocWord[], sources: ReadonlyMap<string, string>, format: 'latex' | 'typst'): PreciseMap {
    const tokensOf = new Map<string, SourceToken[]>();
    const tokens = (file: string): SourceToken[] => {
        let t = tokensOf.get(file);
        if (t === undefined) {
            const text = sources.get(file);
            t = text === undefined ? [] : format === 'typst' ? (file.endsWith('.typ') ? typstTokens(text) : []) : file.endsWith('.tex') ? latexTokens(text) : [];
            tokensOf.set(file, t);
        }
        return t;
    };

    /** The document words on the typeset lines that show `file`'s lines `from`..`to`, in reading order. */
    const wordsShowing = (file: string, from: number, to: number): number[] => {
        // Only where lines with words show: the coarse map puts a whole paragraph on the line that ends it too, and
        // a blank line after the paragraph before would bring that paragraph's words in.
        const worded = new Set<number>();
        for (const t of tokens(file)) if (t.line >= from && t.line <= to) worded.add(t.line);
        const bands: PageBox[] = [];
        for (const l of worded) {
            const own = coarse.segments(file, l, false);
            bands.push(...own);
            if (own.length > 0) continue;
            // A line the coarse map does not know was read ahead as an argument (a beamer frame's body, by its
            // `\end{frame}`): its words show where the end of an environment around it does.
            const end = format === 'latex' ? closingLine(sources.get(file) ?? '', l, next => coarse.segments(file, next, false).length > 0) : null;
            if (end !== null) bands.push(...coarse.segments(file, end, false));
        }
        if (bands.length === 0) return [];
        // A band is a part of a typeset line; the line is as wide as its column. The bands of a page that touch
        // sideways make up a column: the words level with a band in its column show there, and not those level
        // with it in the column beside.
        const columns = new Map<number, { left: number; right: number }[]>();
        for (const page of new Set(bands.map(b => b.page))) {
            const spans: { left: number; right: number }[] = [];
            for (const b of bands.filter(k => k.page === page).toSorted((p, q) => p.x - q.x)) {
                const last = spans.at(-1);
                if (last !== undefined && b.x <= last.right + COLUMN_GAP) last.right = Math.max(last.right, b.x + b.width);
                else spans.push({ left: b.x, right: b.x + b.width });
            }
            columns.set(page, spans);
        }
        const columnOf = (b: PageBox): { left: number; right: number } | undefined => columns.get(b.page)?.find(c => b.x >= c.left - 0.5 && b.x <= c.right + 0.5);
        const out: number[] = [];
        words.forEach((w, i) => {
            const first = w.parts[0];
            if (first === undefined) return;
            const mid = first.y + first.height / 2;
            const centre = first.x + first.width / 2;
            const shows = bands.some(b => {
                if (b.page !== first.page || mid < b.y || mid > b.y + b.height) return false;
                const column = columnOf(b);
                return column === undefined || (centre >= column.left - COLUMN_GAP && centre <= column.right + COLUMN_GAP);
            });
            if (shows) out.push(i);
        });
        return out;
    };

    let byKey: Map<string, number[]> | null = null;
    /** The indices of the document's words, by key. */
    const wordsOfKey = (): Map<string, number[]> => {
        if (byKey === null) {
            byKey = new Map();
            for (const [i, w] of words.entries()) {
                const list = byKey.get(w.key);
                if (list === undefined) byKey.set(w.key, [i]);
                else list.push(i);
            }
        }
        return byKey;
    };

    const cache = new Map<string, Map<number, number>>();
    /** Source token index (in `tokens(file)`) → document word index, for the tokens of lines around `line`. */
    const pairsAround = (file: string, line: number): Map<number, number> => {
        const id = `${file}\n${line}`;
        const hit = cache.get(id);
        if (hit !== undefined) return hit;
        const all = tokens(file);
        const from = Math.max(1, line - CONTEXT);
        const to = line + CONTEXT;
        const src: number[] = [];
        all.forEach((t, i) => {
            if (t.line >= from && t.line <= to) src.push(i);
        });
        const doc = wordsShowing(file, from, to);
        const pairs = new Map<number, number>();
        for (const [a, b] of align(
            src.map(i => all[i] ?? { key: '' }),
            doc.map(i => words[i] ?? { key: '' }),
        )) {
            const s = src[a];
            const d = doc[b];
            if (s !== undefined && d !== undefined) pairs.set(s, d);
        }
        // The unpaired tokens around `line` (a footnote's text sits in its paragraph's source but at the foot of
        // the page) are looked for in the whole document, where a word alone proves nothing: only three or more
        // tokens in a row that the document shows as words in a row, in one place only, are paired.
        const lone = src.filter(i => !pairs.has(i));
        if (lone.some(i => all[i]?.line === line)) {
            const used = new Set(pairs.values());
            for (const run of runsOf(lone)) {
                if (run.length < FAR_RUN) continue;
                for (const [a, d] of soleRuns(
                    run.map(i => all[i]?.key ?? ''),
                    words,
                    wordsOfKey(),
                    used,
                )) {
                    const s = run[a];
                    if (s !== undefined) pairs.set(s, d);
                }
            }
        }
        cache.set(id, pairs);
        return pairs;
    };

    /** The token at or after `column` on `line` (else the last before it), as an index into `tokens(file)`. */
    const tokenAt = (file: string, line: number, column: number): number | null => {
        const all = tokens(file);
        let before: number | null = null;
        for (let i = 0; i < all.length; i++) {
            const t = all[i];
            if (t === undefined || t.line < line) continue;
            if (t.line > line) break;
            if (column < t.end) return i;
            before = i;
        }
        return before;
    };

    /** The part of `word` that holds its character `k`, cut to the characters from `k` to `upTo` (exclusive) that are
     *  in that part: around their glyphs where known, else by shares of the part's width. */
    const charBox = (word: DocWord, k: number, upTo: number): PageBox | null => {
        const first = word.chars?.[k];
        if (word.chars !== undefined && first !== undefined) {
            const part = word.parts.find(
                p =>
                    p.page === first.page &&
                    first.x + first.width / 2 >= p.x &&
                    first.x + first.width / 2 <= p.x + p.width &&
                    first.y < p.y + p.height &&
                    first.y + first.height > p.y,
            );
            if (part !== undefined) {
                const inPart = word.chars.slice(k, Math.max(k + 1, upTo)).filter(c => c.page === part.page && c.y < part.y + part.height && c.y + c.height > part.y);
                return around(inPart.length > 0 ? inPart : [first], part.y, part.height);
            }
        }
        let offset = 0;
        for (const p of word.parts) {
            // A part's share of the word's characters, by width.
            const total = word.parts.reduce((a, q) => a + q.width, 0);
            const chars = Math.round((p.width / total) * word.text.length);
            if (k < offset + chars) {
                const per = p.width / Math.max(1, chars);
                const a = k - offset;
                const b = Math.min(chars, upTo - offset);
                return { ...p, x: p.x + a * per, width: Math.max(per, (b - a) * per) };
            }
            offset += chars;
        }
        return null;
    };

    /** Whether the token spells the word as shown, so character offsets carry over. */
    const sameSpelling = (t: SourceToken, w: DocWord): boolean => t.exact && t.end - t.start === w.text.length;

    const placed = (at: SourceAt): { token: SourceToken; word: DocWord; index: number } | null => {
        const ti = tokenAt(at.file, at.line, at.column);
        if (ti === null) return null;
        const token = tokens(at.file)[ti];
        const di = pairsAround(at.file, at.line).get(ti);
        const word = di === undefined ? undefined : words[di];
        if (token === undefined || word === undefined || di === undefined) return null;
        return { token, word, index: di };
    };

    /** The source of document word `hit` (under (`x`, `y`) on `page`) if the alignment around `file`'s `line` pairs it. */
    function pairedAt(file: string, line: number, hit: number, word: DocWord, k: number | null): SourceHit | null {
        const pairs = pairsAround(file, line);
        for (const [ti, di] of pairs) {
            if (di !== hit) continue;
            const token = tokens(file)[ti];
            if (token === undefined) return null;
            let column = token.start;
            const exact = sameSpelling(token, word) && word.parts.length === 1;
            if (exact && k !== null) column += Math.min(word.text.length - 1, Math.max(0, k));
            return { file, line: token.line, column, start: token.start, length: token.end - token.start, exact };
        }
        return null;
    }

    /** The source of document word `hit` (whose box holds (`x`, `y`) on `page`), and of its character `k` if known:
     *  first through the line the coarse map points at, then through every line with a word of the same key. */
    function sourceOf(hit: number, word: DocWord, k: number | null, page: number, x: number, y: number): SourceHit | null {
        const near = coarse.backward(page, x, y);
        const candidates: { file: string; line: number }[] = near === null ? [] : [{ file: near.file, line: near.line }];
        for (const [file] of sources) for (const t of tokens(file)) if (t.key === word.key) candidates.push({ file, line: t.line });
        for (const c of candidates) {
            const found = pairedAt(c.file, c.line, hit, word, k);
            if (found !== null) return found;
        }
        return null;
    }

    return {
        locate(at) {
            const p = placed(at);
            if (p === null) return null;
            const inside = at.column >= p.token.start && at.column < p.token.end;
            if (inside && sameSpelling(p.token, p.word)) return charBox(p.word, at.column - p.token.start, at.column - p.token.start + 1);
            return p.word.parts[0] ?? null;
        },

        range(start, end) {
            const a = placed(start);
            // The end is exclusive: the last character is the one before it.
            const b = placed({ ...end, column: Math.max(0, end.column - 1) });
            if (a === null || b === null || b.index < a.index) return null;
            const out: PageBox[] = [];
            for (let i = a.index; i <= b.index; i++) {
                const w = words[i];
                if (w === undefined) continue;
                const from = i === a.index && sameSpelling(a.token, w) ? Math.max(0, start.column - a.token.start) : 0;
                const to = i === b.index && sameSpelling(b.token, w) ? Math.min(w.text.length, end.column - b.token.start) : w.text.length;
                if (from === 0 && to === w.text.length) out.push(...w.parts);
                else {
                    const box = charBox(w, from, to);
                    if (box !== null) out.push(box);
                }
            }
            return out;
        },

        pointToSource(page, x, y) {
            // The word under the point: the one whose box holds it, else the nearest on that text line within a space.
            let hit = -1;
            let gap = Infinity;
            words.forEach((w, i) => {
                for (const p of w.parts) {
                    if (p.page !== page || y < p.y || y > p.y + p.height) continue;
                    const d = x < p.x ? p.x - x : x > p.x + p.width ? x - p.x - p.width : 0;
                    if (d < gap) {
                        gap = d;
                        hit = i;
                    }
                }
            });
            const word = words[hit];
            if (word === undefined || gap > 3) return null;
            // The character under the point: the last glyph that starts at or before it, else by its share of the
            // word's width.
            const part = word.parts.length === 1 ? word.parts[0] : undefined;
            const k =
                part === undefined
                    ? null
                    : word.chars !== undefined
                      ? Math.max(
                            0,
                            word.chars.findLastIndex(c => c.x <= x),
                        )
                      : Math.floor(((x - part.x) / part.width) * word.text.length);
            return sourceOf(hit, word, k, page, x, y);
        },

        charToSource(page, run, offset) {
            const hit = words.findIndex(w => w.at !== undefined && w.at.page === page && w.at.run === run && offset >= w.at.offset && offset < w.at.offset + w.text.length);
            const word = words[hit];
            const box = word?.parts[0];
            if (word === undefined || word.at === undefined || box === undefined) return null;
            return sourceOf(hit, word, word.parts.length === 1 ? offset - word.at.offset : null, box.page, box.x + box.width / 2, box.y + box.height / 2);
        },
    };
}
