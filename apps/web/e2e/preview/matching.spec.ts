import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { caretAt, state } from '../editor/helpers.ts';
import { SLIDES } from '../fixtures/slides.ts';
import { TABLE_PAPER } from '../fixtures/table-paper.ts';
import { TWO_COLUMNS } from '../fixtures/two-columns.ts';
import { openPaper } from '../typst-paper.ts';

/** The sync to the word is right or says nothing, over a whole paper: one with a table whose rows repeat the same few
 *  words, cells that come from macros, a float's caption and the same paragraph many times over. */

async function preview(page: Page): Promise<FrameLocator> {
    await openPaper(page, TABLE_PAPER, { format: 'latex', engine: 'pdflatex', root: 'main.tex' });
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 170_000 });
    return frame;
}

const scrollTop = (frame: FrameLocator): Promise<number> =>
    frame
        .locator('.pv-pages')
        .locator('..')
        .evaluate(el => el.scrollTop);

/** Waits until the preview has stopped gliding, and gives where it is. */
async function settled(frame: FrameLocator): Promise<number> {
    let before = -1;
    await expect
        .poll(
            async () => {
                const now = await scrollTop(frame);
                const still = now === before;
                before = now;
                return still;
            },
            { intervals: [250] },
        )
        .toBe(true);
    return before;
}

test.describe('matching source and preview', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    for (const [name, paper] of [
        ['a table, a float and repeated paragraphs', TABLE_PAPER],
        ['two columns', TWO_COLUMNS],
    ] as const) {
        test(`every place in the source shows where its line does or nowhere, and every word leads back to itself: ${name}`, async ({ page }) => {
            await openPaper(page, paper, { format: 'latex', engine: 'pdflatex', root: 'main.tex' });
            const frame = page.frameLocator('iframe.pv-frame');
            await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 170_000 });
            const report = await frame.locator('body').evaluate((_body, files) => {
                interface Box {
                    page: number;
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                }
                interface Maps {
                    words: { text: string; parts: Box[]; at?: { page: number; run: number; offset: number } }[];
                    precise: {
                        locate(at: { file: string; line: number; column: number }): Box | null;
                        charToSource(page: number, run: number, offset: number): { file: string; line: number; column: number } | null;
                    };
                    coarse: { segments(file: string, line: number, merged?: boolean): Box[] };
                }
                const maps = Reflect.get(window, 'papersSync') as Maps;
                const far: string[] = [];
                for (const [file, text] of Object.entries(files)) {
                    text.split('\n').forEach((source, i) => {
                        const line = i + 1;
                        const bands: Box[] = [];
                        for (let l = line - 3; l <= line + 3; l++) bands.push(...maps.coarse.segments(file, l, false));
                        for (let column = 0; column <= source.length; column++) {
                            const box = maps.precise.locate({ file, line, column });
                            if (box !== null && !bands.some(b => b.page === box.page && Math.abs(b.y - box.y) < 20)) far.push(`${file}:${line}:${column} on page ${box.page}`);
                        }
                    });
                }
                const astray: string[] = [];
                let back = 0;
                for (const word of maps.words) {
                    const part = word.parts[0];
                    if (word.at === undefined || part === undefined) continue;
                    const source = maps.precise.charToSource(word.at.page, word.at.run, word.at.offset);
                    if (source === null) continue;
                    const box = maps.precise.locate(source);
                    if (box !== null && box.page === part.page && Math.abs(box.x - part.x) < 1.5 && Math.abs(box.y - part.y) < 2) back++;
                    else astray.push(`"${word.text}" on page ${part.page} → ${source.file}:${source.line}:${source.column}`);
                }
                return { far, astray, back, words: maps.words.length };
            }, paper);
            expect(report.far).toEqual([]);
            expect(report.astray).toEqual([]);
            // Nearly every word has a source: all but numbers and labels the document makes itself.
            expect(report.back).toBeGreaterThan(report.words * 0.95);
        });
    }

    test('extending a selection along a table row never moves the preview', async ({ page }) => {
        const frame = await preview(page);
        const row = TABLE_PAPER['table-set.tex'].split('\n').findIndex(l => l.startsWith('T04')) + 1;
        await caretAt(page, 'table-set.tex', row, 1);
        // The preview glides to the table once; from there on the row is in view.
        const at = await settled(frame);
        const length = (TABLE_PAPER['table-set.tex'].split('\n')[row - 1] ?? '').length;
        for (let i = 0; i < length; i++) {
            await page.keyboard.press('Shift+ArrowRight');
            if (i % 10 === 9) expect(await settled(frame)).toBe(at);
        }
        expect(await settled(frame)).toBe(at);
        expect((await state(page)).selection).toContain('of \\StudyTZeroFourVerdicts{}');
        // The row is highlighted in the table, not anywhere before it.
        const pages = await frame.locator('.pv-hl-mirror').evaluateAll(els => [...new Set(els.map(el => el.closest('.pv-page')?.getAttribute('data-page')))]);
        expect(pages).toEqual(['3']);
    });

    test('a selection in a caption that ends on a comma selects those words in the source, no more', async ({ page }) => {
        const frame = await preview(page);
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const box = async (text: string, edge: 'start' | 'end'): Promise<{ x: number; y: number }> => {
            const span = frame.locator('.textLayer span', { hasText: text }).first();
            const r = await span.evaluate(
                (el, [t, e]) => {
                    const node = el.firstChild;
                    const i = (node?.textContent ?? '').indexOf(t);
                    if (node === null || i < 0) throw new Error('text not in run');
                    const range = document.createRange();
                    range.setStart(node, i);
                    range.setEnd(node, i + t.length);
                    const b = range.getBoundingClientRect();
                    return { x: e === 'start' ? b.left + 0.5 : b.right - 0.5, y: b.top + b.height / 2 };
                },
                [text, edge] as const,
            );
            return { x: r.x + iframe.x, y: r.y + iframe.y };
        };
        // A page's text is laid out when the page comes into view.
        await frame.locator('.pv-page[data-page="4"]').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await frame
            .locator('.textLayer span', { hasText: 'email of T12' })
            .first()
            .evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        const from = await box('email of T12', 'start');
        const to = await box('(bottom),', 'end');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
        await page.mouse.move(to.x, to.y, { steps: 4 });
        await page.mouse.up();
        await expect.poll(async () => (await state(page)).selection).toMatch(/^email of T12 in the confirmatory run[\s\S]*classic Outlook \(bottom\)?,?$/);
    });
});

