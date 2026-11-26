import { expect, test } from '@playwright/test';
import { openDemo } from './support.ts';

test.describe('keys pressed in the preview frame', () => {
    test('open the commit popover but never commit', async ({ page }) => {
        await openDemo(page);
        const head = await page.locator('.chip-btn.mono').first().textContent();
        const pending = await page.locator('.pending').textContent();
        // The frame runs untrusted output: even with its keys forwarded, Ctrl+S twice must not commit.
        const frame = page.frameLocator('iframe.pv-frame');
        await frame.locator('body').click({ position: { x: 20, y: 20 } });
        await page.keyboard.press('Control+S');
        await expect(page.locator('.pop-commit')).toBeVisible();
        await frame.locator('body').click({ position: { x: 20, y: 20 } });
        await page.keyboard.press('Control+S');
        await page.waitForTimeout(500);
        expect(await page.locator('.chip-btn.mono').first().textContent()).toBe(head);
        expect(await page.locator('.pending').textContent()).toBe(pending);
    });

    test('still open harmless things: the palette', async ({ page }) => {
        await openDemo(page);
        const frame = page.frameLocator('iframe.pv-frame');
        await frame.locator('body').click({ position: { x: 20, y: 20 } });
        await page.keyboard.press('Control+K');
        await expect(page.locator('.palette')).toBeVisible();
    });
});

test('the content frame runs no code built from text', async ({ page }) => {
    const policy = page.waitForResponse(r => new URL(r.url()).pathname === '/frame').then(r => r.headers()['content-security-policy'] ?? '');
    await openDemo(page);
    const scripts = /script-src[^;]*/.exec(await policy)?.[0] ?? '';
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-eval'");
});
