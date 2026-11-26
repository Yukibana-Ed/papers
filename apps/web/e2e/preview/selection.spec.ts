import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { openDemo } from '../support.ts';

/** Selecting in the LaTeX preview, with the real TeX engine: the text layer lies on the glyphs, the selection's
 *  highlight covers what is selected at full line height in the paper's colours, its toolbar covers no text, and the
 *  source line under the pointer is marked on both sides. */

type Box = { x: number; y: number; width: number; height: number };

/** Opens the demo and waits for the first page's text layer. */
async function preview(page: Page): Promise<FrameLocator> {
    await openDemo(page);
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-page .textLayer span').first()).toBeVisible({ timeout: 170_000 });
    return frame;
}

/** For every text run on the first page with more than three characters: its box, and the box of the dark pixels on
 *  the canvas within it (grown a little, to catch glyphs that stick out of a box set too small), in page pixels. */
async function runsAndInk(frame: FrameLocator): Promise<{ text: string; fontHeight: number; span: Box; ink: Box | null }[]> {
    return frame
        .locator('.pv-page')
        .first()
        .evaluate((pageEl: HTMLElement) => {
            const canvas = pageEl.querySelector('canvas');
            const ctx = canvas?.getContext('2d', { willReadFrequently: true });
            if (!canvas || !ctx) throw new Error('no canvas');
            const k = canvas.width / pageEl.clientWidth;
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const page = pageEl.getBoundingClientRect();
            const scale = Number(pageEl.style.getPropertyValue('--total-scale-factor'));
            const ink = (b: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } | null => {
                let left = Infinity;
                let right = -1;
                let top = Infinity;
                let bottom = -1;
                const x0 = Math.max(0, Math.floor((b.x - 1) * k));
                const x1 = Math.min(canvas.width, Math.ceil((b.x + b.width + 1) * k));
                const y0 = Math.max(0, Math.floor(b.y * k));
                const y1 = Math.min(canvas.height, Math.ceil((b.y + b.height) * k));
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        const i = (y * canvas.width + x) * 4;
                        if ((img[i + 3] ?? 0) > 128 && (img[i] ?? 255) < 140) {
                            left = Math.min(left, x);
                            right = Math.max(right, x + 1);
                            top = Math.min(top, y);
                            bottom = Math.max(bottom, y + 1);
                        }
                    }
                }
                return right < 0 ? null : { x: left / k, y: top / k, width: (right - left) / k, height: (bottom - top) / k };
            };
            return [...pageEl.querySelectorAll<HTMLElement>('.textLayer span')]
                .filter(s => (s.textContent ?? '').trim().length > 3)
                .map(s => {
                    const r = s.getBoundingClientRect();
                    const span = { x: r.left - page.left, y: r.top - page.top, width: r.width, height: r.height };
                    return { text: s.textContent ?? '', fontHeight: parseFloat(s.style.getPropertyValue('--font-height')) * scale, span, ink: ink(span) };
                });
        });
}

