import { env } from 'cloudflare:workers';

/** The Worker's vars and bindings, as SvelteKit's `App.Platform`. SvelteKit 3's Cloudflare adapter no longer fills
 *  `event.platform` (it stayed undefined in production, so every var fell back to its development default);
 *  `cloudflare:workers` is the one source, and in development the adapter emulates it from wrangler.jsonc. */
export function workerPlatform(): App.Platform {
    return { env };
}
