import { chromium, type FullConfig } from '@playwright/test';

/** With E2E_ENGINE: builds the demo once before the tests, so the engine and the TeX Live files it needs are in the
 *  content Worker's cache (they come from the deployed origin, see ASSETS_FALLBACK) before tests that each allow a
 *  minute for a build start in parallel. */
export default async function warmEngine(config: FullConfig): Promise<void> {
    const base = config.projects[0]?.use.baseURL;
    if (base === undefined) return;
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(`${base}/demo`);
        await page.frameLocator('iframe.pv-frame').locator('.textLayer span').first().waitFor({ timeout: 300_000 });
    } finally {
        await browser.close();
    }
}
