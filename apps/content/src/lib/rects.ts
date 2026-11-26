/** A rectangle in some 2-D space, `width` and `height` non-negative. */
export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** The selection's rectangles as a code editor draws them: one per visual line, from the leftmost to the rightmost
 *  rectangle on that line, all the same height on one line.
 *
 *  PDF.js's text layer gives one span per text run, of uneven heights and with gaps between runs, so the browser's own
 *  selection looks ragged. Two rectangles are on the same line when they overlap vertically by at least half the smaller
 *  one's height, so a subscript or superscript joins its line. Empty rectangles (zero width or height) are dropped. `lead` grows each line above and below by
 *  that fraction of its height, as an editor's line height exceeds its font size, and `pad` widens each result on every
 *  side.
 *
 *  Promises: the result is sorted top to bottom, and no two results overlap vertically by more than `pad * 2`. */
export function mergeLineRects(rects: Iterable<Rect>, pad = 0, lead = 0): Rect[] {
    const sorted = [...rects].filter(r => r.width > 0.5 && r.height > 0.5).toSorted((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
    const lines: { top: number; bottom: number; left: number; right: number; h: number }[] = [];
    for (const r of sorted) {
        const last = lines.at(-1);
        if (last !== undefined && Math.min(last.bottom, r.y + r.height) - Math.max(last.top, r.y) >= Math.min(last.h, r.height) / 2) {
            last.top = Math.min(last.top, r.y);
            last.bottom = Math.max(last.bottom, r.y + r.height);
            last.left = Math.min(last.left, r.x);
            last.right = Math.max(last.right, r.x + r.width);
            last.h = last.bottom - last.top;
            continue;
        }
        lines.push({ top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width, h: r.height });
    }
    for (const l of lines) {
        const grow = (l.bottom - l.top) * lead;
        l.top -= grow;
        l.bottom += grow;
    }
    // Neighbouring lines meet halfway instead of overlapping, as an editor's selection does.
    for (let i = 1; i < lines.length; i++) {
        const a = lines[i - 1];
        const b = lines[i];
        if (a === undefined || b === undefined || a.bottom <= b.top) continue;
        const mid = (a.bottom + b.top) / 2;
        a.bottom = mid;
        b.top = mid;
    }
    return lines.map(l => ({ x: l.left - pad, y: l.top - pad, width: l.right - l.left + pad * 2, height: l.bottom - l.top + pad * 2 }));
}
