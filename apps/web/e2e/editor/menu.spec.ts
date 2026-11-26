import { expect, test } from '@playwright/test';
import { openDemo } from './helpers.ts';

/** The editor's right-click menu is an opaque box in the editor's own surface colour, in both themes: the text
 *  under it never shows through. */
for (const scheme of ['light', 'dark'] as const) {
    test(`the editor's menu covers what is under it in the ${scheme} theme`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openDemo(page);
        await page.locator('.monaco-editor .view-lines').click({ button: 'right', position: { x: 200, y: 100 } });
        const menu = page.locator('.monaco-menu-container .monaco-menu');
        await expect(menu.getByText('Copy', { exact: true })).toBeVisible();
        const colours = await page.evaluate(() => {
            const painted = (from: Element | null): string => {
                for (let el = from; el !== null; el = el.parentElement) {
                    const bg = getComputedStyle(el).backgroundColor;
                    if (bg !== 'rgba(0, 0, 0, 0)') return bg;
                    if (el.classList.contains('monaco-menu-container')) break;
                }
                return 'none';
            };
            const item = document.querySelector('.monaco-menu-container .action-item');
            const editor = document.querySelector('.monaco-editor .monaco-editor-background');
            return { menu: painted(item), editor: editor === null ? '' : getComputedStyle(editor).backgroundColor };
        });
        expect(colours.menu).toBe(colours.editor);
        expect(colours.menu).toMatch(/^rgb\(/);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    });
}
