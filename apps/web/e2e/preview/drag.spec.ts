import { expect, test } from '@playwright/test';
import { openPaper } from '../typst-paper.ts';

/** Dragging a selection in the preview over places with no text under the pointer: the gaps where a line changes
 *  font, the space between lines, above a page's first line. The selection's end stays in the text beside the
 *  pointer; it does not run to the end of the page. With the real TeX engine. */

const PAPER = {
    'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        'Mail filters read the visible text of a message before they decide what it is.',
        'A sender can \\emph{hide a payload} from them in more ways than one would first think.',
        'We measure \\textbf{nineteen techniques} against five extractors and one real renderer.',
        'The extractors disagree with one another more often than \\emph{their authors} expect.',
        'Hidden text that a filter keeps can still tip the verdict of a later classifier.',
        '',
        'Visible text that a filter drops is the more dangerous of the two mistakes.',
        'Our corpus has sixty eight client setups, each with a screenshot and a verdict.',
        '\\end{document}',
    ].join('\n'),
};

test.describe('dragging a selection in the preview', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    test('keeps its end beside the pointer over gaps between runs, between lines and above the first line', async ({ page }) => {
        await openPaper(page, PAPER, { format: 'latex', engine: 'pdflatex', root: 'main.tex' });
        const frame = page.frameLocator('iframe.pv-frame');
        await expect(frame.locator('.pv-pages[data-sync]')).toBeAttached({ timeout: 170_000 });
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        if (iframe === null) throw new Error('no frame');
        const runs = await frame.locator('body').evaluate(body =>
            [...body.querySelectorAll('.textLayer span[data-run]')].map(el => {
                const r = el.getBoundingClientRect();
                return { text: el.textContent, x: r.left, y: Math.round(r.top), width: r.width, height: r.height };
            }),
        );
        const whole = runs.reduce((n, r) => n + r.text.length, 0);
        expect(whole).toBeGreaterThan(500);
        // The selection's length a moment after every move of the pointer, once the page has made of the move what
        // it will (the highlight is drawn from the same state, a frame later).
        await frame.locator('body').evaluate(() => {
            const seen: number[] = [];
            Reflect.set(window, 'seenByTest', seen);
            window.addEventListener('pointermove', () => setTimeout(() => seen.push(window.getSelection()?.toString().length ?? 0), 0));
        });
        // The first lines: the first of the page, and two with words in another font.
        const tops = [...new Set(runs.map(r => r.y))].slice(0, 3);
        expect(runs.filter(r => r.y === tops[1]).length).toBeGreaterThan(2);
        for (const top of tops) {
            const on = runs.filter(r => r.y === top);
            const from = Math.min(...on.map(r => r.x)) + 20;
            const to = Math.max(...on.map(r => r.x + r.width)) + 20;
            const height = on[0]?.height ?? 10;
            await page.mouse.move(iframe.x + from, iframe.y + top + height / 2);
            await page.mouse.down();
            // Across and back at several heights: above the line, on it, and below it down to the next line.
            let forth = true;
            for (const dy of [-4, 1, height / 2, height + 1, height + 3]) {
                for (let x = from; x <= to; x += 2) await page.mouse.move(iframe.x + (forth ? x : to - (x - from)), iframe.y + top + dy);
                forth = !forth;
            }
            await page.mouse.up();
            await frame.locator('body').evaluate(() => window.getSelection()?.removeAllRanges());
        }
        await page.waitForTimeout(200);
        const seen = await frame.locator('body').evaluate(() => Reflect.get(window, 'seenByTest') as number[]);
        expect(seen.length).toBeGreaterThan(2000);
        // Within a line of where it began, the selection is two lines of text and a little at most: not half the page.
        expect(Math.max(...seen)).toBeLessThan(whole / 2);
        // And it did select: most of a line at the far end of each sweep.
        expect(seen.filter(n => n > 60).length).toBeGreaterThan(300);
    });
});
