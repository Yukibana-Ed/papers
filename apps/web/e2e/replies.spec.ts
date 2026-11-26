import { expect, test, type Locator, type Page } from '@playwright/test';
import { openComments, openDemo } from './support.ts';

/** Types `text` into the composer that `field` opens and sends it with Ctrl+Enter. */
async function reply(page: Page, field: Locator, text: string, keyboard: boolean): Promise<void> {
    if (keyboard) {
        await field.focus();
        await page.keyboard.press('Enter');
    } else await field.click();
    const editor = page.locator('.composer .cm-rich');
    await expect(editor).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press('Control+Enter');
}

test.describe('every kind of thread can be replied to', () => {
    for (const keyboard of [false, true]) {
        const how = keyboard ? 'keyboard' : 'mouse';

        test(`a thread with replies, never made current first (${how})`, async ({ page }) => {
            await openDemo(page);
            await openComments(page);
            // Every open thread shows its reply field, not only the current or hovered one.
            const cards = page.locator('.cm-card:not(.is-resolved):not(.sg-card)');
            const count = await cards.count();
            expect(count).toBeGreaterThan(1);
            for (let i = 0; i < count; i++) await expect(cards.nth(i).locator('button.cm-reply-field')).toBeVisible();
            const last = cards.nth(count - 1);
            await reply(page, last.locator('button.cm-reply-field'), `to the last thread by ${how}`, keyboard);
            await expect(last.locator('.cm-body', { hasText: `to the last thread by ${how}` })).toBeVisible();
        });

        test(`a reply inside a thread starts a sub-thread (${how})`, async ({ page }) => {
            await openDemo(page);
            await openComments(page);
            const link = page.locator('.cm-card button.cm-link', { hasText: 'Reply' }).first();
            await expect(link).toBeVisible();
            await reply(page, link, `sub-thread by ${how}`, keyboard);
            await expect(page.locator('.cm-body', { hasText: `sub-thread by ${how}` })).toBeVisible();
        });

        test(`a suggestion can be discussed (${how})`, async ({ page }) => {
            await openDemo(page);
            await openComments(page);
            const card = page.locator('.cm-card.sg-card').first();
            await reply(page, card.locator('button.cm-reply-field'), `about this suggestion by ${how}`, keyboard);
            await expect(page.locator('.cm-card:not(.sg-card) .cm-body', { hasText: `about this suggestion by ${how}` })).toBeVisible();
        });

        test(`a comment just created can be replied to (${how})`, async ({ page }) => {
            await openDemo(page);
            await openComments(page);
            // Select a word in the source and comment on it.
            await page.locator('.monaco-editor .view-lines').click();
            await page.keyboard.press('Control+Home');
            await page.keyboard.press('Shift+End');
            await page.keyboard.press('Control+Alt+M');
            await page.keyboard.type(`new comment by ${how}`);
            await page.keyboard.press('Control+Enter');
            const card = page.locator('.cm-card', { has: page.locator('.cm-body', { hasText: `new comment by ${how}` }) });
            await expect(card).toBeVisible();
            await reply(page, card.locator('button.cm-reply-field'), `answer by ${how}`, keyboard);
            await expect(card.locator('.cm-body', { hasText: `answer by ${how}` })).toBeVisible();
        });
    }

    test('a resolved thread offers Reopen instead of a reply field', async ({ page }) => {
        await openDemo(page);
        await openComments(page);
        await page.locator('.panel-head button', { hasText: /\d/ }).first().click(); // show resolved
        const resolved = page.locator('.cm-card.is-resolved').first();
        await expect(resolved.locator('[data-tip="Reopen"]')).toBeVisible();
        await expect(resolved.locator('button.cm-reply-field')).toHaveCount(0);
    });
});
