/** Placing floating elements (tooltips, menus) against the viewport. */

export interface Rect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export type Side = 'below' | 'above' | 'right' | 'left';

/** Keep floating elements this far from the viewport's edges. */
export const MARGIN = 8;
/** The gap between an anchor and what floats beside it. */
const GAP = 8;

/** Where a box of `size` goes next to `anchor` inside a viewport of `vw` × `vh`: on `prefer`'s side if it fits there,
 *  else on the opposite side, else on whichever side has more room; then shifted along that side to stay inside.
 *
 *  Promises: the result lies inside the viewport's margins whenever the box fits in the viewport at all (when it is
 *  larger, it is pinned to the top-left margin). */
export function place(anchor: Rect, size: { width: number; height: number }, prefer: Side, vw: number, vh: number): { left: number; top: number; side: Side } {
    const room: Record<Side, number> = {
        below: vh - MARGIN - (anchor.top + anchor.height + GAP),
        above: anchor.top - GAP - MARGIN,
        right: vw - MARGIN - (anchor.left + anchor.width + GAP),
        left: anchor.left - GAP - MARGIN,
    };
    const opposite: Record<Side, Side> = { below: 'above', above: 'below', right: 'left', left: 'right' };
    const need = (s: Side): number => (s === 'below' || s === 'above' ? size.height : size.width);
    let side = prefer;
    if (room[side] < need(side)) side = room[opposite[side]] >= need(opposite[side]) ? opposite[side] : room[side] >= room[opposite[side]] ? side : opposite[side];
    const clamp = (v: number, max: number): number => Math.max(MARGIN, Math.min(v, max - MARGIN));
    if (side === 'below' || side === 'above') {
        const left = clamp(anchor.left + anchor.width / 2 - size.width / 2, vw - size.width);
        const top = side === 'below' ? anchor.top + anchor.height + GAP : anchor.top - GAP - size.height;
        return { left, top: clamp(top, vh - size.height), side };
    }
    const top = clamp(anchor.top + anchor.height / 2 - size.height / 2, vh - size.height);
    const left = side === 'right' ? anchor.left + anchor.width + GAP : anchor.left - GAP - size.width;
    return { left: clamp(left, vw - size.width), top, side };
}

/** An attachment for a menu or popover laid out by CSS next to its anchor: once it has a size, moves it back inside
 *  the viewport if it sticks out (right, left or bottom), and caps its height so a long list scrolls instead. */
export function keepInView(el: HTMLElement): void {
    const fit = (): void => {
        el.style.translate = '';
        el.style.maxHeight = '';
        const r = el.getBoundingClientRect();
        let dx = 0;
        if (r.right > window.innerWidth - MARGIN) dx = window.innerWidth - MARGIN - r.right;
        if (r.left + dx < MARGIN) dx = MARGIN - r.left;
        if (dx) el.style.translate = `${dx}px 0`;
        if (r.bottom > window.innerHeight - MARGIN) {
            el.style.maxHeight = `${Math.max(120, window.innerHeight - MARGIN - r.top)}px`;
            el.style.overflow = 'auto';
        }
    };
    requestAnimationFrame(fit);
}
