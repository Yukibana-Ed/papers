import type { Page } from '@playwright/test';
import { importKey, seal } from '../src/lib/server/seal.ts';
import { E2E_SESSION_KEY } from './test-env.ts';
import { APP } from '../playwright.config.ts';

/** A GitHub API answer the mock gives: a status and a JSON body. */
export interface Answer {
    readonly status?: number;
    readonly body: unknown;
}

/** Signs the browser in as `login` (a session cookie sealed with the tests' key), hands the page a stand-in GitHub
 *  token, and answers GitHub API calls from `api` (path and query after api.github.com → answer); anything else gets a
 *  404, as GitHub gives for what a user cannot see. */
export async function signedIn(page: Page, login: string, api: Record<string, Answer>): Promise<string[]> {
    const cookie = await seal(await importKey(E2E_SESSION_KEY), 'session/v2', { login, name: login, refresh: 'e2e' });
    await page.context().addCookies([{ name: 'yk_session', value: cookie, url: APP, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    await page.route('**/auth/token', route => route.fulfill({ json: { token: 'e2e-token', expires: Date.now() + 8 * 3600_000, login, name: login } }));
    const asked: string[] = [];
    await page.route('https://api.github.com/**', route => {
        const u = new URL(route.request().url());
        const key = u.pathname + u.search;
        asked.push(`${route.request().method()} ${key}`);
        const a = api[key] ?? api[u.pathname];
        return route.fulfill({ status: a?.status ?? (a ? 200 : 404), json: a?.body ?? { message: 'Not Found' } });
    });
    return asked;
}
