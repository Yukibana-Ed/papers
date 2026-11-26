import { OPS, type PDFPageProxy } from 'pdfjs-dist';
import type { PageBox } from '@yukibana/papers-tex';
import type { PageText } from '#lib/sourcemap.ts';

/** A glyph the page shows: the text it stands for (two letters for a ligature) and the box of its advance, from its
 *  origin to the next glyph's, between the font's ascent and descent, in PDF points from the page's top-left. */
export interface Glyph {
    readonly text: string;
    readonly box: PageBox;
    /** With `ink`: the box of the glyph's ink, from the font's own outline (`measureText`), for checking the positions
     *  against what the canvas drew. */
    readonly ink?: PageBox;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** What a font object from PDF.js's `commonObjs` holds that placing glyphs needs. */
interface FontInfo {
    readonly loadedName?: string;
    readonly fontMatrix?: readonly number[];
    readonly ascent?: number;
    readonly descent?: number;
    readonly vertical?: boolean;
}

/** A glyph of a `showText` operation, as PDF.js's operator list has it. */
interface OpGlyph {
    readonly fontChar?: string;
    readonly unicode: string;
    readonly width: number;
    readonly isSpace: boolean;
}

function isGlyph(g: unknown): g is OpGlyph {
    return typeof g === 'object' && g !== null && 'unicode' in g && 'width' in g;
}

/** The glyphs of `page`, in the order it draws them, placed as PDF.js's canvas renderer places them: the operator list's
 *  text operations replayed (text and line matrices, the current transformation matrix with form XObjects, font size
 *  and matrix, character and word spacing, horizontal scaling, rise, and TJ's adjustments), with each glyph's advance
 *  from the font's own widths. Exact where the renderer is: the same numbers make the same positions. Type 3 fonts and
 *  vertical writing are left out (TeX and Typst output has neither in body text). */
export async function pageGlyphs(page: PDFPageProxy, ink = false): Promise<Glyph[]> {
    const measure = ink ? new OffscreenCanvas(1, 1).getContext('2d') : null;
    const ops = await page.getOperatorList();
    const view = page.getViewport({ scale: 1 });
    const toPage = view.transform as unknown as Matrix;
    const out: Glyph[] = [];
    const font = (name: string): FontInfo | null => {
        try {
            const f: unknown = page.commonObjs.get(name);
            return typeof f === 'object' && f !== null ? (f as FontInfo) : null;
        } catch {
            return null;
        }
    };
    interface Text {
        font: FontInfo | null;
        size: number;
        charSpacing: number;
        wordSpacing: number;
        hScale: number;
        leading: number;
        rise: number;
    }
    let ctm: Matrix = IDENTITY;
    let text: Text = { font: null, size: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0 };
    const stack: { ctm: Matrix; text: Text }[] = [];
    let tm: Matrix = IDENTITY;
    let x = 0;
    let y = 0;
    let lineX = 0;
    let lineY = 0;
    const moveText = (dx: number, dy: number): void => {
        x = lineX += dx;
        y = lineY += dy;
    };
    const show = (glyphs: readonly unknown[]): void => {
        const f = text.font;
        if (f === null || f.vertical === true || text.size === 0) return;
        const widthScale = text.size * (f.fontMatrix?.[0] ?? 0.001);
        const ascent = (f.ascent ?? 0.8) * text.size;
        const descent = (f.descent ?? -0.2) * text.size;
        const m = multiply(ctm, multiply(tm, [1, 0, 0, 1, x, y + text.rise]));
        let at = 0;
        for (const g of glyphs) {
            if (typeof g === 'number') {
                at -= (g * text.size) / 1000;
                continue;
            }
            if (!isGlyph(g)) continue;
            const advance = g.width * widthScale;
            const spacing = (g.isSpace ? text.wordSpacing : 0) + text.charSpacing;
            const left = at * text.hScale;
            const right = (at + advance) * text.hScale;
            const boxOf = (x0: number, x1: number, y0: number, y1: number): PageBox => {
                const corners = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)].map(([px, py]) => apply(toPage, px, py));
                const xs = corners.map(c => c[0]);
                const ys = corners.map(c => c[1]);
                const bx = Math.min(...xs);
                const by = Math.min(...ys);
                return { page: page.pageNumber, x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by };
            };
            let inkBox: PageBox | undefined;
            if (measure !== null && g.fontChar !== undefined && f.loadedName !== undefined) {
                // The outline's extent at 100 px, scaled to the glyph's size in text space.
                measure.font = `100px "${f.loadedName}"`;
                const mt = measure.measureText(g.fontChar);
                const k = text.size / 100;
                inkBox = boxOf(left - mt.actualBoundingBoxLeft * k * text.hScale, left + mt.actualBoundingBoxRight * k * text.hScale, -mt.actualBoundingBoxDescent * k, mt.actualBoundingBoxAscent * k);
            }
            if (g.unicode !== '') out.push({ text: g.unicode, box: boxOf(left, right, descent, ascent), ...(inkBox === undefined ? {} : { ink: inkBox }) });
            at += advance + spacing;
        }
        x += at * text.hScale;
    };
    const { fnArray, argsArray } = ops;
    for (let i = 0; i < fnArray.length; i++) {
        const a: unknown[] = argsArray[i] ?? [];
        const num = (k: number): number => Number(a[k] ?? 0);
        switch (fnArray[i]) {
            case OPS.save:
                stack.push({ ctm, text: { ...text } });
                break;
            case OPS.restore: {
                const s = stack.pop();
                if (s !== undefined) ({ ctm, text } = s);
                break;
            }
            case OPS.transform:
                ctm = multiply(ctm, [num(0), num(1), num(2), num(3), num(4), num(5)]);
                break;
            case OPS.paintFormXObjectBegin: {
                stack.push({ ctm, text: { ...text } });
                const mat = a[0];
                if (Array.isArray(mat) && mat.length === 6) ctm = multiply(ctm, mat.map(Number) as unknown as Matrix);
                break;
            }
            case OPS.paintFormXObjectEnd: {
                const s = stack.pop();
                if (s !== undefined) ({ ctm, text } = s);
                break;
            }
            case OPS.beginText:
                tm = IDENTITY;
                x = y = lineX = lineY = 0;
                break;
            case OPS.setFont:
                text.font = font(String(a[0]));
                text.size = Math.abs(num(1));
                break;
            case OPS.setCharSpacing:
                text.charSpacing = num(0);
                break;
            case OPS.setWordSpacing:
                text.wordSpacing = num(0);
                break;
            case OPS.setHScale:
                text.hScale = num(0) / 100;
                break;
            case OPS.setLeading:
                text.leading = -num(0);
                break;
            case OPS.setTextRise:
                text.rise = num(0);
                break;
            case OPS.moveText:
                moveText(num(0), num(1));
                break;
            case OPS.setLeadingMoveText:
                text.leading = num(1);
                moveText(num(0), num(1));
                break;
            case OPS.setTextMatrix: {
                const mat = Array.isArray(a[0]) && a[0].length === 6 ? (a[0].map(Number) as unknown as Matrix) : ([num(0), num(1), num(2), num(3), num(4), num(5)] as const);
                tm = mat;
                x = y = lineX = lineY = 0;
                break;
            }
            case OPS.nextLine:
                moveText(0, text.leading);
                break;
            case OPS.showText:
            case OPS.showSpacedText:
                show(Array.isArray(a[0]) ? (a[0] as unknown[]) : []);
                break;
            case OPS.nextLineShowText:
                moveText(0, text.leading);
                show(Array.isArray(a[0]) ? (a[0] as unknown[]) : []);
                break;
            case OPS.nextLineSetSpacingShowText:
                text.wordSpacing = num(0);
                text.charSpacing = num(1);
                moveText(0, text.leading);
                show(Array.isArray(a[2]) ? (a[2] as unknown[]) : []);
                break;
        }
    }
    return out;
}

