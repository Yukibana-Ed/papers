import { expect, test } from '@playwright/test';
import { openDemo } from '../support.ts';

/** The glyph boxes the preview's marks are drawn from are where the page's ink is: with the real TeX engine, every
 *  page of the demo is drawn again at four times its size and the first and last glyph of each word compared with the
 *  ink the canvas has there. */

test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine');

interface Measured {
    readonly glyphs: number;
    readonly words: number;
    readonly wordsWithGlyphs: number;
    readonly edges: number;
    readonly mean: number;
    readonly median: number;
    readonly p99: number;
    readonly max: number;
    readonly ms: number;
}

test('glyph boxes are within half a pixel of the ink', async ({ page }) => {
    test.setTimeout(240_000);
    await openDemo(page);
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-page .textLayer span').first()).toBeVisible({ timeout: 170_000 });
    const handle = await frame.locator('.pv-pages').elementHandle();
    // The word map, and the test's way to it, are made once the pages' text has been read.
    await expect.poll(async () => handle?.evaluate(() => Reflect.has(window, 'papersSync')), { timeout: 30_000 }).toBe(true);
    const measured = await handle?.evaluate(async (): Promise<Measured> => {
        interface Box {
            page: number;
            x: number;
            y: number;
            width: number;
            height: number;
        }
        interface Proxy {
            pageNumber: number;
            getViewport(o: { scale: number }): { width: number; height: number };
            render(o: { canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void> };
        }
        const sync = Reflect.get(window, 'papersSync') as {
            pages: Proxy[];
            words: { chars?: Box[] }[];
            glyphs(page: Proxy): Promise<{ text: string; box: Box; ink?: Box }[]>;
        };
        const SCALE = 4;
        const errors: number[] = [];
        let count = 0;
        let ms = 0;
        for (const proxy of sync.pages) {
            const viewport = proxy.getViewport({ scale: SCALE });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            await proxy.render({ canvas, viewport }).promise;
            const ctx = canvas.getContext('2d');
            if (ctx === null) throw new Error('no canvas');
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const dark = (x: number, y: number): boolean => {
                const i = (y * image.width + x) * 4;
                return (image.data[i] ?? 255) + (image.data[i + 1] ?? 255) + (image.data[i + 2] ?? 255) < 600;
            };
            const t0 = performance.now();
            const glyphs = await sync.glyphs(proxy);
            ms += performance.now() - t0;
            count += glyphs.length;
            glyphs.forEach((g, k) => {
                const ink = g.ink;
                if (ink === undefined || ink.width <= 0 || !/[\p{L}\p{N}]/u.test(g.text)) return;
                // An edge is measured where no other glyph's ink is within the window searched (3 pt): the left of a
                // word's first glyph, the right of its last, when the space beside it is wide enough.
                const alone = (other: { text: string; box: Box } | undefined, side: 'left' | 'right'): boolean => {
                    if (other === undefined || other.text.trim() === '') return true;
                    const gap = side === 'left' ? g.box.x - (other.box.x + other.box.width) : other.box.x - (g.box.x + g.box.width);
                    return Math.abs(other.box.y - g.box.y) > 12 || gap > 3.5 || gap < -50;
                };
                const top = Math.max(0, Math.floor(ink.y * SCALE));
                const bottom = Math.min(image.height - 1, Math.ceil((ink.y + ink.height) * SCALE));
                const column = (x: number): boolean => {
                    for (let y = top; y <= bottom; y++) if (dark(x, y)) return true;
                    return false;
                };
                const WINDOW = 3 * SCALE;
                if (alone(glyphs[k - 1], 'left')) {
                    const want = ink.x * SCALE;
                    for (let x = Math.max(0, Math.floor(want) - WINDOW); x < Math.min(image.width, want + WINDOW); x++) {
                        if (!column(x)) continue;
                        errors.push(Math.abs(x - want) / SCALE);
                        break;
                    }
                }
                if (alone(glyphs[k + 1], 'right')) {
                    const want = (ink.x + ink.width) * SCALE;
                    for (let x = Math.min(image.width - 1, Math.ceil(want) + WINDOW); x > Math.max(0, want - WINDOW); x--) {
                        if (!column(x)) continue;
                        errors.push(Math.abs(x + 1 - want) / SCALE);
                        break;
                    }
                }
            });
        }
        errors.sort((a, b) => a - b);
        return {
            glyphs: count,
            words: sync.words.length,
            wordsWithGlyphs: sync.words.filter(w => w.chars !== undefined).length,
            edges: errors.length,
            median: errors[Math.floor(errors.length * 0.5)] ?? 0,
            mean: errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length),
            p99: errors[Math.floor(errors.length * 0.99)] ?? 0,
            max: errors.at(-1) ?? 0,
            ms,
        };
    });
    if (measured === undefined) throw new Error('no pages');
    console.log(`glyphs: ${JSON.stringify(measured)}`);
    expect(measured.edges).toBeGreaterThan(200);
    expect(measured.wordsWithGlyphs / measured.words).toBeGreaterThan(0.98);
    // Errors are in PDF points: a quarter of a point is half a device pixel at the 2x a dense screen draws at.
    expect(measured.p99).toBeLessThan(0.25);
});
