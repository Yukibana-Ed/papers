import { expect, test, type Page } from '@playwright/test';

/** The demo with build results fed by the test (`?test-frame`: see Preview.svelte), since CI serves no TeX engine. */
async function openDemo(page: Page): Promise<void> {
    await page.goto('/demo?test-frame');
    await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 30_000 });
}

/** Delivers `message` as if the content frame had sent it. */
async function frame(page: Page, message: unknown): Promise<void> {
    await page.evaluate(m => (window as unknown as { papersTestFrame: (m: unknown) => void }).papersTestFrame(m), message);
}

const ok = (pages: number, diagnostics: unknown[] = []): unknown => ({ type: 'built', ok: true, pages, ms: 120, diagnostics, log: 'Output written.' });
const failed = (pages: number, line: number): unknown => ({
    type: 'built',
    ok: false,
    pages,
    ms: 90,
    diagnostics: [{ file: 'sections/intro.tex', line, severity: 'error', message: 'Undefined control sequence.', excerpt: `l.${line} \\foo` }],
    log: `! Undefined control sequence.\nl.${line} \\foo`,
});

async function editorHasFocus(page: Page): Promise<boolean> {
    return page.evaluate(() => document.activeElement?.closest('.monaco-editor') !== null);
}

test.describe('problems', () => {
    test('breaking the paper while typing shows the error in the preview and at the line, without opening anything', async ({ page }) => {
        await openDemo(page);
        await frame(page, ok(2));
        await page.locator('.monaco-editor .view-lines').click();
        await page.keyboard.press('Control+Home');
        await page.keyboard.type('\\foo ');
        await frame(page, failed(2, 1));
        // After the pause in typing: the list at the top of the preview, the stale PDF below, the message at the line.
        await expect(page.locator('.pv-errors')).toBeVisible();
        await expect(page.locator('.pv-error.first')).toContainText('Unknown command \\foo');
        await expect(page.locator('.pv-error.first')).toContainText('intro.tex:1');
        await expect(page.locator('.pv-body.has-errors:not(.no-pdf) iframe.pv-frame')).toBeVisible();
        await expect(page.locator('.monaco-editor .inline-problem')).toContainText('Unknown command \\foo');
        expect(await editorHasFocus(page)).toBe(true);
        await expect(page.locator('aside.panel')).toHaveCount(0);

        // Fixed: both go away and the PDF is back.
        for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
        await frame(page, ok(2));
        await expect(page.locator('.pv-errors')).toHaveCount(0);
        await expect(page.locator('.monaco-editor .inline-problem')).toHaveCount(0);
        await expect(page.locator('.pv-body.has-errors')).toHaveCount(0);
    });

    test('does not show errors while typing goes on', async ({ page }) => {
        await openDemo(page);
        await page.locator('.monaco-editor .view-lines').click();
        await page.keyboard.press('Control+Home');
        await page.keyboard.type('x');
        // The build of that edit fails while typing goes on: the error waits for the pause.
        await frame(page, failed(0, 1));
        for (let i = 0; i < 6; i++) {
            await page.keyboard.type('x');
            await page.waitForTimeout(250);
            await expect(page.locator('.pv-errors')).toHaveCount(0);
        }
        await expect(page.locator('.pv-errors')).toBeVisible();
    });

    test('a failed first build fills the preview with its errors and the log is one click away', async ({ page }) => {
        await openDemo(page);
        await frame(page, failed(0, 3));
        await expect(page.locator('.pv-body.no-pdf .pv-errors')).toBeVisible();
        await page.locator('.pv-errors-head button', { hasText: 'Log' }).click();
        await expect(page.locator('.prob-log')).toContainText('Undefined control sequence');
    });

    test('warnings leave the preview alone and a quiet count opens Problems', async ({ page }) => {
        await openDemo(page);
        await frame(page, ok(2, [{ file: 'sections/method.tex', line: 9, severity: 'warning', message: "Citation `nobody' on page 2 undefined" }]));
        await expect(page.locator('.pv-errors')).toHaveCount(0);
        await page.locator('.pv-count.sev-warning').click();
        await expect(page.locator('aside.panel-problems')).toBeVisible();
        await expect(page.locator('.prob-row')).toContainText('Undefined citation nobody');
    });

    test('jumps from Problems to the source with the mouse, Enter and F8', async ({ page }) => {
        await openDemo(page);
        await frame(page, ok(2, [{ file: 'sections/method.tex', line: 9, severity: 'warning', message: "Reference `fig:x' on page 2 undefined" }]));
        await page.locator('.monaco-editor .view-lines').click();
        await page.keyboard.press('Control+Shift+Y');
        const row = page.locator('.prob-row').first();
        await row.click();
        await expect(page.locator('.dv-tab[aria-selected="true"]:has(.file-tab)')).toContainText('method.tex');
        await expect(page.locator('.monaco-editor .line-numbers.active-line-number')).toContainText('9');
        // Enter on a focused row does the same.
        await page.locator('.dv-tab', { hasText: 'intro.tex' }).click();
        await row.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.dv-tab[aria-selected="true"]:has(.file-tab)')).toContainText('method.tex');
        // Back to the other file, then F8 goes to the next problem.
        await page.locator('.dv-tab', { hasText: 'intro.tex' }).click();
        await page.locator('.monaco-editor .view-lines').click();
        await page.keyboard.press('F8');
        await expect(page.locator('.dv-tab[aria-selected="true"]:has(.file-tab)')).toContainText('method.tex');
    });

    test('a build service that did not load is not shown as a problem with the paper', async ({ page }) => {
        await openDemo(page);
        await frame(page, { type: 'service', failure: { what: 'tex-engine', detail: 'busytex.wasm: HTTP 404' } });
        await expect(page.locator('.pv-service')).toContainText('The TeX engine did not load');
        await expect(page.locator('.pv-service')).toContainText('busytex.wasm: HTTP 404');
        await expect(page.locator('.pv-errors')).toHaveCount(0);
        await expect(page.locator('.pv-count')).toHaveCount(0);
        await page.locator('.pv-service button', { hasText: 'Retry' }).click();
        await expect(page.locator('.pv-service')).toHaveCount(0);
    });
});

test.describe('problems, from the real frame', () => {
    // CI and local wrangler serve no engine: the real frame must say so as a service failure, with what was missing.
    test.skip(Boolean(process.env['E2E_ENGINE']), 'the engine is served');
    test('the missing TeX engine shows itself as a service failure with the HTTP status', async ({ page }) => {
        await page.goto('/demo');
        await expect(page.locator('.pv-service')).toContainText('The TeX engine did not load', { timeout: 60_000 });
        await expect(page.locator('.pv-service')).toContainText('HTTP 404');
    });
});
