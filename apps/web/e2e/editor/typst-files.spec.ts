import { expect, test } from '@playwright/test';
import { caretAt, languageServer, openDemo } from './helpers.ts';

/** The Typst language server reads the project's other files (a bibliography, an included file) through the editor:
 *  they must reach it in the encoding it expects, or it reports them unreadable ("base64 decode error"). */
test('the Typst language server reads the bibliography and included files without errors', async ({ page }) => {
    test.skip(!process.env['E2E_ENGINE'], 'needs the language server (E2E_ENGINE=1)');
    test.setTimeout(170_000);
    await openDemo(page);
    // brief/brief.typ has #include "findings.typ" and #bibliography("../refs.bib").
    await caretAt(page, 'brief/brief.typ', 1, 1);
    await expect.poll(() => languageServer(page), { timeout: 150_000 }).toMatchObject({ status: 'ready' });
    // Give it time to check the file and read what it needs.
    await page.waitForTimeout(4000);
    const problems = await page.evaluate(() => {
        const s = (Reflect.get(window, '__papersTest') as { session: { languageProblems: Record<string, Record<string, { message: string }[]>> } }).session;
        return Object.values(s.languageProblems['tinymist'] ?? {})
            .flat()
            .map(p => p.message);
    });
    expect(problems.filter(m => /failed to load|base64|not in the project/i.test(m))).toEqual([]);
});
