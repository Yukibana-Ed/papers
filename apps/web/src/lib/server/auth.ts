import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { importKey, seal, unseal } from './seal.ts';
import { workerPlatform } from './platform.ts';

/** The signed-in browser: who it is, and the GitHub App refresh token, sealed in an httpOnly cookie. The Worker only
 *  exchanges codes and refresh tokens (it holds the client secret); the access token it gets back goes to the page,
 *  which keeps it in memory and calls GitHub itself. Nothing is stored on our side: signing out deletes the cookie. */
export interface Session {
    readonly login: string;
    readonly name: string;
    readonly refresh: string;
}

/** What the page gets from `/auth/token`. */
export interface AccessToken {
    readonly token: string;
    /** Epoch ms when it expires (GitHub App user tokens last 8 hours). */
    readonly expires: number;
    readonly login: string;
    readonly name: string;
}

const COOKIE = 'yk_session';
const STATE_COOKIE = 'yk_oauth_state';
const PURPOSE = 'session/v2';

export interface AuthEnv {
    readonly GITHUB_CLIENT_ID: string;
    readonly GITHUB_CLIENT_SECRET: string;
    readonly SESSION_KEY: string;
}

/** The env's GitHub App and session key, or null where they are not configured (local development without them, a
 *  preview): the app then offers the demo only. */
export function authEnv(_event?: RequestEvent): AuthEnv | null {
    const env = workerPlatform().env;
    if (!env?.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_KEY) return null;
    return { GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET, SESSION_KEY: env.SESSION_KEY };
}

/** The GitHub API the Worker asks: api.github.com (undefined, the callers' default), unless `GITHUB_API` names a
 *  stand-in on this machine's loopback address, as the browser tests' Workers have it. A deployed Worker cannot reach
 *  a loopback address, and no other value is taken, so a token can go nowhere but GitHub. */
export function githubApi(): string | undefined {
    const api = workerPlatform().env?.GITHUB_API;
    return api !== undefined && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(api) ? api : undefined;
}

function isSession(x: unknown): x is Session {
    if (typeof x !== 'object' || x === null) return false;
    const r = x as Record<string, unknown>;
    return typeof r['login'] === 'string' && typeof r['name'] === 'string' && typeof r['refresh'] === 'string';
}

async function writeSession(cookies: Cookies, env: AuthEnv, s: Session): Promise<void> {
    cookies.set(COOKIE, await seal(await importKey(env.SESSION_KEY), PURPOSE, s), { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 180 });
}

interface TokenResponse {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
}

async function exchange(env: AuthEnv, params: Record<string, string>): Promise<TokenResponse> {
    const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'yukibana-papers' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
    });
    return (await r.json()) as TokenResponse;
}

/** Who is signed in, from the cookie alone (no call to GitHub), or null. */
export async function getSession(event: RequestEvent): Promise<Session | null> {
    const env = authEnv(event);
    const raw = event.cookies.get(COOKIE);
    if (!env || !raw) return null;
    const s = await unseal(await importKey(env.SESSION_KEY), PURPOSE, raw);
    return isSession(s) ? s : null;
}

/** A fresh access token for the page: the refresh token is exchanged (GitHub rotates it, so the cookie is rewritten),
 *  or null when signed out or the refresh token no longer works (then the cookie goes). Pages serialize their calls
 *  with a Web Lock, since a refresh token works once. */
export async function freshToken(event: RequestEvent): Promise<AccessToken | null> {
    const env = authEnv(event);
    const s = await getSession(event);
    if (!env || !s) return null;
    const t = await exchange(env, { grant_type: 'refresh_token', refresh_token: s.refresh });
    if (!t.access_token || !t.refresh_token) {
        event.cookies.delete(COOKIE, { path: '/' });
        return null;
    }
    await writeSession(event.cookies, env, { ...s, refresh: t.refresh_token });
    return { token: t.access_token, expires: Date.now() + (t.expires_in ?? 28800) * 1000, login: s.login, name: s.name };
}

/** `returnTo` as a path on `origin` to send the browser to after signing in, or `/` when it is anything else.
 *  Parsed as a URL against `origin` and kept only if it stays on `origin`, so `//evil.com`, `/\evil.com` and their
 *  tab- or percent-encoded variants (which browsers read as other hosts) all become `/`. Backslashes and control
 *  characters are refused outright. Promises: the result starts with exactly one `/` and has no scheme or host. */
export function sameOriginPath(returnTo: string, origin: string): string {
    // eslint-disable-next-line no-control-regex
    if (!returnTo.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(returnTo) || /%5c/i.test(returnTo)) return '/';
    let u: URL;
    try {
        u = new URL(returnTo, origin);
    } catch {
        return '/';
    }
    if (u.origin !== origin || !u.pathname.startsWith('/') || u.pathname.startsWith('//')) return '/';
    return `${u.pathname}${u.search}${u.hash}`;
}

/** Where to send the browser to sign in: GitHub's consent page, with a state that the callback checks. */
export function loginUrl(event: RequestEvent, env: AuthEnv, returnTo: string): string {
    const state = crypto.randomUUID();
    event.cookies.set(STATE_COOKIE, JSON.stringify({ state, returnTo: sameOriginPath(returnTo, event.url.origin) }), {
        path: '/auth',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600,
    });
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', `${event.url.origin}/auth/callback`);
    u.searchParams.set('state', state);
    return u.href;
}

/** Finishes a sign-in: checks the state, exchanges the code, and seals who it is with the refresh token. The access
 *  token of this exchange is used once, to ask GitHub who signed in, and dropped. Returns where to go next, or null
 *  when the callback is not one this browser started. */
export async function finishLogin(event: RequestEvent, env: AuthEnv, viewer: (token: string) => Promise<{ login: string; name: string }>): Promise<string | null> {
    const saved = event.cookies.get(STATE_COOKIE);
    event.cookies.delete(STATE_COOKIE, { path: '/auth' });
    const code = event.url.searchParams.get('code');
    const state = event.url.searchParams.get('state');
    if (!saved || !code || !state) return null;
    let expected: { state?: unknown; returnTo?: unknown };
    try {
        expected = JSON.parse(saved) as { state?: unknown; returnTo?: unknown };
    } catch {
        return null;
    }
    if (expected.state !== state) return null;
    const t = await exchange(env, { code, redirect_uri: `${event.url.origin}/auth/callback` });
    if (!t.access_token || !t.refresh_token) return null;
    const who = await viewer(t.access_token);
    await writeSession(event.cookies, env, { login: who.login, name: who.name, refresh: t.refresh_token });
    // Checked again: the cookie is ours, but the check costs nothing and keeps the redirect safe on its own.
    return typeof expected.returnTo === 'string' ? sameOriginPath(expected.returnTo, event.url.origin) : '/';
}

export function logout(cookies: Cookies): void {
    cookies.delete(COOKIE, { path: '/' });
}
