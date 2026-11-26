import type { PageServerLoad } from './$types';
import { contentOrigin } from '#lib/server/content-origin.ts';

/** `/p/<owner>/<repo>?branch=<branch>`: a repository's branch in the editor. Signing in happens in the page, which
 *  asks for a GitHub token and is sent to sign in when there is none. */
export const load: PageServerLoad = event => ({
    branch: event.url.searchParams.get('branch'),
    root: event.url.searchParams.get('root'),
    contentOrigin: contentOrigin(event.platform),
});
