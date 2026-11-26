import { expect, test } from '@playwright/test';
import { openDemo } from './support.ts';

/** The file list is a tree: a folder is a row of its own, before the files in it, and opens and closes. */
test('the file list shows folders, which close and open, and the folder of the open file is open', async ({ page }) => {
    await openDemo(page);
    await page.keyboard.press('Control+Shift+E');
    const rows = page.locator('.filelist li');
    const names = async (): Promise<string[]> => (await rows.allInnerTexts()).map(t => t.split('\n')[0]?.trim() ?? '');
    await expect.poll(names).toEqual(['brief', 'brief.typ', 'findings.typ', 'sections', 'intro.tex', 'method.tex', 'results.tex', 'paper.tex', 'refs.bib', 'slides.tex']);
    const folder = page.locator('.filelist .folder', { hasText: 'sections' });
    await expect(page.locator('.filelist .folder')).toHaveCount(2);
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    // The files of the folder are further in than the folder's own row.
    const left = (name: string): Promise<number> =>
        page
            .locator('.filelist .row-btn', { hasText: name })
            .locator('span')
            .first()
            .evaluate(e => e.getBoundingClientRect().left);
    expect(await left('intro.tex')).toBeGreaterThan(await left('sections'));

    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(names).toEqual(['brief', 'brief.typ', 'findings.typ', 'sections', 'paper.tex', 'refs.bib', 'slides.tex']);
    // By the keyboard, as a tree: Right opens, Left closes, Down and Up move between rows.
    await folder.press('ArrowRight');
    await expect.poll(names).toHaveLength(10);
    await folder.press('ArrowDown');
    await expect(page.locator('.filelist .row-btn', { hasText: 'intro.tex' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(folder).toBeFocused();
    await folder.press('ArrowLeft');
    await expect.poll(names).toHaveLength(7);
    // Closed folders are kept for the project.
    await page.reload();
    await page.waitForFunction(() => Reflect.get(window, '__papersTest') !== undefined);
    await page.keyboard.press('Control+Shift+E');
    await expect(page.locator('.filelist .folder', { hasText: 'brief' })).toHaveAttribute('aria-expanded', 'true');

    // Opening a file of a closed folder (from anywhere: a tab, a problem, the palette) opens the folder: the list shows
    // where one is.
    await page.evaluate(() => (Reflect.get(window, '__papersTest') as { session: { openFile(f: string): void } }).session.openFile('sections/method.tex'));
    await expect(page.locator('.filelist .row-btn.is-current')).toContainText('method.tex');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
});
