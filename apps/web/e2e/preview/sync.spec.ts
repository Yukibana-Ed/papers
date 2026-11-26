import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { openDemo } from '../support.ts';

/** Source ⇄ preview sync to the word and the character, with the real TeX engine, on the demo's introduction:
 *  "…the first weeks are where most of them struggle." (sections/intro.tex, line 3). */

async function preview(page: Page): Promise<FrameLocator> {
    await openDemo(page);
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-page .textLayer span').first()).toBeVisible({ timeout: 170_000 });
    return frame;
}

/** The viewport box of characters [`from`, `to`) of `word` in the text run that has it. */
async function charBox(page: Page, frame: FrameLocator, word: string, from: number, to: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const iframe = await page.locator('iframe.pv-frame').boundingBox();
    if (iframe === null) throw new Error('no frame');
    const r = await frame
        .locator('.textLayer span', { hasText: word })
        .first()
        .evaluate(
            (span, [w, a, b]) => {
                const text = span.firstChild;
                const i = (text?.textContent ?? '').indexOf(w);
                if (text === null || i < 0) throw new Error('word not in run');
                const range = document.createRange();
                range.setStart(text, i + a);
                range.setEnd(text, i + b);
                const box = range.getBoundingClientRect();
                return { x: box.left, y: box.top, width: box.width, height: box.height };
            },
            [word, from, to] as const,
        );
    return { ...r, x: r.x + iframe.x, y: r.y + iframe.y };
}

test.describe('sync to the word', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    test('a click in the preview puts the caret on the character clicked', async ({ page }) => {
        const frame = await preview(page);
        // Wait for the sync to the word: it reads the document's text after the pages are laid out.
        await page.waitForTimeout(1500);
        // The "u" of "struggle".
        const u = await charBox(page, frame, 'struggle', 3, 4);
        await page.mouse.click(u.x + u.width / 2, u.y + u.height / 2);
        await expect(page.locator('.tab.is-active, [role="tab"][aria-selected="true"]').first()).toContainText('intro.tex');
        // Typing shows where the caret is: just before the "u".
        await page.keyboard.type('Z');
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('where most of them strZuggle.');
    });

    test('jumping from the source flashes the word under the caret, not its line', async ({ page }) => {
        const frame = await preview(page);
        await page.waitForTimeout(1500);
        const word = await charBox(page, frame, 'struggle', 0, 8);
        // The caret into "struggle" in the source, from the preview, then back.
        await page.mouse.click(word.x + 2, word.y + word.height / 2);
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('struggle');
        await page.keyboard.press('Control+J');
        const flash = frame.locator('.pv-flash').first();
        await expect(flash).toBeAttached();
        const f = await flash.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left, width: r.width };
        });
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        const left = word.x - (iframe?.x ?? 0);
        // The flash is the word's (padded by 3 px on either side), not the typeset line's.
        expect(Math.abs(f.x + 3 - left)).toBeLessThan(4);
        expect(f.width).toBeLessThan(word.width + 12);
    });

    test('a selection in the source is mirrored in the preview to the word', async ({ page }) => {
        const frame = await preview(page);
        await page.waitForTimeout(1500);
        const word = await charBox(page, frame, 'struggle', 0, 8);
        await page.mouse.click(word.x + 2, word.y + word.height / 2);
        // Select the source line the caret is on: it ends mid-way through a typeset line.
        await page.keyboard.press('Home');
        await page.keyboard.press('Shift+End');
        const mirror = frame.locator('.pv-hl-mirror').first();
        await expect(mirror).toBeAttached();
        // Mirrored to the word, the highlight ends where the source line does, short of the typeset line's end.
        const widths = await frame.locator('.pv-hl-mirror').evaluateAll(els => els.map(e => e.getBoundingClientRect().width));
        const line = await frame
            .locator('.textLayer span', { hasText: 'struggle' })
            .first()
            .evaluate(el => el.getBoundingClientRect().width);
        expect(Math.min(...widths)).toBeLessThan(line);
    });
});
