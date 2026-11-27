import { expect, test, type Locator, type Page } from '@playwright/test';
import { openDemo, rect } from './support.ts';

/** The layout: the files' tabs and Preview, in groups that can be rearranged (shell/dock.svelte.ts). */

const tab = (page: Page, name: string): Locator => page.locator('.dv-tab', { hasText: name });
/** The group (its tabs and what they show) that has the tab named `name`. */
const groupOf = (page: Page, name: string): Locator => page.locator('.dv-groupview', { has: tab(page, name) });

/** The file the session has in front. */
const front = (page: Page): Promise<unknown> => page.evaluate(() => (Reflect.get(window, '__papersTest') as { session: { activeFile: string } }).session.activeFile);

/** Drags from the middle of `from` to the point `at` picks in `to`'s rectangle, as a person would: in steps. */
async function drag(page: Page, from: Locator, to: Locator, at: (r: { x: number; y: number; width: number; height: number }) => [number, number]): Promise<void> {
    const a = await rect(from);
    const [x, y] = at(await rect(to));
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 });
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.move(x + 1, y + 1, { steps: 2 });
    await page.mouse.up();
}

test.describe('the dock', () => {
    test('a tab brings its file to the front, and its close button closes it', async ({ page }) => {
        await openDemo(page);
        await expect(tab(page, 'intro.tex')).toHaveAttribute('aria-selected', 'true');
        await tab(page, 'paper.tex').click();
        await expect.poll(() => front(page)).toBe('paper.tex');
        await expect(tab(page, 'paper.tex')).toHaveAttribute('aria-selected', 'true');
        // The editor is in the tab's panel, the size of it.
        const editor = await rect(page.locator('.monaco-editor').first());
        const group = await rect(groupOf(page, 'paper.tex'));
        expect(editor.width).toBeGreaterThan(group.width - 4);
        await tab(page, 'paper.tex').hover();
        await tab(page, 'paper.tex').locator('.tab-x').click();
        await expect(tab(page, 'paper.tex')).toHaveCount(0);
        await expect.poll(() => front(page)).toBe('sections/intro.tex');
        // The last tab stays.
        await tab(page, 'intro.tex').locator('.tab-x').click();
        await expect(tab(page, 'intro.tex')).toHaveCount(1);
    });

    test("an edited file's dot sits where the close button shows, and the tab keeps its width", async ({ page }) => {
        await openDemo(page);
        const intro = tab(page, 'intro.tex');
        const clean = (await rect(intro)).width;
        await page.locator('.monaco-editor .view-lines').click();
        await page.keyboard.type('x');
        // Another tab in front, the pointer away: the edited tab shows its dot.
        await tab(page, 'paper.tex').click();
        await page.mouse.move(0, 400);
        const dot = await rect(intro.locator('.tab-dot'));
        const x = await rect(intro.locator('.tab-x'));
        expect(Math.abs(dot.x + dot.width / 2 - (x.x + x.width / 2))).toBeLessThan(0.6);
        expect(Math.abs(dot.y + dot.height / 2 - (x.y + x.height / 2))).toBeLessThan(0.6);
        expect((await rect(intro)).width).toBe(clean);
        await intro.hover();
        await expect(intro.locator('.tab-dot')).toBeHidden();
        await expect(intro.locator('.tab-x')).toHaveCSS('opacity', '1');
        expect((await rect(intro)).width).toBe(clean);
    });

    test('Preview goes where it is dragged, without loading again; a file stays among the files', async ({ page }) => {
        await openDemo(page);
        const frame = page.frameLocator('iframe.pv-frame');
        await expect(frame.locator('.pv-pages')).toBeAttached({ timeout: 30_000 });
        // A mark in the frame's page: gone if the frame loads again.
        await frame.locator('body').evaluate(() => Reflect.set(window, 'markedByTest', true));
        const marked = (): Promise<boolean> => frame.locator('body').evaluate(() => Reflect.get(window, 'markedByTest') === true);
        const files = groupOf(page, 'intro.tex');
        const previewLeft = async (): Promise<number> => (await rect(page.locator('iframe.pv-frame'))).x;
        const filesLeft = async (): Promise<number> => (await rect(files)).x;
        expect(await previewLeft()).toBeGreaterThan(await filesLeft());

        // To the left of the files.
        await drag(page, tab(page, 'Preview'), files.locator('.dv-content-container'), r => [r.x + 30, r.y + r.height / 2]);
        await expect.poll(async () => (await previewLeft()) < (await filesLeft())).toBe(true);
        expect(await marked()).toBe(true);

        // Among the files' tabs: one group, Preview in front.
        await drag(page, tab(page, 'Preview'), tab(page, 'intro.tex'), r => [r.x + r.width / 2, r.y + r.height / 2]);
        await expect(page.locator('.dv-groupview')).toHaveCount(1);
        await expect(page.locator('iframe.pv-frame')).toBeVisible();
        expect(await marked()).toBe(true);
        // A file's tab brings the editor back, and opening another file does too while Preview is in front.
        await tab(page, 'intro.tex').click();
        await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
        await tab(page, 'Preview').click();
        await expect(page.locator('.monaco-editor .view-lines')).toBeHidden();
        await page.keyboard.press('Control+Shift+E');
        await page.locator('.filelist .row-btn', { hasText: 'method.tex' }).click();
        await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
        await expect(tab(page, 'method.tex')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Control+Shift+E');

        // Out again, to the right; then a file's tab dragged to where Preview is stays where it was.
        await drag(page, tab(page, 'Preview'), page.locator('.dv-content-container').first(), r => [r.x + r.width - 30, r.y + r.height / 2]);
        await expect(page.locator('.dv-groupview')).toHaveCount(2);
        expect(await previewLeft()).toBeGreaterThan(await filesLeft());
        expect(await marked()).toBe(true);
        await drag(page, tab(page, 'intro.tex'), page.locator('iframe.pv-frame'), r => [r.x + r.width / 2, r.y + r.height / 2]);
        await expect(page.locator('.dv-groupview')).toHaveCount(2);
        await expect(groupOf(page, 'Preview').locator('.dv-tab')).toHaveCount(1);
        // Among the files it moves: to the front of the row.
        await drag(page, tab(page, 'method.tex'), tab(page, 'paper.tex'), r => [r.x + 6, r.y + r.height / 2]);
        await expect(files.locator('.dv-tab').first()).toContainText('method.tex');
    });

    test('the layout is kept for the next visit', async ({ page }) => {
        await openDemo(page);
        const files = groupOf(page, 'intro.tex');
        const preview = groupOf(page, 'Preview');
        await drag(page, tab(page, 'Preview'), files.locator('.dv-content-container'), r => [r.x + r.width / 2, r.y + r.height - 40]);
        await expect.poll(async () => (await rect(preview)).y > (await rect(files)).y).toBe(true);
        // Written a moment after the last change.
        await expect.poll(() => page.evaluate(() => localStorage.getItem('papers.dock') !== null)).toBe(true);
        await page.waitForTimeout(400);
        await page.reload();
        await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 30_000 });
        expect((await rect(preview)).y).toBeGreaterThan((await rect(files)).y);
        await expect(tab(page, 'intro.tex')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.dv-tab')).toHaveCount(3);
    });
});

test.describe('the dock on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('Preview is a tab beside the files, and the switch at the top brings either to the front', async ({ page }) => {
        await openDemo(page);
        await expect(page.locator('.dv-groupview')).toHaveCount(1);
        await expect(tab(page, 'intro.tex')).toHaveAttribute('aria-selected', 'true');
        await page.getByRole('button', { name: 'Preview' }).click();
        await expect(tab(page, 'Preview')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('iframe.pv-frame')).toBeVisible();
        await expect(page.locator('.monaco-editor .view-lines')).toBeHidden();
        // The tabs that do not fit beside the preview's controls are in the bar's list; the switch always shows.
        await page.getByRole('button', { name: 'Source' }).click();
        await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
        await expect(tab(page, 'intro.tex')).toHaveAttribute('aria-selected', 'true');
        await tab(page, 'Preview').tap();
        await expect(page.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('iframe.pv-frame')).toBeVisible();
    });
});
