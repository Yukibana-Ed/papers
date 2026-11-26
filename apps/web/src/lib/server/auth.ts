import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { importKey, seal, unseal } from './seal.ts';

/** The signed-in user's session: their GitHub App user tokens, sealed in an httpOnly cookie. There is no session
 *  table: the cookie is the session, and signing out deletes it. */
export interface Session {
    readonly login: string;
    readonly name: string;
    readonly access: string;
    /** Epoch ms when `access` expires (GitHub App user tokens last 8 hours). */
    readonly expires: number;
    readonly refresh: string;
}

const COOKIE = 'yk_session';
const STATE_COOKIE = 'yk_oauth_state';
const PURPOSE = 'session/v1';

export interface AuthEnv {
    readonly GITHUB_CLIENT_ID: string;
    readonly GITHUB_CLIENT_SECRET: string;
    readonly SESSION_KEY: string;
}

/** The env's GitHub App and session key, or null where they are not configured (local development without them, a
 *  preview): the app then offers the demo only. */
export function authEnv(event: RequestEvent): AuthEnv | null {
    const env = event.platform?.env;
    if (!env?.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_KEY) return null;
    return { GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET, SESSION_KEY: env.SESSION_KEY };
}

function isSession(x: unknown): x is Session {
    if (typeof x !== 'object' || x === null) return false;
    const r = x as Record<string, unknown>;
    return (
        typeof r['login'] === 'string' && typeof r['name'] === 'string' && typeof r['access'] === 'string' && typeof r['expires'] === 'number' && typeof r['refresh'] === 'string'
    );
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

/** The session of the request, with a fresh access token (refreshed and re-sealed when it is about to expire), or
 *  null when signed out or the refresh token no longer works. */
export async function getSession(event: RequestEvent): Promise<Session | null> {
    const env = authEnv(event);
    const raw = event.cookies.get(COOKIE);
    if (!env || !raw) return null;
    const s = await unseal(await importKey(env.SESSION_KEY), PURPOSE, raw);
    if (!isSession(s)) return null;
    if (s.expires - Date.now() > 5 * 60 * 1000) return s;
    const t = await exchange(env, { grant_type: 'refresh_token', refresh_token: s.refresh });
    if (!t.access_token || !t.refresh_token) {
        event.cookies.delete(COOKIE, { path: '/' });
        return null;
    }
    const next: Session = { ...s, access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in ?? 28800) * 1000 };
    await writeSession(event.cookies, env, next);
    return next;
}

/** Where to send the browser to sign in: GitHub's consent page, with a state that the callback checks. */
export function loginUrl(event: RequestEvent, env: AuthEnv, returnTo: string): string {
    const state = crypto.randomUUID();
    event.cookies.set(STATE_COOKIE, JSON.stringify({ state, returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/' }), {
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

/** Finishes a sign-in: checks the state, exchanges the code, and seals the session. Returns where to go next, or
 *  null when the callback is not one this browser started. */
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
    await writeSession(event.cookies, env, {
        login: who.login,
        name: who.name,
        access: t.access_token,
        refresh: t.refresh_token,
        expires: Date.now() + (t.expires_in ?? 28800) * 1000,
    });
    return typeof expected.returnTo === 'string' ? expected.returnTo : '/';
}

export function logout(cookies: Cookies): void {
    cookies.delete(COOKIE, { path: '/' });
}
