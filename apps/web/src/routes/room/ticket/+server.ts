import { error, json } from '@sveltejs/kit';
import { GitHubError, branchHead, repoInfo, viewer } from '#lib/github/api.ts';
import { authEnv } from '#lib/server/auth.ts';
import { TICKET_TTL_MS, mintTicket, roomName } from '#lib/server/room-ticket.ts';
import type { RequestHandler } from './$types';

/** A ticket to join a branch's room. The page presents its GitHub access token once; the Worker asks GitHub who it
 *  is and what it may do in the repository, and keeps nothing. */
export const POST: RequestHandler = async event => {
    if (event.request.headers.get('Origin') !== event.url.origin) error(403, 'Cross-origin request');
    const env = authEnv(event);
    if (!env) error(503, 'Rooms are not configured here');
    const token = /^Bearer (\S+)$/.exec(event.request.headers.get('Authorization') ?? '')?.[1];
    if (!token) error(401, 'Sign in');
    const body: unknown = await event.request.json().catch(() => null);
    const owner: unknown = body && typeof body === 'object' ? Reflect.get(body, 'owner') : null;
    const repo: unknown = body && typeof body === 'object' ? Reflect.get(body, 'repo') : null;
    const branch: unknown = body && typeof body === 'object' ? Reflect.get(body, 'branch') : null;
    if (typeof owner !== 'string' || typeof repo !== 'string' || typeof branch !== 'string' || !branch) error(400, 'Which room?');
    try {
        // The branch must exist: rooms are only for real branches, not for any name someone with read access makes up.
        const [who, info] = await Promise.all([viewer(token), repoInfo(token, owner, repo), branchHead(token, owner, repo, branch)]);
        const ticket = await mintTicket(env.SESSION_KEY, {
            login: who.login,
            name: who.name,
            access: info.access,
            room: roomName(owner, repo, branch),
            expires: Date.now() + TICKET_TTL_MS,
        });
        return json({ ticket }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
        if (e instanceof GitHubError) error(e.status === 401 ? 401 : e.status === 404 ? 404 : 403, 'No access');
        throw e;
    }
};
