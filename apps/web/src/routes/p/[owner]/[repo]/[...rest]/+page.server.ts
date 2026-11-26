import type { PageServerLoad } from './$types';
import { contentOrigin } from '#lib/server/content-origin.ts';
import { workerPlatform } from '#lib/server/platform.ts';

/** `/p/<owner>/<repo>[/<branch>[/<file>]]`: a repository's branch in the editor, on one of its documents. The branch
 *  and the file are told apart in the page, against the repository's branches (a branch name may hold slashes).
 *  `?branch=` and `?root=` still work. Signing in happens in the page, which asks for a GitHub token and is sent to
 *  sign in when there is none. */
export const load: PageServerLoad = event => ({
    rest: event.params.rest,
    branch: event.url.searchParams.get('branch'),
    root: event.url.searchParams.get('root'),
    contentOrigin: contentOrigin(workerPlatform()),
});
