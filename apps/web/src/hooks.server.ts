import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { getSession } from '#lib/server/auth.ts';
import { GitHubError, repoInfo } from '#lib/server/github.ts';
import { appHeaders } from '#lib/headers.ts';

/** Without wrangler's platform env (a plain `vite dev`), the content app's dev server. */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

/** The header the room trusts for who is connecting (apps/room/src/worker.ts). */
const IDENTITY_HEADER = 'X-Yukibana-Identity';

/** `/room/<owner>/<repo>/<branch>`: a WebSocket to the branch's room, for a signed-in user with access to the
 *  repository on GitHub. The room learns who they are and what they may do from this Worker alone. */
async function room(event: RequestEvent): Promise<Response | null> {
    const m = /^\/room\/([^/]+)\/([^/]+)\/(.+)$/.exec(event.url.pathname);
    if (!m) return null;
    const [, owner = '', repo = '', branch = ''] = m;
    const rooms = event.platform?.env.ROOM;
    if (!rooms) return new Response('No rooms here', { status: 503 });
    if (event.request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (event.request.headers.get('Origin') !== event.url.origin) return new Response('Cross-origin', { status: 403 });
    const s = await getSession(event);
    if (!s) return new Response('Sign in', { status: 401 });
    let access: 'write' | 'comment';
    try {
        access = (await repoInfo(s.access, owner, repo)).access;
    } catch (e) {
        return new Response('No access', { status: e instanceof GitHubError && e.status === 404 ? 404 : 403 });
    }
    const headers = new Headers(event.request.headers);
    headers.set(IDENTITY_HEADER, JSON.stringify({ login: s.login, name: s.name, access }));
    // One room per branch; GitHub names are case-insensitive, branches are not.
    const name = `${owner.toLowerCase()}/${repo.toLowerCase()}#${decodeURIComponent(branch)}`;
    return rooms.get(rooms.idFromName(name)).fetch(new Request(event.request, { headers }));
}

export const handle: Handle = async ({ event, resolve }) => {
    const ws = await room(event);
    if (ws) return ws;
    const response = await resolve(event);
    const contentOrigin = event.platform?.env.CONTENT_ORIGIN ?? DEV_CONTENT_ORIGIN;
    for (const [name, value] of Object.entries(appHeaders(contentOrigin))) response.headers.set(name, value);
    return response;
};
