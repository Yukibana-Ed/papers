import type { PageBox } from '@yukibana/papers-tex';
import type { PreciseMap, SourceAt, SourceHit } from '#lib/precise.ts';

/** What our build of the Typst compiler says of a compiled document (`glyph_spans`, packages/typst-wasm): for each
 *  glyph that came from a file of the project, where it is on its page and what range of the source it was typeset
 *  from. Exact where aligning the document's words with the source's (precise.ts) is a guess. */
export interface GlyphSpans {
    /** The source files' project paths. */
    readonly files: readonly string[];
    /** Per page, `SPAN_FIELDS` numbers per glyph, in paint order: the baseline's start `x0 y0` and end `x1 y1` (pt
     *  from the page's top-left), the font size (pt), the file's index in `files`, the source range `start end`
     *  (UTF-16 code units), and 1 when the range is the glyph's own characters, 0 when it is the whole syntax node
     *  that made the glyph (a heading's number, a reference). */
    readonly pages: readonly Float64Array[];
}

export const SPAN_FIELDS = 9;

/** The spans as the compiler hands them over: each page's numbers as little-endian bytes.
 *  Precondition: each page's length is a multiple of `8 * SPAN_FIELDS`. */
export function readSpans(raw: { readonly files: readonly string[]; readonly pages: readonly Uint8Array[] }): GlyphSpans {
    // Copied: the bytes may sit at an offset no Float64Array can start at, and little-endian is every browser's order.
    return { files: [...raw.files], pages: raw.pages.map(p => new Float64Array(p.slice().buffer)) };
}

interface Glyph {
    readonly box: PageBox;
    readonly file: string;
    readonly start: number;
    readonly end: number;
    readonly exact: boolean;
}

/** How far above the baseline a glyph's box starts and how tall it is, as shares of the font size: a line of text. */
const ASCENT = 0.8;
const HEIGHT = 1.05;

/** Line starts of `text` as UTF-16 offsets, for positions by line and column. */
function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    return starts;
}

/** A `PreciseMap` read off `spans`, for the document compiled from `sources` (path → text, as compiled).
 *  Positions it cannot give (text the document does not show, a point far from any glyph) are null, as with the
 *  aligned map; `charToSource` is always null: callers then ask by the character's place on the page. */
export function spansMap(spans: GlyphSpans, sources: ReadonlyMap<string, string>): PreciseMap {
    const starts = new Map<string, number[]>();
    const startsOf = (file: string): number[] | null => {
        let s = starts.get(file);
        if (s === undefined) {
            const text = sources.get(file);
            if (text === undefined) return null;
            s = lineStarts(text);
            starts.set(file, s);
        }
        return s;
    };
    const offsetOf = (at: SourceAt): number | null => {
        const s = startsOf(at.file);
        const line = s?.[at.line - 1];
        return line === undefined ? null : line + at.column;
    };
    /** The line (1-based) and column of `offset` in `file`, and the offset where that line ends. */
    const placeOf = (file: string, offset: number): { line: number; column: number; lineEnd: number } | null => {
        const s = startsOf(file);
        if (s === null) return null;
        let lo = 0;
        let hi = s.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((s[mid] ?? 0) <= offset) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo + 1, column: offset - (s[lo] ?? 0), lineEnd: (s[lo + 1] ?? (sources.get(file)?.length ?? 0) + 1) - 1 };
    };

    const byPage: Glyph[][] = [];
    const byFile = new Map<string, Glyph[]>();
    spans.pages.forEach((numbers, p) => {
        const glyphs: Glyph[] = [];
        for (let k = 0; k + SPAN_FIELDS <= numbers.length; k += SPAN_FIELDS) {
            const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, size = 0, fileIndex = -1, start = 0, end = 0, exact = 0] = numbers.subarray(k, k + SPAN_FIELDS);
            const file = spans.files[fileIndex];
            if (file === undefined || !(end > start)) continue;
            // Around the baseline, a line of text high: right for upright text, and a fair box for turned text.
            const top = Math.min(y0, y1) - size * ASCENT;
            const box: PageBox = { page: p + 1, x: Math.min(x0, x1), y: top, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) + size * HEIGHT };
            const g: Glyph = { box, file, start, end, exact: exact === 1 };
            glyphs.push(g);
            const list = byFile.get(file);
            if (list === undefined) byFile.set(file, [g]);
            else list.push(g);
        }
        byPage.push(glyphs);
    });
    for (const list of byFile.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);

    /** The glyph for source `offset` of `file`: the one typeset from that character, else the narrowest node around
     *  it that made a glyph, else the next glyph before `lineEnd`, else the previous one from `lineStart` on. */
    const glyphAt = (file: string, offset: number, lineStart: number, lineEnd: number): Glyph | null => {
        const list = byFile.get(file);
        if (list === undefined) return null;
        let own: Glyph | null = null;
        let around: Glyph | null = null;
        let next: Glyph | null = null;
        let previous: Glyph | null = null;
        for (const g of list) {
            if (g.start <= offset && offset < g.end) {
                if (g.exact) own ??= g;
                else if (around === null || g.end - g.start < around.end - around.start) around = g;
            } else if (g.start > offset && g.start < lineEnd) next ??= g;
            else if (g.end <= offset && g.start >= lineStart) previous = g;
        }
        return own ?? around ?? next ?? previous;
    };

    const hit = (g: Glyph): SourceHit | null => {
        const at = placeOf(g.file, g.start);
        if (at === null) return null;
        const length = Math.min(g.end, at.lineEnd) - g.start;
        // One character typeset as one glyph is exact; a ligature or a node's glyph stands for its whole range.
        return { file: g.file, line: at.line, column: at.column, start: at.column, length, exact: g.exact && length === 1 };
    };

    return {
        locate(at) {
            const offset = offsetOf(at);
            const s = startsOf(at.file);
            if (offset === null || s === null) return null;
            const lineStart = s[at.line - 1] ?? 0;
            const lineEnd = (s[at.line] ?? (sources.get(at.file)?.length ?? 0) + 1) - 1;
            return glyphAt(at.file, offset, lineStart, lineEnd)?.box ?? null;
        },
        range(start, end) {
            const from = offsetOf(start);
            const to = offsetOf(end);
            if (from === null || to === null || start.file !== end.file) return null;
            const out: PageBox[] = [];
            for (const g of byFile.get(start.file) ?? []) {
                // A character's glyph when the range touches it; a node's glyph when the range holds the whole node.
                if (g.exact ? g.start < to && g.end > from : g.start >= from && g.end <= to) out.push(g.box);
            }
            return out.length === 0 ? null : out;
        },
        pointToSource(page, x, y) {
            let best: Glyph | null = null;
            let bestDistance = Infinity;
            for (const g of byPage[page - 1] ?? []) {
                const b = g.box;
                // On the glyph's own line only; sideways, the nearest glyph within two line heights.
                if (y < b.y || y > b.y + b.height) continue;
                const dx = x < b.x ? b.x - x : x > b.x + b.width ? x - b.x - b.width : 0;
                if (dx < bestDistance && dx <= 2 * b.height) {
                    best = g;
                    bestDistance = dx;
                }
            }
            return best === null ? null : hit(best);
        },
        charToSource: () => null,
    };
}
