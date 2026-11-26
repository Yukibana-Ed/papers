import { gh, requireSession } from '#lib/server/api.ts';
import { blob } from '#lib/server/github.ts';
import type { RequestHandler } from './$types';

/** A blob's bytes. Blobs never change, so the browser may keep them; private to this user. */
export const GET: RequestHandler = async event => {
    const s = await requireSession(event);
    const r = await gh(() => blob(s.access, event.params.owner, event.params.repo, event.params.sha));
    return new Response(r.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' } });
};
