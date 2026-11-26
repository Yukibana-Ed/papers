import { authEnv } from '#lib/server/auth.ts';
import type { PageServerLoad } from './$types';

/** `/new?template=<owner>/<repo>/<folder>` or `?template=@preview/<name>:<version>`: the New paper dialog, with that
 *  template chosen. */
export const load: PageServerLoad = event => ({
    template: event.url.searchParams.get('template'),
    signInConfigured: authEnv(event) !== null,
});