for (const deviceScaleFactor of [1, 2]) {
    test.describe(`the preview's selection at ${deviceScaleFactor}x`, () => {
        test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');
        test.use({ deviceScaleFactor });

        test('the text layer lies on the glyphs', async ({ page }) => {
            const frame = await preview(page);
            // PDF.js measures the smallest font size once, with a div it adds to the body; a page style that stretched
            // that div read 826 here, and every run was then set beyond the browser's largest font size.
            expect(
                await frame
                    .locator('.pv-page .textLayer')
                    .first()
                    .evaluate(el => getComputedStyle(el).getPropertyValue('--min-font-size').trim()),
            ).toBe('1');
            const runs = await runsAndInk(frame);
            expect(runs.length).toBeGreaterThan(20);
            for (const r of runs) {
                // A run is as tall as its font, so it reaches the glyphs' tops and bottoms (the title was 30% short).
                expect(r.span.height, r.text).toBeGreaterThan(r.fontHeight * 0.95);
                if (r.ink === null) continue;
                expect(Math.abs(r.ink.x - r.span.x), `left of "${r.text}"`).toBeLessThan(4);
                expect(Math.abs(r.ink.x + r.ink.width - (r.span.x + r.span.width)), `right of "${r.text}"`).toBeLessThan(4);
            }
        });

        test('a drag across lines is highlighted at full line height, and its toolbar covers no text', async ({ page }) => {
            const frame = await preview(page);
            const runs = frame.locator('.pv-page').first().locator('.textLayer span');
            const iframe = await page.locator('iframe.pv-frame').boundingBox();
            if (iframe === null) throw new Error('no frame');
            // From the start of the abstract's first long run to the middle of the fourth after it.
            const boxes = await runs.evaluateAll(spans =>
                spans
                    .filter(s => (s.textContent ?? '').trim().length > 30)
                    .slice(0, 5)
                    .map(s => {
                        const r = s.getBoundingClientRect();
                        return { x: r.left, y: r.top, width: r.width, height: r.height };
                    }),
            );
            const a = boxes[0];
            const b = boxes[4];
            if (a === undefined || b === undefined) throw new Error('too few runs');
            await page.mouse.move(iframe.x + a.x + 1, iframe.y + a.y + a.height / 2);
            await page.mouse.down();
            await page.mouse.move(iframe.x + b.x + b.width / 2, iframe.y + b.y + b.height / 2, { steps: 15 });
            await expect(frame.locator('.pv-toolbar')).toHaveCount(0);
            await page.mouse.up();
            const toolbar = frame.locator('.pv-toolbar');
            await expect(toolbar).toBeVisible();

            const highlight = await frame.locator('.pv-sel-rect').evaluateAll(els =>
                els.map(e => {
                    const r = e.getBoundingClientRect();
                    return { x: r.left, y: r.top, width: r.width, height: r.height };
                }),
            );
            // Every run wholly inside the drag is covered by the highlight, each line at least 1.2 times its font's height.
            for (const run of boxes.slice(1, 4)) {
                const line = highlight.find(h => h.y <= run.y + 1 && h.y + h.height >= run.y + run.height - 1);
                expect(line, `a highlight over the run at y=${run.y}`).toBeDefined();
                if (line === undefined) continue;
                expect(line.x).toBeLessThanOrEqual(run.x + 1);
                expect(line.x + line.width).toBeGreaterThanOrEqual(run.x + run.width - 1);
                expect(line.height).toBeGreaterThan(run.height * 1.2);
            }
            // The highlight is the light paper's, in either theme: a pale colour, never the dark theme's.
            const colour = await frame
                .locator('.pv-sel-rect')
                .first()
                .evaluate(e => {
                    const c = document.createElement('canvas').getContext('2d');
                    if (!c) return 0;
                    c.fillStyle = getComputedStyle(e).backgroundColor;
                    c.fillRect(0, 0, 1, 1);
                    const [r = 0, g = 0, bl = 0] = c.getImageData(0, 0, 1, 1).data;
                    return (r + g + bl) / 3;
                });
            expect(colour).toBeGreaterThan(200);
            // The toolbar overlaps no text run.
            const tb = await toolbar.evaluate(e => {
                const r = e.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width, height: r.height };
            });
            const all = await frame.locator('.textLayer span').evaluateAll(spans =>
                spans
                    .filter(s => (s.textContent ?? '').trim() !== '')
                    .map(s => {
                        const r = s.getBoundingClientRect();
                        return { x: r.left, y: r.top, width: r.width, height: r.height };
                    }),
            );
            const overlaps = all.filter(r => r.x < tb.x + tb.width && tb.x < r.x + r.width && r.y < tb.y + tb.height && tb.y < r.y + r.height);
            expect(overlaps).toEqual([]);
            const text = await frame.locator('body').evaluate(() => window.getSelection()?.toString() ?? '');
            expect(text.length).toBeGreaterThan(100);
        });

        test('a triple click selects the typeset line', async ({ page }) => {
            const frame = await preview(page);
            const run = frame
                .locator('.pv-page')
                .first()
                .locator('.textLayer span')
                .filter({ hasText: /\w{4,}/ })
                .nth(8);
            await run.click({ clickCount: 3, position: { x: 4, y: 4 } });
            const selected = await frame.locator('body').evaluate(() => window.getSelection()?.toString() ?? '');
            const text = (await run.textContent()) ?? '';
            expect(selected).toContain(text.trim());
            // One line, not the page.
            expect(selected.length).toBeLessThan(text.length * 3 + 20);
        });

        test('the source line under the pointer is marked in the preview and in the editor', async ({ page }) => {
            const frame = await preview(page);
            const run = frame
                .locator('.pv-page')
                .first()
                .locator('.textLayer span')
                .filter({ hasText: /\w{4,}/ })
                .nth(10);
            await run.hover({ position: { x: 6, y: 4 } });
            await expect(frame.locator('.pv-hover-box').first()).toBeVisible();
            await expect(page.locator('.monaco-editor .hover-line').first()).toBeAttached();
            await page.mouse.move(2, 2);
            await expect(frame.locator('.pv-hover-box')).toHaveCount(0);
        });
    });
}

