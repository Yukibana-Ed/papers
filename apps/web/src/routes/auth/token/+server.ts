import { error, json } from '@sveltejs/kit';
import { freshToken } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

/** A fresh GitHub access token for the app's own pages, from the sealed refresh token. POST and same-origin only:
 *  another site cannot have it minted (its Origin differs; the cookie is not sent cross-site anyway). */
export const POST: RequestHandler = async event => {
    if (event.request.headers.get('Origin') !== event.url.origin) error(403, 'Cross-origin request');
    const t = await freshToken(event);
    if (!t) error(401, 'Sign in');
    return json(t, { headers: { 'Cache-Control': 'no-store' } });
};
