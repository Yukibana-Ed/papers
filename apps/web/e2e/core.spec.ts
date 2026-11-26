import { expect, test } from '@playwright/test';
import { inside, openComments, openDemo, rect, startReply } from './support.ts';

test.describe('the editor', () => {
    test('types into the source and counts the change as uncommitted', async ({ page }) => {
        await openDemo(page);
        const before = Number((await page.locator('.pending').textContent())?.replace('+', '') ?? 0);
        await page.locator('.monaco-editor .view-lines').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\nTyped in a browser test.');
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('Typed in a browser test.');
        await expect.poll(async () => Number((await page.locator('.pending').textContent())?.replace('+', '') ?? 0)).toBeGreaterThan(before);
    });

    test('loads the content frame from the content origin, cross-origin isolated', async ({ page }) => {
        await openDemo(page);
        const frame = page.locator('iframe.pv-frame');
        await expect(frame).toHaveAttribute('src', /^http:\/\/127\.0\.0\.1:4174\/frame$/);
        expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    });
});

test.describe('comments', () => {
    test('a reply is typed in order and sent', async ({ page }) => {
        await openDemo(page);
        await openComments(page);
        await startReply(page);
        const field = page.locator('.composer .cm-rich');
        await expect(field).toBeFocused();
        await page.keyboard.type('abcd efgh');
        await expect(field).toHaveText('abcd efgh');
        // The caret is after the text: one more key lands at the end.
        await page.keyboard.type('!');
        await expect(field).toHaveText('abcd efgh!');
        await page.locator('.composer button', { hasText: 'Send' }).click();
        await expect(page.locator('.cm-body', { hasText: 'abcd efgh!' })).toBeVisible();
    });

    test('the composer actions stay inside a narrow panel', async ({ page }) => {
        await page.setViewportSize({ width: 820, height: 800 });
        await openDemo(page);
        await openComments(page);
        await startReply(page);
        const row = page.locator('.composer-row').first();
        const r = await rect(row);
        for (const b of await row.locator('button').all()) {
            const br = await rect(b);
            expect(br.x + br.width).toBeLessThanOrEqual(r.x + r.width + 0.5);
        }
    });
});

test.describe('theme', () => {
    test('the rail button switches the page theme', async ({ page }) => {
        await openDemo(page);
        const before = await page.evaluate(() => document.documentElement.dataset['theme'] ?? '');
        await page.locator('nav.rail [data-tip$="theme"]').click();
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset['theme'] ?? '')).not.toBe(before);
    });
});

test.describe('tooltips', () => {
    test('stay inside the viewport at every edge', async ({ page }) => {
        await openDemo(page);
        const size = page.viewportSize() ?? { width: 1440, height: 900 };
        const anchors = [
            page.locator('header.bar .brand'), // top left
            page.locator('header.bar [data-tip="Commands"]'), // top right
            page.locator('nav.rail [data-tip$="theme"]'), // bottom left
            page.locator('.pv-bar .backend'), // right edge
        ];
        for (const a of anchors) {
            await a.hover();
            const tip = page.locator('.tip');
            await expect(tip).toBeVisible();
            await expect.poll(async () => inside(await rect(tip), size), { message: `tip of ${String(a)}` }).toBe(true);
            await page.mouse.move(size.width / 2, size.height / 2);
        }
    });
});

test.describe('new paper', () => {
    test('the dialog opens from the start page', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('link', { name: /new paper/i }).click();
        await expect(page).toHaveURL(/\/new/);
        await expect(page.getByRole('heading').or(page.locator('main')).first()).toBeVisible();
    });
});

test.describe('preview', () => {
    // The TeX engine and TeX Live come from the assets bucket, which local wrangler does not hold in CI. With
    // E2E_ENGINE=1 (a local run with the engine served), the preview builds and the selection toolbar is checked.
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');
    test('selecting text in the preview shows the toolbar', async ({ page }) => {
        await openDemo(page);
        const frame = page.frameLocator('iframe.pv-frame');
        await expect(frame.locator('.textLayer span').first()).toBeVisible({ timeout: 60_000 });
        const span = frame.locator('.textLayer span').nth(20);
        const box = await rect(span);
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
        await page.mouse.up();
        await expect(frame.locator('.pv-toolbar, [role="toolbar"]').first()).toBeVisible();
    });
});
