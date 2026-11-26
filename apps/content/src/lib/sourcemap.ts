import { backward, lineSegments, type PageBox, type SyncTex } from '@yukibana/papers-tex';

/** How the preview links its pages to source lines, whatever the engine: the boxes a source line shows in, and the
 *  source line under a point of a page. Coordinates are PDF points from a page's top-left; pages count from 1. */
export interface SourceMap {
    /** Where `file`'s `line` shows: one box per typeset line it covers, in page order. With `fallback`, the nearest
     *  line that shows anything when this one shows nothing (a blank line, a comment). */
    segments(file: string, line: number, fallback?: boolean): PageBox[];
    /** The source line under (`x`, `y`) on `page`, or null when nothing is known there. */
    backward(page: number, x: number, y: number): { file: string; line: number } | null;
}

/** The map of a TeX build: its SyncTeX file. */
export function syncTexMap(sync: SyncTex): SourceMap {
    return {
        segments: (file, line, fallback = true) => lineSegments(sync, file, line, fallback),
        backward: (page, x, y) => backward(sync, page, x, y),
    };
}

/** A run of text on a page, as the PDF's text layer has it: its string and its box (PDF points, top-left origin). */
export interface PageText {
    readonly page: number;
    /** Its index among the page's text items, which is its span's index in the text layer. */
    readonly run?: number;
    readonly str: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** The box of each character of `str` as the page draws its glyph (`charBoxes`), null for a character without a
     *  glyph of its own (a space between words); absent when the glyphs were not read. */
    readonly chars?: readonly (PageBox | null)[];
}

