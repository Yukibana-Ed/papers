import { expect, test } from '@playwright/test';
import { openTypstPaper } from '../typst-paper.ts';

test.skip(!process.env['E2E_ENGINE'], 'needs the Typst compiler');

/** Ctrl+P prints the built document, not the app: the preview frame lays out one image per page on sheets of the
 *  document's size and opens the print dialog itself, whether the key was pressed in the editor or in the preview. */
test('Ctrl+P prints the PDF from the preview, from the editor and from the preview itself', async ({ page }) => {
    test.setTimeout(240_000);
    await openTypstPaper(page, { 'main.typ': '= One\n\nFirst page.\n#pagebreak()\n= Two\n\nSecond page.\n' });
    const inFrame = page.frameLocator('iframe.pv-frame');
    await expect(inFrame.locator('.textLayer span', { hasText: 'First' }).first()).toBeAttached({ timeout: 150_000 });
    const frame = page.frames().find(f => f.url().endsWith('/frame'));
    if (frame === undefined) throw new Error('no preview frame');
    interface Printed {
        sheets: number;
        widths: number[];
        page: string;
    }
    const printed = (): Promise<Printed[]> => frame.evaluate(() => (Reflect.get(window, 'printed') as Printed[] | undefined) ?? []);
    await frame.evaluate(() => {
        const calls: Printed[] = [];
        Reflect.set(window, 'printed', calls);
        window.print = () => {
            const imgs = [...document.querySelectorAll<HTMLImageElement>('.pv-print img')];
            calls.push({
                sheets: imgs.length,
                widths: imgs.map(i => i.naturalWidth),
                page: [...document.head.querySelectorAll('style')].map(s => s.textContent).find(t => t.includes('@page')) ?? '',
            });
            window.dispatchEvent(new Event('afterprint'));
        };
    });
    await page.evaluate(() => {
        window.print = () => Reflect.set(window, 'printedApp', true);
    });

    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+p');
    await expect.poll(printed, { timeout: 30_000 }).toHaveLength(1);
    const first = (await printed())[0];
    expect(first?.sheets).toBe(2);
    // A4 at 300 dpi.
    expect(first?.widths).toEqual([2480, 2480]);
    expect(first?.page).toMatch(/size: 595\.\d+pt 841\.\d+pt/);
    // The sheets are gone once the dialog closes.
    await expect(inFrame.locator('.pv-print')).toHaveCount(0);

    await inFrame.locator('.pv-page').first().click();
    await page.keyboard.press('Control+p');
    await expect.poll(printed, { timeout: 30_000 }).toHaveLength(2);

    // And from the command palette.
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Print');
    await page.keyboard.press('Enter');
    await expect.poll(printed, { timeout: 30_000 }).toHaveLength(3);
    expect(await page.evaluate(() => Reflect.has(window, 'printedApp'))).toBe(false);
});

/** The toolbar's Download saves the built PDF itself, named after the document; the frame hands it to the browser. */
test('Download saves the built PDF under the document’s name, and Print stays in the palette', async ({ page }) => {
    test.setTimeout(240_000);
    await openTypstPaper(page, { 'main.typ': '= One\n\nFirst page.\n' });
    const inFrame = page.frameLocator('iframe.pv-frame');
    await expect(inFrame.locator('.textLayer span', { hasText: 'First' }).first()).toBeAttached({ timeout: 150_000 });
    await expect(page.getByRole('button', { name: 'Print' })).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(download.suggestedFilename()).toBe('main.pdf');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Print');
    await expect(page.locator('.palette-list .row-btn').first()).toHaveText(/Print.*Ctrl\+P/);
});
