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
        await expect(page.locator('.pv-spin')).toHaveCount(0, { timeout: 120_000 });
        await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 60_000 });
        // The "u" of "struggle".
        const u = await charBox(page, frame, 'struggle', 3, 4);
        await page.mouse.click(u.x + u.width / 2, u.y + u.height / 2);
        await expect(page.locator('.tab.is-active, [role="tab"][aria-selected="true"]').first()).toContainText('intro.tex');
        // Typing shows where the caret is: just before the "u".
        // The jump moves the focus to the editor: type once it has.
        await expect(page.locator('.monaco-editor.focused')).toBeAttached();
        await page.keyboard.type('Z');
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('where most of them strZuggle.');
    });

    test('jumping from the source flashes the word under the caret, not its line', async ({ page }) => {
        const frame = await preview(page);
        await expect(page.locator('.pv-spin')).toHaveCount(0, { timeout: 120_000 });
        await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 60_000 });
        const word = await charBox(page, frame, 'struggle', 0, 8);
        // The caret into "struggle" in the source, from the preview, then back.
        await page.mouse.click(word.x + 2, word.y + word.height / 2);
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('struggle');
        await expect(page.locator('.monaco-editor.focused')).toBeAttached();
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
        expect(Math.abs(f.x + 3 - left)).toBeLessThan(6);
        expect(f.width).toBeLessThan(word.width + 12);
    });

    test('a selection in the source is mirrored in the preview to the word', async ({ page }) => {
        const frame = await preview(page);
        await expect(page.locator('.pv-spin')).toHaveCount(0, { timeout: 120_000 });
        await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 60_000 });
        const word = await charBox(page, frame, 'struggle', 0, 8);
        await page.mouse.click(word.x + 2, word.y + word.height / 2);
        // Select the source line the click led to: it ends mid-way through a typeset line. (The keys go to the editor.)
        await page.locator('.monaco-editor .view-lines').getByText('where most of them struggle.').click();
        await page.keyboard.press('Home');
        await page.keyboard.press('Shift+End');
        const mirror = frame.locator('.pv-hl-mirror').first();
        await expect(mirror).toBeAttached();
        // Mirrored to the word, the highlight ends where the source line does, short of the typeset line's end.
        const line = await frame
            .locator('.textLayer span', { hasText: 'struggle' })
            .first()
            .evaluate(el => el.getBoundingClientRect().width);
        // The mirror is redrawn as the selection settles: wait for the narrow one.
        await expect.poll(async () => Math.min(...(await frame.locator('.pv-hl-mirror').evaluateAll(els => els.map(e => e.getBoundingClientRect().width))))).toBeLessThan(line);
    });
});

test.describe('a click in the preview', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    test('shows its source at once, before the editor takes the keyboard', async ({ page }) => {
        const frame = await preview(page);
        await expect(page.locator('.pv-spin')).toHaveCount(0, { timeout: 120_000 });
        await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 60_000 });
        // The page watches for the click (its window loses the focus to the frame) and for the caret to arrive.
        await page.evaluate(() => {
            const hook = Reflect.get(window, '__papersTest') as { editor: { testState(): { caret: { line: number } | null; text: string } } };
            const w = window as unknown as { clickedAt?: number; shownAt?: number };
            window.addEventListener('blur', () => (w.clickedAt ??= performance.now()));
            const look = (): void => {
                const st = hook.editor.testState();
                if (w.clickedAt !== undefined && st.caret?.line === 3 && st.text.includes('where most of them struggle')) w.shownAt = performance.now();
                else requestAnimationFrame(look);
            };
            requestAnimationFrame(look);
        });
        const u = await charBox(page, frame, 'struggle', 3, 4);
        await page.mouse.click(u.x + u.width / 2, u.y + u.height / 2);
        await expect.poll(() => page.evaluate(() => (window as unknown as { shownAt?: number }).shownAt ?? null)).not.toBeNull();
        const ms = await page.evaluate(() => {
            const w = window as unknown as { clickedAt: number; shownAt: number };
            return w.shownAt - w.clickedAt;
        });
        expect(ms).toBeLessThan(100);
    });
});