interface Word {
    readonly key: string;
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

interface SourceWord {
    readonly key: string;
    readonly file: string;
    readonly line: number;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** A word as both sides compare it: lower case, without accents' combining marks. */
function keyOf(w: string): string {
    return w.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of a Typst source line that can show in the document: comments, raw code (`#…` calls' names, labels,
 *  references' targets) and markup characters left out; the text of headings, emphasis, lists and maths kept. */
export function typstLineWords(line: string): string[] {
    const text = line
        .replace(/\/\/.*$/, '')
        .replace(/<[\w.:-]+>/g, ' ')
        .replace(/@[\w.:-]+/g, ' ')
        .replace(/#[\w.-]+/g, ' ')
        .replace(/\b(?:let|set|show|import|include|if|else|for|in|while|return)\b/g, ' ');
    return [...text.matchAll(WORD)].map(m => keyOf(m[0]));
}

/** The words of the text layer, in reading order, each with its own box (a run's width shared out by characters). */
function pageWords(texts: readonly PageText[]): Word[] {
    const out: Word[] = [];
    for (const t of texts) {
        if (!t.str || t.width <= 0) continue;
        const per = t.width / t.str.length;
        for (const m of t.str.matchAll(WORD)) {
            const i = m.index ?? 0;
            out.push({ key: keyOf(m[0]), page: t.page, x: t.x + i * per, y: t.y, width: m[0].length * per, height: t.height });
        }
    }
    return out;
}

/** How many of `a`'s words from `i` on match `b`'s from `j` on, in order, allowing a word of either side to be
 *  skipped once (a hyphenated break, a word the other side does not have). */
function agreement(a: readonly { key: string }[], i: number, b: readonly { key: string }[], j: number, span: number): number {
    let score = 0;
    let skips = 0;
    for (let n = 0; n < span && i < a.length && j < b.length; n++) {
        if (a[i]?.key === b[j]?.key) {
            score++;
            i++;
            j++;
        } else if (skips < 2 && a[i + 1]?.key === b[j]?.key) {
            skips++;
            i++;
        } else if (skips < 2 && a[i]?.key === b[j + 1]?.key) {
            skips++;
            j++;
        } else break;
    }
    return score;
}

/** The map of a build that gives no source map of its own (Typst's PDF export): words of the source matched to words
 *  of the text layer. A source line maps to where its run of words appears; a point maps to the source line whose words
 *  best continue the words around it. Good for prose, which is what one comments on; code-generated text maps nowhere.
 *
 *  Precondition: `texts` in reading order per page; `sources` the project's Typst files. */
export function textMap(texts: readonly PageText[], sources: ReadonlyMap<string, string>): SourceMap {
    const words = pageWords(texts);
    const src: SourceWord[] = [];
    const lineStart = new Map<string, number>();
    for (const [file, text] of sources) {
        text.split('\n').forEach((l, i) => {
            lineStart.set(`${file}:${i + 1}`, src.length);
            for (const key of typstLineWords(l)) src.push({ key, file, line: i + 1 });
        });
    }
    const byKey = new Map<string, number[]>();
    words.forEach((w, i) => {
        const list = byKey.get(w.key) ?? [];
        list.push(i);
        byKey.set(w.key, list);
    });
    const srcByKey = new Map<string, number[]>();
    src.forEach((w, i) => {
        const list = srcByKey.get(w.key) ?? [];
        list.push(i);
        srcByKey.set(w.key, list);
    });

    /** Boxes of `words[from..to)`, one per typeset line. */
    const boxes = (from: number, to: number): PageBox[] => {
        const out: PageBox[] = [];
        for (let i = from; i < to; i++) {
            const w = words[i];
            if (w === undefined) continue;
            const last = out.at(-1);
            if (last !== undefined && last.page === w.page && Math.abs(last.y - (w.y - w.height)) < w.height * 0.5) {
                out[out.length - 1] = { ...last, width: Math.max(last.width, w.x + w.width - last.x) };
            } else out.push({ page: w.page, x: w.x, y: w.y - w.height, width: w.width, height: w.height * 1.25 });
        }
        return out;
    };

    const segments = (file: string, line: number, fallback = true): PageBox[] => {
        const start = lineStart.get(`${file}:${line}`);
        if (start === undefined) return [];
        let end = start;
        while (end < src.length && src[end]?.file === file && src[end]?.line === line) end++;
        const count = end - start;
        if (count === 0) {
            if (!fallback) return [];
            // The next line with words, then the previous one.
            for (let d = 1; d < 40; d++) {
                for (const l of [line + d, line - d]) {
                    const s = lineStart.get(`${file}:${l}`);
                    if (s === undefined || src[s]?.file !== file || src[s]?.line !== l) continue;
                    const found = segments(file, l, false);
                    if (found.length) return found;
                }
            }
            return [];
        }
        // Anchor on the line's rarest word in the document, then score the run around it.
        let anchor = start;
        for (let i = start; i < end; i++) if ((byKey.get(src[i]?.key ?? '')?.length ?? 1e9) < (byKey.get(src[anchor]?.key ?? '')?.length ?? 1e9)) anchor = i;
        let best = { score: 0, at: -1 };
        for (const j of byKey.get(src[anchor]?.key ?? '') ?? []) {
            const at = j - (anchor - start);
            if (at < 0) continue;
            const score = agreement(src, start, words, at, count + 2);
            if (score > best.score) best = { score, at };
        }
        if (best.at < 0 || best.score < Math.min(2, count)) return [];
        return boxes(best.at, best.at + count);
    };

    const pointToSource = (page: number, x: number, y: number): { file: string; line: number } | null => {
        // The word under the point: on the text line containing y, the last one starting left of x.
        let hit = -1;
        words.forEach((w, i) => {
            if (w.page !== page || y < w.y - w.height * 1.1 || y > w.y + w.height * 0.4) return;
            if (w.x <= x + 1 && (hit < 0 || w.x >= (words[hit]?.x ?? 0))) hit = i;
        });
        if (hit < 0) return null;
        // The source position whose words best agree with the words from a few before the hit on.
        const from = Math.max(0, hit - 3);
        let best = { score: 0, i: -1 };
        for (const i of srcByKey.get(words[hit]?.key ?? '') ?? []) {
            const at = i - (hit - from);
            if (at < 0) continue;
            const score = agreement(words, from, src, at, 8);
            if (score > best.score) best = { score, i };
        }
        const s = src[best.i];
        return s === undefined || best.score < 2 ? null : { file: s.file, line: s.line };
    };

    return { segments, backward: pointToSource };
}
