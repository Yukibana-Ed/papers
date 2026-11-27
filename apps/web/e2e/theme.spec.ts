import { expect, test } from '@playwright/test';

/** The theme chosen on any Yukibana site is shown by every page from its first paint: the pages rendered on the server
 *  and the ones that render in the browser only (the editor's), whose HTML the server sends as an empty shell. */
for (const path of ['/', '/demo', '/try']) {
    test(`${path} shows the chosen theme before anything paints`, async ({ page, context }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await context.addCookies([{ name: 'yk-theme', value: 'dark', url: new URL(path, test.info().project.use.baseURL).href }]);
        // What the page shows when its HTML has been read, before any of its modules ran.
        await page.addInitScript(() =>
            document.addEventListener(
                'readystatechange',
                () => Reflect.set(window, 'themeAtParse', Reflect.get(window, 'themeAtParse') ?? document.documentElement.dataset['theme'] ?? 'none'),
                { once: true },
            ),
        );
        await page.goto(path);
        expect(await page.evaluate(() => Reflect.get(window, 'themeAtParse') as string)).toBe('dark');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });
}
