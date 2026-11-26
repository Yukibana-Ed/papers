import { expect, test } from '@playwright/test';
import { caretAt, openDemo } from './helpers.ts';

/** The page is cross-origin isolated, so a worker starts only from a script served with COEP too: static files get it
 *  from `_headers`, which the Worker's hook never sees. Without it Monaco fell back to the main thread and completion
 *  showed "Loading..." for ever. */
test("Monaco's worker starts, and completion does not hang", async ({ page }) => {
    const blocked: string[] = [];
    const workers: string[] = [];
    page.on('requestfailed', r => {
        if (r.failure()?.errorText.includes('BLOCKED')) blocked.push(r.url());
    });
    page.on('worker', w => workers.push(w.url()));
    await openDemo(page);
    await caretAt(page, 'sections/intro.tex', 7, 9);
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(1500);
    expect(blocked).toEqual([]);
    expect(workers.some(u => u.includes('editor.worker'))).toBe(true);
    await expect(page.locator('.suggest-widget.message.visible .message', { hasText: 'Loading' })).toHaveCount(0);
});
