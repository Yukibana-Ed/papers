import type { PageServerLoad } from './$types';

/** Without wrangler's platform env (a plain `vite dev`), the content app's dev server. */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

/** `/p/<owner>/<repo>?branch=<branch>`: a repository's branch in the editor. Signing in happens in the page, which
 *  asks for a GitHub token and is sent to sign in when there is none. */
export const load: PageServerLoad = event => ({
    branch: event.url.searchParams.get('branch'),
    root: event.url.searchParams.get('root'),
    contentOrigin: event.platform?.env.CONTENT_ORIGIN ?? DEV_CONTENT_ORIGIN,
});
