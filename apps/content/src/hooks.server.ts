import type { Handle } from '@sveltejs/kit/hooks';
import { dev } from '$app/env';
import { contentHeaders, contentPolicy } from '#lib/headers.ts';
import { appOrigin } from '#lib/origin.ts';
import { workerPlatform } from '#lib/platform.ts';

export const handle: Handle = async ({ event, resolve }) => {
    const response = (await fromFallback(event.url, event.request)) ?? (await resolve(event));
    const app = appOrigin(workerPlatform(), dev);
    for (const [name, value] of Object.entries(contentHeaders())) response.headers.set(name, value);
    response.headers.set('Content-Security-Policy', contentPolicy(response.headers.get('Content-Security-Policy') ?? '', app));
    return response;
};

/** Browser tests only (ASSETS_FALLBACK is set by playwright.config.ts with E2E_ENGINE, never in wrangler.jsonc): an
 *  asset (`/r2/…`) comes from the fallback origin, kept in this Worker's cache, so the tests run the real engine without
 *  an upload to the local bucket. Null for everything else, and always when the variable is unset. */
async function fromFallback(url: URL, request: Request): Promise<Response | null> {
    const origin = workerPlatform().env.ASSETS_FALLBACK;
    if (origin === undefined || origin === '' || request.method !== 'GET' || !url.pathname.startsWith('/r2/')) return null;
    const cache = caches.default;
    const key = new Request(url.href);
    const hit = await cache.match(key);
    if (hit !== undefined) return new Response(hit.body, hit);
    const upstream = await fetch(new URL(url.pathname, origin));
    // The body arrives decompressed: its encoding no longer applies.
    const headers = new Headers({ 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
    const response = new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
    await cache.put(key, response.clone());
    return response;
}