for (const colorScheme of ['light', 'dark'] as const) {
    test(`a selection in the preview looks like the editor's (${colorScheme})`, async ({ page }, info) => {
        test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');
        await page.emulateMedia({ colorScheme });
        const frame = await preview(page);
        const runs = frame
            .locator('.pv-page')
            .first()
            .locator('.textLayer span')
            .filter({ hasText: /.{40,}/ });
        const first = await runs.nth(1).boundingBox();
        const last = await runs.nth(4).boundingBox();
        if (first === null || last === null) throw new Error('no runs');
        await page.mouse.move(first.x + 1, first.y + first.height / 2);
        await page.mouse.down();
        await page.mouse.move(last.x + last.width * 0.6, last.y + last.height / 2, { steps: 10 });
        await page.mouse.up();
        await expect(frame.locator('.pv-toolbar')).toBeVisible();
        await info.attach(`selection-${colorScheme}`, { body: await page.locator('iframe.pv-frame').screenshot(), contentType: 'image/png' });
    });
}

/** How a screenshot of the same spot changed. Ink (pixels darker than 80 of 255): how many, and how much lighter the
 *  lightest of them became, which a highlight washing over the text shows and one under or around it does not. Paper
 *  (near white): the share that changed visibly. */
async function inkAndPaper(page: Page, before: Buffer, after: Buffer): Promise<{ inkPixels: number; inkLighter: number; paperChanged: number }> {
    return page.evaluate(
        async ([a, b]) => {
            const pixels = async (b64: string): Promise<Uint8ClampedArray> => {
                // Not fetch(data:…): the page's policy allows no such connection.
                const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
                const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
                const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
                if (!c) throw new Error('no canvas');
                c.drawImage(bitmap, 0, 0);
                return c.getImageData(0, 0, bitmap.width, bitmap.height).data;
            };
            const p = await pixels(a);
            const q = await pixels(b);
            const lum = (d: Uint8ClampedArray, i: number): number => ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
            let inkPixels = 0;
            let inkLighter = 0;
            let paper = 0;
            let paperChanged = 0;
            for (let i = 0; i < p.length; i += 4) {
                const was = lum(p, i);
                const now = lum(q, i);
                if (was < 80) {
                    inkPixels++;
                    inkLighter = Math.max(inkLighter, now - was);
                } else if (was > 245) {
                    paper++;
                    const d = Math.max(Math.abs((p[i] ?? 0) - (q[i] ?? 0)), Math.abs((p[i + 1] ?? 0) - (q[i + 1] ?? 0)), Math.abs((p[i + 2] ?? 0) - (q[i + 2] ?? 0)));
                    if (d > 6) paperChanged++;
                }
            }
            return { inkPixels, inkLighter, paperChanged: paper === 0 ? 0 : paperChanged / paper };
        },
        [before.toString('base64'), after.toString('base64')] as const,
    );
}

for (const deviceScaleFactor of [1, 2]) {
    for (const colorScheme of ['light', 'dark'] as const) {
        test(`highlights colour the paper around the glyphs, never the glyphs (${colorScheme}, ${deviceScaleFactor}x)`, async ({ browser }) => {
            test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');
            const context = await browser.newContext({ deviceScaleFactor, colorScheme, viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();
            const frame = await preview(page);
            const run = frame
                .locator('.pv-page')
                .first()
                .locator('.textLayer span')
                .filter({ hasText: /.{40,}/ })
                .nth(3);
            const box = await run.boundingBox();
            if (box === null) throw new Error('no run');
            const clip = { x: box.x, y: box.y - 2, width: box.width, height: box.height + 4 };
            await page.mouse.move(5, 5);
            const before = await page.screenshot({ clip });

            // The source line under the pointer.
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await expect(frame.locator('.pv-hover-box').first()).toBeVisible();
            const hovered = await inkAndPaper(page, before, await page.screenshot({ clip }));
            expect(hovered.inkPixels).toBeGreaterThan(50);
            expect(hovered.inkLighter).toBeLessThanOrEqual(3);
            expect(hovered.paperChanged).toBeGreaterThan(0.5);

            // A selection over the whole run.
            await page.mouse.move(box.x + 1, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
            await page.mouse.up();
            await expect(frame.locator('.pv-sel-rect').first()).toBeVisible();
            const selected = await inkAndPaper(page, before, await page.screenshot({ clip }));
            expect(selected.inkLighter).toBeLessThanOrEqual(3);
            expect(selected.paperChanged).toBeGreaterThan(0.5);
            await context.close();
        });
    }
}
