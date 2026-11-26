import type { Page } from '@playwright/test';
import { importKey, seal } from '../src/lib/server/seal.ts';
import { E2E_GITHUB, E2E_SESSION_KEY } from './test-env.ts';
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

/** Makes (or replaces) repository `name` (`owner/repo`) on the stand-in GitHub, with `files` (path → text) in one
 *  commit on `main`; `readers` may read it but not push. */
export async function makeRepo(name: string, files: Record<string, string>, readers: readonly string[] = []): Promise<void> {
    const r = await fetch(`${E2E_GITHUB}/__repos/${name}`, { method: 'PUT', body: JSON.stringify({ files, readers }) });
    if (!r.ok) throw new Error(`fake GitHub answered ${r.status}`);
}

/** Repository `name` on the stand-in GitHub now: its commits, newest first, and its files. */
export async function repoState(name: string): Promise<{ commits: { oid: string; message: string; author: string }[]; files: Record<string, string> }> {
    const r = await fetch(`${E2E_GITHUB}/__repos/${name}`);
    if (!r.ok) throw new Error(`fake GitHub answered ${r.status}`);
    return (await r.json()) as { commits: { oid: string; message: string; author: string }[]; files: Record<string, string> };
}

/** Signs the browser in as `login`, as `signedIn` does, with every GitHub API call of the page answered by the
 *  stand-in GitHub: the same one the app's Worker asks, so both see the same repositories. */
export async function signedInToFake(page: Page, login: string): Promise<void> {
    const cookie = await seal(await importKey(E2E_SESSION_KEY), 'session/v2', { login, name: login, refresh: 'e2e' });
    await page.context().addCookies([{ name: 'yk_session', value: cookie, url: APP, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    await page.route('**/auth/token', route => route.fulfill({ json: { token: `e2e:${login}`, expires: Date.now() + 8 * 3600_000, login, name: login } }));
    await page.route('https://api.github.com/**', async route => {
        const request = route.request();
        const u = new URL(request.url());
        const body = request.postData();
        const r = await fetch(`${E2E_GITHUB}${u.pathname}${u.search}`, {
            method: request.method(),
            headers: { Authorization: (await request.headerValue('authorization')) ?? '' },
            ...(body === null ? {} : { body }),
        });
        await route.fulfill({ status: r.status, contentType: r.headers.get('Content-Type') ?? 'application/json', body: Buffer.from(await r.arrayBuffer()) });
    });
}
