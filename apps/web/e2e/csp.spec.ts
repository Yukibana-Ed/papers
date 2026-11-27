import { expect, test } from '@playwright/test';

test('the app blocks nothing of its own, and names a script the policy blocks by how it starts', async ({ page }) => {
    const blocked: string[] = [];
    page.on('console', m => {
        if (m.text().startsWith('Blocked by')) blocked.push(m.text());
    });
    await page.goto('/demo');
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
    expect(blocked).toEqual([]);
    // As a browser extension or a proxy would add one.
    await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.injectedByATest = 1;';
        document.head.append(s);
    });
    await expect.poll(() => blocked[0] ?? '').toContain('starting "window.injectedByATest = 1;"');
    expect(await page.evaluate(() => 'injectedByATest' in window)).toBe(false);
});
