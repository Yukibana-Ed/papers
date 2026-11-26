import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { state } from '../editor/helpers.ts';
import { openTypstPaper } from '../typst-paper.ts';

/** A Typst paper syncs to the character from the compiler's own record of where each glyph came from: through markup,
 *  repeated words and included files, where aligning the document's words with the source's could only guess. */

const FILES = {
    'main.typ': ['= Sync', 'The same word, the same *word* and the same _word_ again.', '#include "part.typ"', ''].join('\n'),
    'part.typ': 'An included part, with the same word.\n',
};

async function preview(page: Page): Promise<FrameLocator> {
    await openTypstPaper(page, FILES);
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.textLayer span', { hasText: 'included' }).first()).toBeAttached({ timeout: 150_000 });
    await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 60_000 });
    return frame;
}

/** The viewport box of character `index` of the `nth` "word" on the page, in document order. */
async function wordChar(page: Page, frame: FrameLocator, nth: number, index: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const iframe = await page.locator('iframe.pv-frame').boundingBox();
    if (iframe === null) throw new Error('no frame');
    const r = await frame
        .locator('.textLayer')
        .first()
        .evaluate(
            (layer, [n, i]) => {
                const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
                let seen = 0;
                for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                    const data = node.textContent ?? '';
                    for (let at = data.indexOf('word'); at >= 0; at = data.indexOf('word', at + 1)) {
                        if (seen++ !== n) continue;
                        const range = document.createRange();
                        range.setStart(node, at + i);
                        range.setEnd(node, at + i + 1);
                        const b = range.getBoundingClientRect();
                        return { x: b.left, y: b.top, width: b.width, height: b.height };
                    }
                }
                throw new Error(`no "word" number ${n}`);
            },
            [nth, index] as const,
        );
    return { ...r, x: r.x + iframe.x, y: r.y + iframe.y };
}

const activeFile = (page: Page): Promise<string> => page.evaluate(() => (Reflect.get(window, '__papersTest') as { session: { activeFile: string } }).session.activeFile);

test.describe('a Typst paper syncs to the character', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the Typst compiler (E2E_ENGINE=1)');
    test.setTimeout(240_000);

    test('a click in the preview puts the caret on that character, in the file it came from', async ({ page }) => {
        const frame = await preview(page);
        const line = FILES['main.typ'].split('\n')[1] ?? '';
        const words = [...line.matchAll(/word/g)].map(m => m.index);
        // Each "word" of the paragraph, the plain one, the strong one and the emphasised one: its "r".
        for (const [nth, start] of words.entries()) {
            const b = await wordChar(page, frame, nth, 2);
            await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
            await expect.poll(async () => (await state(page)).caret).toEqual({ line: 2, column: start + 2 + 1 });
        }
        // The one in the included file.
        const b = await wordChar(page, frame, 3, 0);
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await expect.poll(() => activeFile(page)).toBe('part.typ');
        await expect.poll(async () => (await state(page)).caret).toEqual({ line: 1, column: FILES['part.typ'].indexOf('word') + 1 });
    });

    test('the caret in the source is shown on its character in the preview', async ({ page }) => {
        const frame = await preview(page);
        const line = FILES['main.typ'].split('\n')[1] ?? '';
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        for (const [nth, m] of [...line.matchAll(/word/g)].entries()) {
            const b = await wordChar(page, frame, nth, 1);
            const box = await frame.locator('.pv-pages').evaluate(
                (_, at) => {
                    const sync = Reflect.get(window, 'papersSync') as {
                        precise: { locate(at: { file: string; line: number; column: number }): { x: number; width: number } | null };
                        pages: { view: number[] }[];
                    };
                    const first = document.querySelector('.pv-page');
                    const located = sync.precise.locate(at);
                    const width = sync.pages[0]?.view[2];
                    if (located === null || first === null || width === undefined) return null;
                    const r = first.getBoundingClientRect();
                    const scale = r.width / width;
                    return { x: r.left + located.x * scale, width: located.width * scale };
                },
                { file: 'main.typ', line: 2, column: m.index + 1 },
            );
            expect(box).not.toBeNull();
            expect(Math.abs((box?.x ?? 0) + (iframe?.x ?? 0) - b.x)).toBeLessThan(1.5);
            expect(Math.abs((box?.width ?? 0) - b.width)).toBeLessThan(1.5);
        }
    });
});
