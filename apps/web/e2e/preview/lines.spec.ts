import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { state } from '../editor/helpers.ts';
import { TWO_COLUMNS } from '../fixtures/two-columns.ts';
import { openPaper } from '../typst-paper.ts';

/** Three clicks in the preview select the typeset line under the pointer, and no more, wherever on the page. */

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

async function preview(page: Page): Promise<FrameLocator> {
    await openPaper(page, TWO_COLUMNS, { format: 'latex', engine: 'pdflatex', root: 'main.tex' });
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 170_000 });
    return frame;
}

/** The preview's selection: its text and its rectangles, in the frame's viewport. */
const selected = (frame: FrameLocator): Promise<{ text: string; rects: Box[] }> =>
    frame.locator('body').evaluate(() => {
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return { text: '', rects: [] };
        const rects = [...selection.getRangeAt(0).getClientRects()].filter(r => r.width > 0).map(r => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
        return { text: selection.toString(), rects };
    });

test.describe('three clicks in the preview', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    test('select the line under the pointer in its own column, from any run of the page', async ({ page }) => {
        const frame = await preview(page);
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const first = frame.locator('.pv-page').first();
        const pageBox = await first.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        const count = await first.locator('.textLayer span[data-run]').count();
        expect(count).toBeGreaterThan(60);
        let checked = 0;
        for (let i = 0; i < count; i += 7) {
            const run = first.locator('.textLayer span[data-run]').nth(i);
            const text = ((await run.textContent()) ?? '').trim();
            if (text.length < 3) continue;
            // The selection before goes, and its toolbar with it, which may lie over this run.
            await frame.locator('body').evaluate(() => window.getSelection()?.removeAllRanges());
            await expect(frame.locator('.pv-toolbar')).toBeHidden();
            await run.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
            const box = await run.evaluate(el => {
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width, height: r.height };
            });
            await page.mouse.click(iframe.x + box.x + box.width / 2, iframe.y + box.y + box.height / 2, { clickCount: 3 });
            const got = await selected(frame);
            expect(got.text, `run ${i}: ${text}`).toContain(text);
            // One line: every rectangle level with the run clicked, and all of them within one column.
            for (const r of got.rects) expect(Math.abs(r.y + r.height / 2 - (box.y + box.height / 2)), `run ${i}: ${got.text}`).toBeLessThan(box.height);
            const left = Math.min(...got.rects.map(r => r.x));
            const right = Math.max(...got.rects.map(r => r.x + r.width));
            expect(right - left, `run ${i}: ${got.text}`).toBeLessThan(pageBox.width / 2);
            // The source's selection is that line's words, not the paragraph's or the page's.
            await expect.poll(async () => (await state(page)).selection.length, { message: `run ${i}: ${got.text}` }).toBeGreaterThan(0);
            expect((await state(page)).selection.length, `run ${i}: ${got.text}`).toBeLessThan(got.text.length + 40);
            checked++;
        }
        expect(checked).toBeGreaterThan(8);
    });

    test('select nothing where no line is, and the line again after a word was picked there', async ({ page }) => {
        const frame = await preview(page);
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const pageBox = await frame
            .locator('.pv-page')
            .first()
            .evaluate(el => {
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width };
            });
        // The page's top margin.
        await page.mouse.click(iframe.x + pageBox.x + pageBox.width / 2, iframe.y + pageBox.y + 12, { clickCount: 3 });
        expect((await selected(frame)).text).toBe('');

        const run = frame.locator('.textLayer span[data-run]', { hasText: 'Paragraph 2' }).first();
        const box = await run.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        const at = { x: iframe.x + box.x + box.width / 2, y: iframe.y + box.y + box.height / 2 };
        await page.mouse.dblclick(at.x, at.y);
        await expect.poll(async () => (await selected(frame)).text.length).toBeGreaterThan(0);
        await page.mouse.click(at.x, at.y, { clickCount: 3 });
        const got = await selected(frame);
        expect(got.text).toContain('Paragraph 2');
        for (const r of got.rects) expect(Math.abs(r.y + r.height / 2 - (box.y + box.height / 2))).toBeLessThan(box.height);
        expect(Math.max(...got.rects.map(r => r.x + r.width)) - Math.min(...got.rects.map(r => r.x))).toBeLessThan(pageBox.width / 2);
    });
});
