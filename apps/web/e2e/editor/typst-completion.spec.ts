import { expect, test } from '@playwright/test';
import { caretAt, languageServer, openDemo } from './helpers.ts';

/** Typst completion comes from tinymist in the frame: once it is ready, the suggest widget answers within a second. */
test('Typst completion answers once the language server is ready', async ({ page }) => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the language server (E2E_ENGINE=1)');
    test.setTimeout(170_000);
    await openDemo(page);
    await caretAt(page, 'brief/brief.typ', 17, 1);
    await expect.poll(() => languageServer(page), { timeout: 150_000 }).toMatchObject({ status: 'ready' });
    const times: number[] = [];
    for (let n = 0; n < 3; n++) {
        await page.keyboard.press('Enter');
        const t0 = Date.now();
        await page.keyboard.type('#tex');
        await expect(page.locator('.suggest-widget.visible .monaco-list-row', { hasText: 'text' }).first()).toBeVisible({ timeout: 10_000 });
        times.push(Date.now() - t0);
        await page.keyboard.press('Escape');
    }
    console.log(`Typst completion: ${times.join(', ')} ms (first cold, then warm)`);
    expect(Math.min(...times)).toBeLessThan(1000);
});
