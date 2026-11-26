import { redirect } from '@sveltejs/kit';
import { getSession } from '#lib/server/auth.ts';
import type { PageServerLoad } from './$types';

/** Without wrangler's platform env (a plain `vite dev`), the content app's dev server. */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

/** `/p/<owner>/<repo>?branch=<branch>`: a repository's branch in the editor, for a signed-in user. */
export const load: PageServerLoad = async event => {
    const s = await getSession(event);
    if (!s) redirect(302, `/auth/login?to=${encodeURIComponent(event.url.pathname + event.url.search)}`);
    return {
        me: { login: s.login, name: s.name },
        branch: event.url.searchParams.get('branch'),
        contentOrigin: event.platform?.env.CONTENT_ORIGIN ?? DEV_CONTENT_ORIGIN,
    };
};
