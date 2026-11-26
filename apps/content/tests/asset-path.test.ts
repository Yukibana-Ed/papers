import { describe, expect, it } from 'vitest';
import { ASSETS, stripAssetPrefix } from '#lib/asset-path.ts';
import { notFound } from '#lib/r2.ts';

describe('asset URLs', () => {
    it('carry a revision prefix that routing strips', () => {
        expect(ASSETS).toMatch(/^\/r\d+$/);
        expect(stripAssetPrefix(`${ASSETS}/tl/26/tikz.sty`)).toBe('/tl/26/tikz.sty');
        expect(stripAssetPrefix('/r12/engine/busytex.wasm')).toBe('/engine/busytex.wasm');
        expect(stripAssetPrefix('/frame')).toBe('/frame');
        expect(stripAssetPrefix('/rx/engine')).toBe('/rx/engine');
    });

    it('cache misses briefly, never for a year', () => {
        expect(notFound().headers.get('Cache-Control')).toBe('public, max-age=300');
    });
});
