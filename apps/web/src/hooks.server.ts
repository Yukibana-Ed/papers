import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { IDENTITY_HEADER } from '@yukibana/papers-room-protocol';
import { THEME_BOOT } from '@yukibana/design/theme';
import { appHeaders, scriptHash, withContentOrigin } from '#lib/headers.ts';
import { authEnv } from '#lib/server/auth.ts';
import { contentOrigin as contentOriginOf } from '#lib/server/content-origin.ts';
import { checkTicket, roomName } from '#lib/server/room-ticket.ts';
import { workerPlatform } from '#lib/server/platform.ts';

/** The theme script's hash: it is inline (it must run before the first paint) and not SvelteKit's own. */
const themeHash = scriptHash(THEME_BOOT);

/** `/room/<owner>/<repo>/<branch>?ticket=…`: a WebSocket to the branch's room, for the holder of a ticket from
 *  `/room/ticket`. The room learns who they are and what they may do from this Worker alone. */
async function room(event: RequestEvent): Promise<Response | null> {
    const m = /^\/room\/([^/]+)\/([^/]+)\/(.+)$/.exec(event.url.pathname);
    if (!m) return null;
    const [, owner = '', repo = '', branch = ''] = m;
    const rooms = workerPlatform().env.ROOM;
    const env = authEnv(event);
    if (!rooms || !env) return new Response('No rooms here', { status: 503 });
    if (event.request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (event.request.headers.get('Origin') !== event.url.origin) return new Response('Cross-origin', { status: 403 });
    const name = roomName(decodeURIComponent(owner), decodeURIComponent(repo), decodeURIComponent(branch));
    const ticket = await checkTicket(env.SESSION_KEY, event.url.searchParams.get('ticket') ?? '', name, Date.now());
    if (!ticket) return new Response('No ticket', { status: 401 });
    const headers = new Headers(event.request.headers);
    headers.set(IDENTITY_HEADER, JSON.stringify({ login: ticket.login, name: ticket.name, access: ticket.access }));
    return rooms.get(rooms.idFromName(name)).fetch(new Request(event.request, { headers }));
}

export const handle: Handle = async ({ event, resolve }) => {
    const ws = await room(event);
    if (ws) return ws;
    const response = await resolve(event);
    const contentOrigin = contentOriginOf(workerPlatform());
    for (const [name, value] of Object.entries(appHeaders())) response.headers.set(name, value);
    // SvelteKit writes the policy with the hashes of its own scripts; the content origin is known only at run time.
    const csp = response.headers.get('Content-Security-Policy');
    if (csp) response.headers.set('Content-Security-Policy', withContentOrigin(csp, contentOrigin, [await themeHash]));
    return response;
};
