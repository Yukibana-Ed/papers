import { expect, type Locator, type Page } from '@playwright/test';

/** Opens the demo and waits until the source editor is ready to type in. */
export async function openDemo(page: Page): Promise<void> {
    await page.goto('/demo');
    await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 30_000 });
}

/** Opens the comments panel (Ctrl+Shift+M) and waits for its cards. */
export async function openComments(page: Page): Promise<void> {
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+Shift+M');
    await expect(page.locator('.cm-list')).toBeVisible();
}

/** The rectangle of `l`, which must be visible. */
export async function rect(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await l.boundingBox();
    if (!box) throw new Error('not visible');
    return box;
}

/** Whether `r` lies inside a viewport of `size`. */
export function inside(r: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }): boolean {
    return r.x >= 0 && r.y >= 0 && r.x + r.width <= size.width && r.y + r.height <= size.height;
}

/** Opens a reply composer on the first open thread: its card is made current (its actions show), then Reply. */
export async function startReply(page: Page): Promise<void> {
    const card = page.locator('.cm-card:not(.is-resolved):not(.sg-card)').first();
    await card.locator('.cm-head').first().click();
    await card.locator('button.cm-link', { hasText: 'Reply' }).first().click();
}
