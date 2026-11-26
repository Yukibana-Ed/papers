import { expect, test, type Page } from '@playwright/test';
import { caretAt, openDemo, sessionText, state } from './helpers.ts';

/** Go to definition, find references and rename for LaTeX in the editor itself. The demo cites becker2019 and
 *  hattie2007 from sections/intro.tex; their entries are in refs.bib. */

/** Puts the caret inside `word` in `file`. */
async function caretIn(page: Page, file: string, word: string): Promise<void> {
    const before = (await sessionText(page, file)).split(word)[0] ?? '';
    const lines = before.split('\n');
    await caretAt(page, file, lines.length, (lines.at(-1) ?? '').length + 3);
}

test.describe('LaTeX navigation', () => {
    test('go to definition opens the bibliography at the entry', async ({ page }) => {
        await openDemo(page);
        await caretIn(page, 'sections/intro.tex', 'becker2019');
        await page.keyboard.press('F12');
        await expect.poll(async () => (await state(page)).shown.startsWith('@inproceedings{becker2019,')).toBe(true);
        expect((await state(page)).caret?.line).toBe(1);
    });

    test('rename changes the key where it is cited and in the bibliography', async ({ page }) => {
        await openDemo(page);
        await caretIn(page, 'sections/intro.tex', 'becker2019');
        await page.keyboard.press('F2');
        const input = page.locator('.rename-box input');
        await expect(input).toHaveValue('becker2019');
        await input.fill('becker19');
        await page.keyboard.press('Enter');
        await expect.poll(() => sessionText(page, 'sections/intro.tex')).toContain('\\cite{becker19}');
        await expect.poll(() => sessionText(page, 'refs.bib')).toContain('@inproceedings{becker19,');
        expect(await sessionText(page, 'refs.bib')).not.toContain('becker2019');
    });

    test('find references lists the citation and the entry', async ({ page }) => {
        await openDemo(page);
        await caretIn(page, 'sections/intro.tex', 'hattie2007');
        await page.keyboard.press('Shift+F12');
        const peek = page.locator('.peekview-widget');
        await expect(peek).toBeVisible();
        await expect(peek.locator('.head')).toContainText('References (2)');
        await expect(peek.locator('.ref-tree')).toContainText('refs.bib');
    });

    test('rename is refused on plain text', async ({ page }) => {
        await openDemo(page);
        await caretIn(page, 'sections/intro.tex', 'student');
        await page.keyboard.press('F2');
        await expect(page.locator('.rename-box input')).toBeHidden();
        await expect(page.locator('.monaco-editor-overlaymessage')).toContainText('Nothing to rename here');
    });
});