/** The box of every character of `texts` (one page's text runs, as the text layer has them), from `glyphs` (the same
 *  page's, in drawing order): runs and glyphs are walked together, matching characters; a ligature's box is shared
 *  out among its letters; characters no glyph shows (the spaces text extraction puts between words) get none.
 *  Returns, per run index in `texts`, an array as long as its string. */
export function charBoxes(texts: readonly PageText[], glyphs: readonly Glyph[]): (PageBox | null)[][] {
    const norm = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '');
    const out: (PageBox | null)[][] = texts.map(t => Array.from({ length: t.str.length }, () => null));
    let g = 0;
    let inGlyph = 0;
    for (let r = 0; r < texts.length; r++) {
        const t = texts[r];
        const row = out[r];
        if (t === undefined || row === undefined) continue;
        for (let i = 0; i < t.str.length; i++) {
            const ch = norm(t.str[i] ?? '');
            if (/^\s*$/.test(ch)) continue;
            // Find the glyph that shows this character: the current one if it has more letters, else the next ones
            // (skipping a few glyphs the text does not have, like a lone space glyph).
            const from = g;
            const fromIn = inGlyph;
            let found = false;
            for (let tries = 0; tries < 4 && g < glyphs.length; tries++) {
                const glyph = glyphs[g];
                const letters = norm(glyph?.text ?? '');
                if (glyph !== undefined && letters.slice(inGlyph).startsWith(ch)) {
                    const share = glyph.box.width / Math.max(1, letters.length);
                    row[i] = { ...glyph.box, x: glyph.box.x + share * inGlyph, width: share * ch.length };
                    inGlyph += ch.length;
                    if (inGlyph >= letters.length) {
                        g++;
                        inGlyph = 0;
                    }
                    found = true;
                    break;
                }
                g++;
                inGlyph = 0;
            }
            // A character no glyph nearby shows (text extraction's own): leave the glyphs where they were.
            if (!found) {
                g = from;
                inGlyph = fromIn;
            }
        }
    }
    return out;
}
