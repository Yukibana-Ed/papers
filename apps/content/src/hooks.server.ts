import type { Handle } from '@sveltejs/kit/hooks';
import { contentHeaders } from '#lib/headers.ts';

/** Development has no platform env unless wrangler.jsonc is read; the app's dev server is the default parent. */
const DEV_APP_ORIGIN = 'http://localhost:5180';

export const handle: Handle = async ({ event, resolve }) => {
    const response = await resolve(event);
    const appOrigin = event.platform?.env.APP_ORIGIN ?? DEV_APP_ORIGIN;
    for (const [name, value] of Object.entries(contentHeaders(appOrigin))) response.headers.set(name, value);
    return response;
};
