import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { openComments, openDemo } from '../support.ts';

/** Words picked in the preview reach the source exactly, and comments on words are marked on those words: with the
 *  real TeX engine, on the demo's introduction (sections/intro.tex). */

async function preview(page: Page): Promise<FrameLocator> {
    await openDemo(page);
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.pv-page .textLayer span').first()).toBeVisible({ timeout: 170_000 });
    // The sync to the word reads the document's text once the pages are laid out.
    await page.waitForTimeout(1500);
    return frame;
}

type Box = { x: number; y: number; width: number; height: number };

/** The viewport box of the `nth` occurrence of `text` in the text run (a typeset line) that contains `inRun`. */
async function textBox(page: Page, frame: FrameLocator, inRun: string, text: string, nth = 0): Promise<Box> {
    const iframe = await page.locator('iframe.pv-frame').boundingBox();
    if (iframe === null) throw new Error('no frame');
    const r = await frame
        .locator('.textLayer span', { hasText: inRun })
        .first()
        .evaluate(
            (span, [t, n]) => {
                const node = span.firstChild;
                const data = node?.textContent ?? '';
                let i = -1;
                for (let k = 0; k <= n; k++) i = data.indexOf(t, i + 1);
                if (node === null || i < 0) throw new Error(`"${t}" not in the run`);
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + t.length);
                const b = range.getBoundingClientRect();
                return { x: b.left, y: b.top, width: b.width, height: b.height };
            },
            [text, nth] as const,
        );
    return { ...r, x: r.x + iframe.x, y: r.y + iframe.y };
}

/** The source text the editor's mirror of the preview's selection covers (the characters whose middles lie inside it). */
async function mirroredText(page: Page): Promise<string> {
    await expect(page.locator('.monaco-editor .mirror-range').first()).toBeAttached();
    return page.evaluate(() => {
        const out: string[] = [];
        for (const d of document.querySelectorAll('.monaco-editor .mirror-range')) {
            const r = d.getBoundingClientRect();
            for (const line of document.querySelectorAll('.monaco-editor .view-line')) {
                if (Math.abs(line.getBoundingClientRect().top - r.top) > 3) continue;
                let s = '';
                const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
                    const text = n.textContent ?? '';
                    for (let i = 0; i < text.length; i++) {
                        const c = document.createRange();
                        c.setStart(n, i);
                        c.setEnd(n, i + 1);
                        const b = c.getBoundingClientRect();
                        const mid = b.left + b.width / 2;
                        if (mid > r.left && mid < r.right) s += text[i];
                    }
                }
                out.push(s);
            }
        }
        return out.join('\n').replace(/ /g, ' ');
    });
}

test.describe('words picked in the preview', () => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the TeX engine (E2E_ENGINE=1)');

    // [the run (typeset line) it is in, the word, which occurrence in the run]
    const cases: [string, string, string, number][] = [
        ['a short word', 'where most of them', 'of', 0],
        ['a word with a ligature (fi)', 'Learning to program', 'first', 0],
        ['a word before a full stop', 'where most of them', 'struggle', 0],
        ['the first word of a line', 'where most of them', 'where', 0],
        ['the last word of a line', 'Learning to program', 'are', 0],
    ];
    for (const [what, run, word, nth] of cases) {
        test(`a double click on ${what} selects exactly that word in the source`, async ({ page }) => {
            const frame = await preview(page);
            const b = await textBox(page, frame, run, word, nth);
            await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
            // The preview selects the word without the space after it, and the editor mirrors exactly the word.
            expect(await frame.locator('body').evaluate(() => window.getSelection()?.toString() ?? '')).toBe(word);
            await expect.poll(() => mirroredText(page)).toBe(word);
        });
    }

    test('a double click on a word hyphenated across lines selects the whole word in the source', async ({ page }) => {
        const frame = await preview(page);
        // Long words at the end of the introduction, so that TeX breaks one across lines.
        const long = 'Internationalization characteristically overcompensates uncharacteristically incomprehensibilities';
        await page.locator('.monaco-editor .view-lines').getByText('problem in mind.').click();
        await page.keyboard.press('End');
        await page.keyboard.type(` ${long} ${long}.`);
        const broken = frame
            .locator('.textLayer span')
            .filter({ hasText: /[a-z]-$/ })
            .filter({ hasNotText: 'reflection' })
            .first();
        await expect(broken).toBeAttached({ timeout: 60_000 });
        const text = (await broken.textContent()) ?? '';
        const part = /(\w+)-$/.exec(text)?.[1] ?? '';
        const word = long.split(' ').find(w => w.toLowerCase().startsWith(part.toLowerCase())) ?? '';
        expect(word).not.toBe('');
        const b = await textBox(page, frame, text, `${part}-`);
        await page.mouse.dblclick(b.x + 2, b.y + b.height / 2);
        await expect.poll(() => mirroredText(page)).toBe(word);
    });

    test('a comment on two words is marked on those words, not their line', async ({ page }) => {
        const frame = await preview(page);
        await openComments(page);
        // The panel narrows the preview, which lays its pages out again at the new scale: measure once that is done.
        let words = await textBox(page, frame, 'where most of them', 'most of');
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(500);
            const again = await textBox(page, frame, 'where most of them', 'most of');
            const same = Math.abs(again.x - words.x) < 0.5 && Math.abs(again.width - words.width) < 0.5;
            words = again;
            if (same) break;
        }
        // "most of" from the preview: a drag over the two words, then Comment on the toolbar.
        const line = await frame
            .locator('.textLayer span', { hasText: 'where most of them' })
            .first()
            .evaluate(el => el.getBoundingClientRect().width);
        await page.mouse.move(words.x + 1, words.y + words.height / 2);
        await page.mouse.down();
        await page.mouse.move(words.x + words.width - 1, words.y + words.height / 2, { steps: 8 });
        await page.mouse.up();
        await frame.getByRole('button', { name: 'Comment' }).click();
        await page.locator('.composer .cm-rich').click();
        await page.keyboard.type('Which ones?');
        await page.keyboard.press('Control+Enter');
        await expect(page.locator('.cm-card', { hasText: 'Which ones?' })).toBeVisible();
        // The new mark: the one over these words. It spans them within a few pixels, and is far narrower than the line.
        const iframe = await page.locator('iframe.pv-frame').boundingBox();
        const x = words.x - (iframe?.x ?? 0);
        const y = words.y - (iframe?.y ?? 0);
        const mark = await frame.locator('.pv-hl-comment, .pv-hl-active').evaluateAll(
            (els, [left, top]) =>
                els
                    .map(e => e.getBoundingClientRect())
                    .find(r => Math.abs(r.top + r.height / 2 - top) < 10 && r.left < left + 20 && r.right > left)
                    ?.toJSON() as { left: number; right: number } | undefined,
            [x, y + words.height / 2] as const,
        );
        expect(mark).toBeDefined();
        if (mark === undefined) return;
        expect(Math.abs(mark.left - x)).toBeLessThan(5);
        expect(Math.abs(mark.right - (x + words.width))).toBeLessThan(5);
        expect(mark.right - mark.left).toBeLessThan(line / 4);
    });
});
