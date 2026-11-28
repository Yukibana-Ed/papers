import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { openDemo } from '../support.ts';

/** Zooming the preview where it is: Ctrl with the wheel (as a mouse's notches, and in the small steps a touchpad's
 *  pinch arrives in) zooms about the pointer, and Ctrl with + and - zoom while the preview has the keyboard. With the
 *  real TeX engine, on the demo. */

async function preview(page: Page): Promise<FrameLocator> {
    await openDemo(page);
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-page .textLayer span').first()).toBeVisible({ timeout: 170_000 });
    await expect(page.locator('.pv-spin')).toHaveCount(0, { timeout: 120_000 });
    return frame;
}

test.describe('zooming in the preview', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    test('Ctrl with the wheel zooms about the pointer, a pinch smoothly, and Ctrl with + and - zoom from the preview', async ({ page }) => {
        const frame = await preview(page);
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const percent = async (): Promise<number> => Number(((await page.locator('.zoom-n').textContent()) ?? '').replace('%', ''));
        const scale = (): Promise<number> =>
            frame
                .locator('.pv-page')
                .first()
                .evaluate(el => Number(getComputedStyle(el).getPropertyValue('--scale-factor')));
        // A line some way down and to the right of the page's middle: the pages have to scroll both ways to keep it.
        const run = frame.locator('.textLayer span[data-run]', { hasText: 'where most of them' }).first();
        /** Where the pointer is in the run, as fractions of the run's box. */
        const held = (at: { x: number; y: number }): Promise<{ fx: number; fy: number }> =>
            run.evaluate((el, p) => {
                const r = el.getBoundingClientRect();
                return { fx: (p.x - r.left) / r.width, fy: (p.y - r.top) / r.height };
            }, at);
        const box = await run.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        const at = { x: box.x + box.width * 0.8, y: box.y + box.height / 2 };
        await page.mouse.move(iframe.x + at.x, iframe.y + at.y);
        const from = await scale();
        const shown = await percent();

        // A mouse's wheel: a tenth more per notch. The first two make the page wider than the pane, from where the
        // pages can be scrolled across to keep the point.
        await page.keyboard.down('Control');
        for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -100);
        await expect.poll(scale).toBeCloseTo(from * 1.1 ** 2, 2);
        const before = await held(at);
        for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -100);
        await expect.poll(scale).toBeCloseTo(from * 1.1 ** 4, 2);
        let now = await held(at);
        expect(Math.abs(now.fx - before.fx)).toBeLessThan(0.01);
        expect(Math.abs(now.fy - before.fy)).toBeLessThan(0.15);
        // The app's readout follows, and the frame is not sent back to an older zoom on the way.
        await expect.poll(percent).toBe(Math.round((await scale()) * 100));
        expect(await percent()).toBeGreaterThan(shown);

        // A pinch: many small steps, each its own zoom, the same point held throughout.
        for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -2);
        await expect.poll(scale).toBeCloseTo(from * 1.1 ** 4 * Math.exp(0.6), 2);
        now = await held(at);
        expect(Math.abs(now.fx - before.fx)).toBeLessThan(0.01);
        expect(Math.abs(now.fy - before.fy)).toBeLessThan(0.15);
        await page.keyboard.up('Control');
        await page.waitForTimeout(300);
        expect(await scale()).toBeCloseTo(from * 1.1 ** 4 * Math.exp(0.6), 2);
        // The frame's own page is not zoomed by the browser.
        expect(await frame.locator('body').evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

        // Without Ctrl the wheel scrolls, across too once the page is wider than the pane.
        await page.keyboard.down('Control');
        for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -100);
        await page.keyboard.up('Control');
        const scroll = (): Promise<{ left: number; top: number }> => frame.locator('.pv-scroll').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
        const was = await scroll();
        await page.mouse.wheel(-40, 60);
        await expect.poll(async () => (await scroll()).top).toBe(was.top + 60);
        expect((await scroll()).left).toBe(was.left - 40);

        // The keys, with the preview holding the keyboard: a step to the next tenth.
        const zoomed = await percent();
        await frame.locator('.pv-scroll').focus();
        await page.keyboard.press('Control+Minus');
        await expect.poll(percent).toBeLessThan(zoomed);
        const less = await percent();
        await page.keyboard.press('Control+Equal');
        await expect.poll(percent).toBeGreaterThan(less);
    });
});
