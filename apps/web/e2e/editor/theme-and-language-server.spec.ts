import { expect, test } from '@playwright/test';
import { caretAt, languageServer, monacoDark, openDemo, state } from './helpers.ts';

/** Monaco takes the page's theme on first load, in both system schemes, even when its code arrives late; then it
 *  follows every change, including the system's while the choice is "system". */
for (const scheme of ['dark', 'light'] as const) {
    test(`Monaco is ${scheme} on first load when the system is ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        // The editor's code later than the page's first frame: the theme must not depend on who comes first.
        await page.route(/\/_app\/immutable\/chunks\//, async route => {
            await new Promise(r => setTimeout(r, 150));
            await route.continue();
        });
        await openDemo(page);
        expect(await monacoDark(page)).toBe(scheme === 'dark');
    });
}

test('Monaco follows a theme change at once, and the system while the choice is system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDemo(page);
    expect(await monacoDark(page)).toBe(true);
    await page.getByRole('button', { name: 'Light theme' }).click();
    await expect.poll(() => monacoDark(page)).toBe(false);
    await page.getByRole('button', { name: 'Dark theme' }).click();
    await expect.poll(() => monacoDark(page)).toBe(true);
    await page.evaluate(() => {
        document.documentElement.removeAttribute('data-theme');
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => monacoDark(page)).toBe(false);
});

test('without the preview frame, the editor works and the Typst language server says it is unavailable', async ({ page }) => {
    test.setTimeout(60_000);
    await page.route(/^http:\/\/127\.0\.0\.1:4174\//, route => route.abort());
    await openDemo(page);
    await caretAt(page, 'brief/findings.typ', 1, 1);
    await page.keyboard.type('x');
    expect((await state(page)).text.startsWith('x')).toBe(true);
    // No permanent "Loading...": completion and hover answer at once while the server is not there.
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(500);
    await expect(page.locator('.suggest-widget.message.visible .message', { hasText: 'Loading' })).toHaveCount(0);
    await expect.poll(() => languageServer(page), { timeout: 40_000 }).toMatchObject({ status: 'failed', detail: 'the preview frame cannot be reached' });
    await expect(page.locator('[data-lsp="failed"]')).toBeVisible();
});

test('a LaTeX paper does not load the Typst language server; opening a Typst file does', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', r => {
        if (/tinymist/.test(r.url())) asked.push(r.url());
    });
    await openDemo(page);
    await page.waitForTimeout(3000);
    expect(asked).toEqual([]);
    await caretAt(page, 'brief/findings.typ', 1, 1);
    await expect.poll(() => asked.length, { timeout: 30_000 }).toBeGreaterThan(0);
});
