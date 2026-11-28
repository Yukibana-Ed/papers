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

    test('Shift with Down and Up moves the end of the selection line by line, in its column and at its place across', async ({ page }) => {
        const frame = await preview(page);
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const pageWidth = await frame
            .locator('.pv-page')
            .first()
            .evaluate(el => el.getBoundingClientRect().width);
        const run = frame.locator('.textLayer span[data-run]', { hasText: 'Paragraph 2' }).first();
        const box = await run.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        await page.mouse.dblclick(iframe.x + box.x + box.width / 2, iframe.y + box.y + box.height / 2);
        await expect.poll(async () => (await selected(frame)).text.length).toBeGreaterThan(0);
        const word = await selected(frame);
        const end = Math.max(...word.rects.map(r => r.x + r.width));
        /** The lines the selection is drawn on (the middles of its rectangles, one per line), top to bottom. */
        const lines = (rects: Box[]): number[] => {
            const out: number[] = [];
            for (const y of rects.map(r => r.y + r.height / 2).toSorted((a, b) => a - b)) if (out.length === 0 || y - (out.at(-1) ?? 0) > box.height / 2) out.push(y);
            return out;
        };
        /** The right edge of the selection on its last line, or the left edge on its first. */
        const edge = (rects: Box[], last: boolean): number => {
            const ys = lines(rects);
            const y = last ? ys.at(-1) : ys[0];
            const on = rects.filter(r => Math.abs(r.y + r.height / 2 - (y ?? 0)) <= box.height / 2);
            return last ? Math.max(...on.map(r => r.x + r.width)) : Math.min(...on.map(r => r.x));
        };
        for (const count of [2, 3, 4]) {
            await page.keyboard.press('Shift+ArrowDown');
            await expect.poll(async () => lines((await selected(frame)).rects).length, { message: `${count} lines` }).toBe(count);
            const got = await selected(frame);
            expect(got.text.startsWith(word.text)).toBe(true);
            // Where the word ended, give or take a character, and still in the word's column.
            expect(Math.abs(edge(got.rects, true) - end), `${count} lines: ${got.text}`).toBeLessThan(8);
            expect(Math.max(...got.rects.map(r => r.x + r.width)) - Math.min(...got.rects.map(r => r.x))).toBeLessThan(pageWidth / 2);
        }
        // The source follows.
        await expect.poll(async () => (await state(page)).selection.length).toBeGreaterThan(word.text.length + 100);
        for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowUp');
        await expect.poll(async () => (await selected(frame)).text).toBe(word.text);
        // Up past the line the selection started on: it turns over, its end in the line above at the same place.
        await page.keyboard.press('Shift+ArrowUp');
        await expect.poll(async () => lines((await selected(frame)).rects).length).toBe(2);
        const above = await selected(frame);
        expect(above.text.endsWith(word.text)).toBe(false);
        expect(Math.abs(edge(above.rects, false) - end), above.text).toBeLessThan(8);
    });
});
