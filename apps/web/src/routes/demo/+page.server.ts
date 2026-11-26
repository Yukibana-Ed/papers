import type { PageServerLoad } from './$types';

/** Without wrangler's platform env (a plain `vite dev`), the content app's dev server. */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

export const load: PageServerLoad = ({ platform }) => ({ contentOrigin: platform?.env.CONTENT_ORIGIN ?? DEV_CONTENT_ORIGIN });
