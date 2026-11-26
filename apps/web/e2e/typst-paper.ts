import { expect, type Page } from '@playwright/test';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const COMMIT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

/** Opens a Typst paper made of `files` (root `main.typ`) as a guest: the template gallery is mocked with one Typst
 *  template holding them, and the paper is opened from it. Resolves once the workbench is open; the build follows. */
export async function openTypstPaper(page: Page, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
    await page.route('https://api.github.com/repos/Yukibana-Ed/papers-templates/commits/main', route => route.fulfill({ body: COMMIT }));
    await page.route(`https://raw.githubusercontent.com/Yukibana-Ed/papers-templates/${COMMIT}/**`, route => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname.split(`/${COMMIT}/`)[1] ?? '');
        if (path === 'index.json')
            return route.fulfill({
                json: {
                    version: 1,
                    templates: [
                        {
                            id: 'typst-paper',
                            name: 'Typst paper',
                            description: 'A paper for a test.',
                            category: 'paper',
                            format: 'typst',
                            engine: 'typst',
                            root: 'main.typ',
                            licence: '0BSD',
                            thumbnail: 'thumbnail.png',
                            fields: {},
                            seeAlso: [],
                            files: Object.keys(files),
                        },
                    ],
                },
            });
        if (path.endsWith('thumbnail.png')) return route.fulfill({ body: Buffer.from(PNG) });
        const file = files[path.replace(/^typst-paper\//, '')];
        if (file === undefined) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: typeof file === 'string' ? file : Buffer.from(file) });
    });
    await page.goto('/new');
    await page
        .getByRole('button', { name: /Typst paper/ })
        .first()
        .click();
    await page.getByRole('button', { name: 'Open here' }).click();
    await page.getByRole('textbox', { name: /title/i }).fill('Paper');
    await page.locator('button:text-is("Open")').click();
    await expect(page).toHaveURL(/\/try/);
}
