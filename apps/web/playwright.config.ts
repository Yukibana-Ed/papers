import { defineConfig, devices } from '@playwright/test';
import { E2E_CLIENT_SECRET, E2E_GITHUB, E2E_SESSION_KEY } from './e2e/test-env.ts';

/** Browser tests against the BUILT app: both Workers run under `wrangler dev` (workerd, as in production), each told
 *  the other's local origin, so the page's CSP, cross-origin isolation and the frame handshake are the real ones.
 *  Run `pnpm build` first (CI does); `pnpm -F @yukibana/papers-web e2e` then starts the Workers itself.
 *
 *  Specs live in e2e/ (one folder per area, e.g. e2e/editor/); shared helpers in e2e/support.ts.
 *
 *  With E2E_BASE_URL (a dev server, or the deployed app), the tests run against that instead, and no Workers start:
 *  `E2E_ENGINE=1 E2E_BASE_URL=https://papers.yukibana.dev pnpm -F @yukibana/papers-web e2e preview` checks the
 *  preview with the real TeX engine. */
const APP = 'http://127.0.0.1:4173';
const CONTENT = 'http://127.0.0.1:4174';
const BASE = process.env['E2E_BASE_URL'];

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: Boolean(process.env['CI']),
    retries: process.env['CI'] ? 1 : 0,
    reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
    // A build with the real engine takes seconds alone, and much longer when every worker builds at once.
    timeout: process.env['E2E_ENGINE'] ? 180_000 : 60_000,
    // The engine's first build fetches it and TeX Live; done once, before the tests (e2e/warm-engine.ts).
    ...(process.env['E2E_ENGINE'] ? { globalSetup: './e2e/warm-engine.ts' } : {}),
    use: { baseURL: BASE ?? APP, trace: 'off', screenshot: 'only-on-failure' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
    webServer:
        BASE !== undefined
            ? []
            : [
                  {
                      // The stand-in GitHub that the app Worker and the signed-in pages of e2e/project.spec.ts ask.
                      command: `node e2e/fake-github.ts ${new URL(E2E_GITHUB).port}`,
                      url: `${E2E_GITHUB}/`,
                      reuseExistingServer: !process.env['CI'],
                  },
                  {
                      // The app with the rooms' Worker beside it (its Durable Objects), in one workerd. Test values for
                      // sign-in (e2e/test-env.ts): the app runs signed in when a test seals a session cookie. The Worker
                      // sees its real local origin, as the page does, not the deployed route's.
                      command: `pnpm exec wrangler dev -c wrangler.jsonc -c ../room/wrangler.jsonc --port 4173 --ip 127.0.0.1 --local --infer-origin-from-routes=false --var CONTENT_ORIGIN:${CONTENT} --var GITHUB_CLIENT_SECRET:${E2E_CLIENT_SECRET} --var SESSION_KEY:${E2E_SESSION_KEY} --var GITHUB_API:${E2E_GITHUB}`,
                      url: `${APP}/`,
                      reuseExistingServer: !process.env['CI'],
                      timeout: 120_000,
                  },
                  {
                      // With E2E_ENGINE, the engine and TeX Live come from the deployed content origin; the Typst compiler
                      // is this checkout's build, put into the local bucket first (scripts/typst.ts seed).
                      command: `${process.env['E2E_ENGINE'] ? 'node scripts/typst.ts seed && ' : ''}pnpm exec wrangler dev --port 4174 --ip 127.0.0.1 --local --var APP_ORIGIN:${APP}${process.env['E2E_ENGINE'] ? ' --var ASSETS_FALLBACK:https://user-content-papers.yukibana.run' : ''}`,
                      cwd: '../content',
                      url: `${CONTENT}/`,
                      reuseExistingServer: !process.env['CI'],
                      timeout: 120_000,
                  },
              ],
});

export { APP, CONTENT };
