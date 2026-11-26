import { defineConfig, devices } from '@playwright/test';

/** Browser tests against the BUILT app: both Workers run under `wrangler dev` (workerd, as in production), each told
 *  the other's local origin, so the page's CSP, cross-origin isolation and the frame handshake are the real ones.
 *  Run `pnpm build` first (CI does); `pnpm -F @yukibana/papers-web e2e` then starts the Workers itself.
 *
 *  Specs live in e2e/ (one folder per area, e.g. e2e/editor/); shared helpers in e2e/support.ts. */
const APP = 'http://127.0.0.1:4173';
const CONTENT = 'http://127.0.0.1:4174';

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: Boolean(process.env['CI']),
    retries: process.env['CI'] ? 1 : 0,
    reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
    timeout: 60_000,
    use: { baseURL: APP, trace: 'off', screenshot: 'only-on-failure' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
    webServer: [
        {
            command: `pnpm exec wrangler dev --port 4173 --ip 127.0.0.1 --local --var CONTENT_ORIGIN:${CONTENT}`,
            url: `${APP}/`,
            reuseExistingServer: !process.env['CI'],
            timeout: 120_000,
        },
        {
            command: `pnpm exec wrangler dev --port 4174 --ip 127.0.0.1 --local --var APP_ORIGIN:${APP}`,
            cwd: '../content',
            url: `${CONTENT}/`,
            reuseExistingServer: !process.env['CI'],
            timeout: 120_000,
        },
    ],
});

export { APP, CONTENT };