test.describe('a beamer frame, which SyncTeX knows only by its end', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    /** The viewport box of `text` in the preview, scrolled into view. */
    async function boxOf(page: Page, frame: FrameLocator, text: string): Promise<{ x: number; y: number; width: number; height: number }> {
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const span = frame.locator('.textLayer span', { hasText: text }).first();
        await span.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        const r = await span.evaluate((el, t) => {
            const node = el.firstChild;
            const i = (node?.textContent ?? '').indexOf(t);
            if (node === null || i < 0) throw new Error('text not in run');
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + t.length);
            const b = range.getBoundingClientRect();
            return { x: b.left, y: b.top, width: b.width, height: b.height };
        }, text);
        return { ...r, x: r.x + iframe.x, y: r.y + iframe.y };
    }

    test('text selected on a slide is selected in the frame, not its \\end{frame}', async ({ page }) => {
        await openPaper(page, SLIDES, { format: 'latex', engine: 'pdflatex', root: 'slides.tex' });
        const frame = page.frameLocator('iframe.pv-frame');
        await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 170_000 });
        await frame.locator('.pv-page[data-page="2"]').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));

        // A whole line, by a triple click: it ends on a question mark.
        const audience = await boxOf(page, frame, 'audience');
        await page.mouse.click(audience.x + audience.width / 2, audience.y + audience.height / 2, { clickCount: 3 });
        await expect.poll(async () => (await state(page)).selection).toMatch(/^What should the audience remember tomorrow\??$/);

        // A word, by a double click.
        const remember = await boxOf(page, frame, 'remember');
        await page.mouse.dblclick(remember.x + remember.width / 2, remember.y + remember.height / 2);
        await expect.poll(async () => (await state(page)).selection).toBe('remember');

        // Part of an item, by a drag.
        await frame.locator('.pv-page[data-page="1"]').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
        const from = await boxOf(page, frame, 'talk');
        const to = await boxOf(page, frame, 'rest');
        await page.mouse.move(from.x + 0.5, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width - 0.5, to.y + to.height / 2, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => (await state(page)).selection).toBe('talk carries the rest');

        // And from the source: the caret in the body shows on its slide.
        await page.locator('.monaco-editor .view-lines').getByText('What should the audience').click();
        await expect(frame.locator('.pv-page[data-page="2"] .pv-locator')).toBeAttached();
    });
});
