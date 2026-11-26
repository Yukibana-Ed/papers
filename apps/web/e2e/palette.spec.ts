import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './support.ts';

/** Selects to the end of the first line in the editor, which leaves focus (and a selection) there. */
async function selectInEditor(page: Page): Promise<void> {
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
}

/** The palette opens with focus in its field whatever had it, keeps it, and gives it back on Escape. */
test.describe('the command palette takes the keyboard', () => {
    const ways: Record<string, (page: Page) => Promise<void>> = {
        'Ctrl+K': page => page.keyboard.press('Control+k'),
        'Ctrl+Shift+P': page => page.keyboard.press('Control+Shift+p'),
        'the header button': page => page.getByRole('button', { name: 'Commands' }).click(),
    };
    for (const [name, open] of Object.entries(ways)) {
        test(`opened with ${name} over a selection in the editor`, async ({ page }) => {
            await openDemo(page);
            await selectInEditor(page);
            await open(page);
            const field = page.locator('.palette-input');
            await expect(field).toBeFocused();
            await page.keyboard.type('zoom');
            await expect(field).toHaveValue('zoom');
            await expect(page.locator('.palette-list .row-btn')).toHaveText([/Zoom in/, /Zoom out/]);
            // Nothing was typed into the source.
            const text = await page.evaluate(() => (Reflect.get(window, '__papersTest') as { editor: { testState(): { text: string } } }).editor.testState().text);
            expect(text).not.toContain('zoom');
            // Tab stays in the palette; Escape closes it and the keyboard is back where it was.
            await page.keyboard.press('Tab');
            await expect(field).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(page.locator('.palette')).toHaveCount(0);
            if (name === 'the header button') await expect(page.getByRole('button', { name: 'Commands' })).toBeFocused();
            else await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.monaco-editor') !== null)).toBe(true);
        });
    }
});
