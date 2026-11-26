import type { Handle } from '@sveltejs/kit/hooks';
import { appHeaders } from '#lib/headers.ts';

/** Without wrangler's platform env (a plain `vite dev`), the content app's dev server. */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

export const handle: Handle = async ({ event, resolve }) => {
    const response = await resolve(event);
    const contentOrigin = event.platform?.env.CONTENT_ORIGIN ?? DEV_CONTENT_ORIGIN;
    for (const [name, value] of Object.entries(appHeaders(contentOrigin))) response.headers.set(name, value);
    return response;
};
