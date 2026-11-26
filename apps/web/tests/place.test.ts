import { describe, expect, it } from 'vitest';
import { MARGIN, place } from '#lib/ui/place.ts';

const VW = 1000;
const VH = 600;
const size = { width: 180, height: 40 };
const inside = (p: { left: number; top: number }): boolean => p.left >= MARGIN && p.top >= MARGIN && p.left + size.width <= VW - MARGIN && p.top + size.height <= VH - MARGIN;

describe('place', () => {
    it('keeps the preferred side when it fits', () => {
        expect(place({ left: 400, top: 100, width: 30, height: 30 }, size, 'below', VW, VH).side).toBe('below');
    });

    it('flips above for an anchor at the bottom edge', () => {
        const p = place({ left: 400, top: 570, width: 30, height: 24 }, size, 'below', VW, VH);
        expect(p.side).toBe('above');
        expect(inside(p)).toBe(true);
    });

    it('flips below for an anchor at the top edge', () => {
        const p = place({ left: 400, top: 2, width: 30, height: 24 }, size, 'above', VW, VH);
        expect(p.side).toBe('below');
        expect(inside(p)).toBe(true);
    });

    it('shifts along the side at the left and right edges', () => {
        for (const left of [0, 990]) {
            const p = place({ left, top: 200, width: 10, height: 24 }, size, 'below', VW, VH);
            expect(inside(p)).toBe(true);
        }
    });

    it('flips a right-hand tooltip to the left at the right edge, and stays inside vertically at the corners', () => {
        const p = place({ left: 960, top: 580, width: 32, height: 18 }, size, 'right', VW, VH);
        expect(p.side).toBe('left');
        expect(inside(p)).toBe(true);
        expect(inside(place({ left: 4, top: 580, width: 32, height: 18 }, size, 'right', VW, VH))).toBe(true);
    });
});
