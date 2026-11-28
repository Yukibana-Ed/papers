import { describe, expect, it } from 'vitest';
import { FORMAT_FILE, PDFTEX_BUILD, pdftexAssetKey } from '#lib/pdftex-assets.ts';

describe("our pdfTeX's assets", () => {
    it('are the modules of one build, and a format of that build and one snapshot', () => {
        expect(pdftexAssetKey('pdftex.wasm', '2026-11-28')).toBe(`pdftex/${PDFTEX_BUILD}/pdftex.wasm`);
        expect(pdftexAssetKey('bibtex8.wasm', '2026-11-28')).toBe(`pdftex/${PDFTEX_BUILD}/bibtex8.wasm`);
        expect(pdftexAssetKey(FORMAT_FILE, '2026-11-28')).toBe(`pdftex/${PDFTEX_BUILD}/2026-11-28/pdflatex.fmt`);
        expect(pdftexAssetKey('../secret', '2026-11-28')).toBeNull();
    });

    it('name the build that packages/pdftex-wasm makes', async () => {
        const { default: upstream } = await import('../../../packages/pdftex-wasm/upstream.json', { with: { type: 'json' } });
        expect(PDFTEX_BUILD).toBe(`${upstream.version}-yb.${upstream.build}`);
    });
});
