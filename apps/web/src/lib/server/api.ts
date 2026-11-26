import { error, type RequestEvent } from '@sveltejs/kit';
import { getSession, type Session } from './auth.ts';
import { GitHubError, type FileChange } from './github.ts';

/** The signed-in session for an /api request, or a 401. A request that changes something must come from the app's
 *  own pages: its Origin must be the app's. */
export async function requireSession(event: RequestEvent): Promise<Session> {
    if (event.request.method !== 'GET' && event.request.headers.get('Origin') !== event.url.origin) error(403, 'Cross-origin request');
    const s = await getSession(event);
    if (!s) error(401, 'Sign in');
    return s;
}

/** Runs a GitHub call, turning GitHub's refusals into the same kind of HTTP status for the page. */
export async function gh<T>(f: () => Promise<T>): Promise<T> {
    try {
        return await f();
    } catch (e) {
        if (e instanceof GitHubError) error(e.status === 401 ? 401 : e.status === 409 ? 409 : e.status === 404 ? 404 : e.status === 400 ? 400 : 502, e.message);
        throw e;
    }
}

/** `x` as a list of file changes, or null if it is not one. */
export function parseChanges(x: unknown): FileChange[] | null {
    if (!Array.isArray(x)) return null;
    const out: FileChange[] = [];
    for (const c of x as unknown[]) {
        if (typeof c !== 'object' || c === null) return null;
        const path: unknown = Reflect.get(c, 'path');
        const text: unknown = Reflect.get(c, 'text');
        if (typeof path !== 'string' || (typeof text !== 'string' && text !== null)) return null;
        out.push({ path, text });
    }
    return out;
}

/** The JSON body of a request as a record, or a 400. */
export async function body(event: RequestEvent): Promise<Record<string, unknown>> {
    const b: unknown = await event.request.json().catch(() => null);
    if (typeof b !== 'object' || b === null) error(400, 'Expected JSON');
    return b as Record<string, unknown>;
}
