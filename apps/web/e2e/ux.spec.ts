import { expect, test } from '@playwright/test';
import { openDemo } from './support.ts';

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('the editor fits the screen: no part of the top bar is cut off', async ({ page }) => {
        await openDemo(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        await expect(page.getByRole('button', { name: 'Preview' })).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('button', { name: 'Commands' })).toBeInViewport({ ratio: 1 });
    });
});

test('a page that does not exist says so in the app’s look, with the way back', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('404');
    await page.getByRole('link', { name: 'Yukibana Papers' }).click();
    await expect(page).toHaveURL(/\/$/);
});

test('the editor page has a heading for screen readers: the project', async ({ page }) => {
    await openDemo(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('feedback-paper');
});
