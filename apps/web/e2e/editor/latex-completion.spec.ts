import { expect, test, type Page } from '@playwright/test';
import { caretAt, openDemo } from './helpers.ts';

/** LaTeX completion in the editor itself, from the project's files: what the suggest widget offers where, and how
 *  soon. The demo: sections/intro.tex, with refs.bib (becker2019, hattie2007, edwards2004). */

/** Types `text` at the end of sections/intro.tex on a new line, and returns the suggest widget's labels and how long it
 *  took to show them after the last key. */
async function suggest(page: Page, text: string): Promise<{ labels: string[]; ms: number }> {
    await caretAt(page, 'sections/intro.tex', 18, 1);
    await page.keyboard.press('Enter');
    await page.keyboard.type(text.slice(0, -1));
    const t0 = Date.now();
    await page.keyboard.type(text.slice(-1));
    const widget = page.locator('.suggest-widget.visible .monaco-list-row');
    await expect(widget.first()).toBeVisible({ timeout: 2000 });
    const ms = Date.now() - t0;
    const labels = await widget.evaluateAll(rows => rows.map(r => r.querySelector('.label-name')?.textContent ?? ''));
    return { labels, ms };
}

test.describe('LaTeX completion', () => {
    test('commands after a backslash', async ({ page }) => {
        await openDemo(page);
        const r = await suggest(page, '\\textb');
        expect(r.labels).toContain('\\textbf');
        expect(r.ms).toBeLessThan(500);
    });

    test('environments after \\begin{, inserted with their \\end', async ({ page }) => {
        await openDemo(page);
        const r = await suggest(page, '\\begin{ite');
        expect(r.labels).toContain('itemize');
        await page.keyboard.press('Enter');
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('\\end{itemize}');
    });

    test('citations from the project’s bibliography', async ({ page }) => {
        await openDemo(page);
        const r = await suggest(page, '\\cite{');
        expect(r.labels).toEqual(expect.arrayContaining(['becker2019', 'hattie2007', 'edwards2004']));
        expect(r.ms).toBeLessThan(500);
    });

    test('labels from every file, including one just typed', async ({ page }) => {
        await openDemo(page);
        await caretAt(page, 'sections/method.tex', 1, 1);
        await page.keyboard.type('\\label{sec:typed}');
        const r = await suggest(page, '\\ref{');
        expect(r.labels).toContain('sec:typed');
    });

    test('packages and files', async ({ page }) => {
        await openDemo(page);
        expect((await suggest(page, '\\usepackage{gra')).labels).toContain('graphicx');
        await page.keyboard.press('Escape');
        expect((await suggest(page, '\\input{')).labels).toEqual(expect.arrayContaining(['method.tex', 'results.tex']));
    });
});
