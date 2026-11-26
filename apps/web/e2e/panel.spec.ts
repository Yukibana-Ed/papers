import { expect, test } from '@playwright/test';
import { openDemo } from './support.ts';

/** The side panel's right edge is a handle: dragging it resizes the panel within its limits, the keyboard does the
 *  same, a double click resets it, and the width is still there after a reload. */
test('the side panel is resized by its edge and keeps its width', async ({ page }) => {
    await openDemo(page);
    await page.keyboard.press('Control+Shift+E');
    const panel = page.locator('aside.panel');
    const handle = page.getByRole('separator', { name: 'Resize' });
    const width = async (): Promise<number> => Math.round((await panel.boundingBox())?.width ?? 0);
    expect(await width()).toBe(300);

    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 2 + 120, y, { steps: 6 });
    await page.mouse.up();
    expect(Math.abs((await width()) - 420)).toBeLessThanOrEqual(3);
    // The editor took what the panel gave up: the two still fill the window.
    const dock = (await page.locator('.dock').boundingBox())!;
    expect(Math.round(dock.x)).toBe(44 + (await width()));

    // Limits: no narrower than 200, no wider than 640.
    await page.mouse.move(dock.x - 2, y);
    await page.mouse.down();
    await page.mouse.move(50, y, { steps: 6 });
    expect(await width()).toBe(200);
    await page.mouse.move(1200, y, { steps: 6 });
    await page.mouse.up();
    expect(await width()).toBe(640);

    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    expect(await width()).toBe(624);

    await page.reload();
    await expect(panel).toHaveCount(0);
    await page.locator('.monaco-editor .view-lines').waitFor();
    await page.keyboard.press('Control+Shift+E');
    await expect.poll(width).toBe(624);

    await handle.dblclick();
    expect(await width()).toBe(300);
});
