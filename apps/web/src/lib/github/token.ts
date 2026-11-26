/** The page's GitHub access token: asked from the app's Worker (which exchanges the sealed refresh token) and kept in
 *  this module's memory only — never in storage, never sent to the content frame. A reload asks again.
 *
 *  A refresh token works once, and GitHub hands out a new one each time, so two tabs refreshing at once would sign one
 *  out: a Web Lock serializes the requests of every tab of the app. */

export interface Viewer {
    readonly login: string;
    readonly name: string;
}

/** Thrown when the user has no GitHub sign-in (or it expired past refreshing): the page sends them to sign in. */
export class SignInNeeded extends Error {
    constructor() {
        super('Sign in');
    }
}

let current: { token: string; expires: number; viewer: Viewer } | null = null;
let pending: Promise<{ token: string; expires: number; viewer: Viewer }> | null = null;

/** Renew this long before the token expires. */
const MARGIN_MS = 10 * 60 * 1000;

async function request(): Promise<{ token: string; expires: number; viewer: Viewer }> {
    const run = async (): Promise<{ token: string; expires: number; viewer: Viewer }> => {
        const r = await fetch('/auth/token', { method: 'POST', credentials: 'same-origin' });
        if (r.status === 401) throw new SignInNeeded();
        if (!r.ok) throw new Error(`Sign-in service answered ${r.status}`);
        const t = (await r.json()) as { token: string; expires: number; login: string; name: string };
        return { token: t.token, expires: t.expires, viewer: { login: t.login, name: t.name } };
    };
    return 'locks' in navigator ? navigator.locks.request('yukibana-papers/github-token', run) : run();
}

/** A GitHub access token valid for at least a few more minutes. Throws `SignInNeeded` when the browser is signed out. */
export async function githubToken(): Promise<string> {
    return (await session()).token;
}

/** Who is signed in, with the token. */
export async function session(): Promise<{ token: string; viewer: Viewer }> {
    if (current && current.expires - Date.now() > MARGIN_MS) return current;
    pending ??= request().finally(() => {
        pending = null;
    });
    current = await pending;
    return current;
}

/** Forgets the token, for a 401 from GitHub (revoked, or the app was uninstalled): the next call asks again. */
export function dropToken(): void {
    current = null;
}
