import { expect, test } from '@playwright/test';
import { openDemo } from './support.ts';

test('a commit takes only the changes ticked by person, and the rest stay uncommitted', async ({ page }) => {
    await openDemo(page);
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+S');
    const pop = page.locator('.commit-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.pchip')).toHaveCount(2);
    await pop.locator('.pchip', { hasText: 'Marco' }).locator('input').uncheck();
    await expect(pop.locator('.row', { hasText: 'method.tex' }).locator('input')).not.toBeChecked();
    await pop.locator('.row').first().click();
    await expect(page.locator('.commit-pop.big .dtable').first()).toBeVisible();
    await page.locator('.commit-pop.big .foot button', { hasText: 'Commit' }).click();
    await expect(pop).toHaveCount(0);
    await expect(page.locator('.pending')).toHaveText('+1');
});
