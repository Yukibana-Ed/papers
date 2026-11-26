import { dev } from '$app/env';

/** The content app's dev server. `VITE_CONTENT_ORIGIN` overrides it (a second checkout running side by side). */
const DEV_CONTENT_ORIGIN = 'http://localhost:5185';

/** The content origin this app embeds.
 *
 *  In production and previews, the Worker's `CONTENT_ORIGIN` var (wrangler.jsonc; a preview upload sets the content
 *  preview's). In development, the content app's dev server: the platform proxy hands over wrangler.jsonc's production
 *  value, which a local app must not embed. Outside development a missing var is an error, never a quiet fallback to a
 *  local address (the deployed app once framed http://localhost:5185 because the var was not read). */
export function contentOrigin(platform: App.Platform | undefined, isDev = dev): string {
    if (isDev) {
        const override: unknown = import.meta.env['VITE_CONTENT_ORIGIN'];
        return typeof override === 'string' && override !== '' ? override : DEV_CONTENT_ORIGIN;
    }
    const v = platform?.env.CONTENT_ORIGIN;
    if (!v) throw new Error('CONTENT_ORIGIN is not set for this Worker (wrangler.jsonc vars)');
    return v;
}
