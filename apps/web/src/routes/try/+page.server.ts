import type { PageServerLoad } from './$types';

/** Without wrangler's platform env (a plain `vite dev`), the content app's dev server. */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

export const load: PageServerLoad = event => ({ contentOrigin: event.platform?.env.CONTENT_ORIGIN ?? DEV_CONTENT_ORIGIN });
