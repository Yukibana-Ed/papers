import { expect, test } from '@playwright/test';
import { openTypstPaper } from '../typst-paper.ts';

/** A Typst paper's other files (a bibliography, data, an image, an included file) reach the Typst language server in
 *  the encoding it expects and the compiler as they are: opened from a gallery template (the gallery is mocked with a
 *  small Typst template that reads one of each), the paper builds and the server reports nothing. Before, the server
 *  got the bibliography as raw text and said "failed to load file (base64 decode error: Invalid symbol 64)". */

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

const FILES: Record<string, string | Uint8Array> = {
    'main.typ': [
        '#set document(title: "Files")',
        '= Files',
        'As shown before @knuth84, the data has #csv("data.csv").len() rows.',
        '#include "part.typ"',
        '#image("dot.png", width: 1cm)',
        '#bibliography("references.bib")',
        '',
    ].join('\n'),
    'part.typ': 'An included part.\n',
    'data.csv': 'a,b\n1,2\n3,4\n',
    'references.bib': '@article{knuth84,\n  author = {Donald E. Knuth},\n  title = {Literate Programming},\n  journal = {The Computer Journal},\n  year = {1984}\n}\n',
    'dot.png': PNG,
};

test('a Typst paper reads its bibliography, data, image and included file: it builds and the language server reports nothing', async ({ page }) => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the Typst compiler and language server (E2E_ENGINE=1)');
    test.setTimeout(170_000);
    await openTypstPaper(page, FILES);
    // It builds: a page with the cited text.
    const frame = page.frameLocator('iframe.pv-frame');
    await expect(frame.locator('.textLayer span', { hasText: 'rows' }).first()).toBeAttached({ timeout: 150_000 });
    const session = async (): Promise<{ status: string; problems: string[]; build: string[] }> =>
        page.evaluate(() => {
            const s = (
                Reflect.get(window, '__papersTest') as {
                    session: {
                        languageServer: { status: string } | null;
                        languageProblems: Record<string, Record<string, { message: string }[]>>;
                        buildErrors: { message: string }[];
                    };
                }
            ).session;
            return {
                status: s.languageServer?.status ?? '',
                problems: Object.values(s.languageProblems['tinymist'] ?? {})
                    .flat()
                    .map(p => p.message),
                build: s.buildErrors.map(e => e.message),
            };
        });
    await expect.poll(async () => (await session()).status, { timeout: 120_000 }).toBe('ready');
    // The server checks the paper, asks for the files it reads, and checks it again once they are there.
    await page.waitForTimeout(6000);
    const s = await session();
    expect(s.build).toEqual([]);
    expect(s.problems).toEqual([]);
});
