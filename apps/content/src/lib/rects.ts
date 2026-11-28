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

/** The typeset line at (`x`, `y`) among `boxes` (text runs' boxes, in any units): the indices of the run there (the
 *  nearest one level with `y`, within two of its heights) and of the runs level with it, on either side, that follow
 *  one another with gaps under 0.8 of the line's height. Empty when no run is there. Promises: a run across a gap as
 *  wide as a column gutter or a table's column space is not in the line. */
export function lineOf(boxes: readonly { left: number; right: number; top: number; bottom: number }[], x: number, y: number): number[] {
    let at = -1;
    let away = Infinity;
    boxes.forEach((b, i) => {
        if (y < b.top || y > b.bottom) return;
        const d = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
        if (d < away && d <= 2 * (b.bottom - b.top)) {
            away = d;
            at = i;
        }
    });
    const target = boxes[at];
    if (target === undefined) return [];
    const height = target.bottom - target.top;
    // Level with it: sharing at least half of the lower of the two heights.
    const level = boxes
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => Math.min(b.bottom, target.bottom) - Math.max(b.top, target.top) >= Math.min(b.bottom - b.top, height) / 2)
        .toSorted((p, q) => p.b.left - q.b.left);
    const k = level.findIndex(r => r.i === at);
    let from = k;
    let to = k;
    let edge = target.left;
    while (from > 0 && edge - (level[from - 1]?.b.right ?? -Infinity) < 0.8 * height) edge = Math.min(edge, level[--from]?.b.left ?? edge);
    edge = target.right;
    while (to < level.length - 1 && (level[to + 1]?.b.left ?? Infinity) - edge < 0.8 * height) edge = Math.max(edge, level[++to]?.b.right ?? edge);
    return level.slice(from, to + 1).map(r => r.i);
}

/** The typeset line next to the line whose box is `from`, below it when `below` and else above, in the same column:
 *  the indices in `boxes` (text runs' boxes, in the same units) of the runs of that line, as `lineOf` gives them. The
 *  line is the nearest one whose runs lie wholly past `from`'s middle and share some of its width; of the lines
 *  equally near (a wide line over two columns), the one nearest to `x`. Empty when there is no such line. */
export function lineBeside(
    boxes: readonly { left: number; right: number; top: number; bottom: number }[],
    from: { left: number; right: number; top: number; bottom: number },
    x: number,
    below: boolean,
): number[] {
    const middle = (from.top + from.bottom) / 2;
    let at = -1;
    let away = Infinity;
    let aside = Infinity;
    boxes.forEach((b, i) => {
        if (b.right <= from.left || b.left >= from.right) return;
        const centre = (b.top + b.bottom) / 2;
        // Past the line: not a part of it (a raised mark, an index), nor a line it overlaps.
        if (below ? b.top < middle || centre <= from.bottom : b.bottom > middle || centre >= from.top) return;
        const d = below ? centre - from.bottom : from.top - centre;
        const height = b.bottom - b.top;
        const side = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
        // Runs of one line are as near as each other, give or take their heights.
        if (d < away - height / 2 || (d < away + height / 2 && side < aside)) {
            away = Math.min(away, d);
            aside = side;
            at = i;
        }
    });
    const target = boxes[at];
    if (target === undefined) return [];
    return lineOf(boxes, Math.min(Math.max(x, target.left), target.right), (target.top + target.bottom) / 2);
}

/** The text run a pointer at (`x`, `y`) means when it is over none of `boxes` (text runs' boxes, in the same units):
 *  its index, or -1 without boxes. A run level with `y` and within `reach` of `x` across is meant before any other
 *  (the pointer beside a line, or in a gap inside one), the nearest such; else the run nearest to the point. */
export function nearestBox(boxes: readonly { left: number; right: number; top: number; bottom: number }[], x: number, y: number, reach: number): number {
    let level = -1;
    let beside = Infinity;
    let near = -1;
    let away = Infinity;
    boxes.forEach((b, i) => {
        const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
        const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
        if (dy === 0 && dx <= reach && dx < beside) {
            beside = dx;
            level = i;
        }
        const d = Math.hypot(dx, dy);
        if (d < away) {
            away = d;
            near = i;
        }
    });
    return level >= 0 ? level : near;
}
