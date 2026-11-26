import type { Handle } from '@sveltejs/kit/hooks';
import { dev } from '$app/env';
import { contentHeaders, contentPolicy } from '#lib/headers.ts';
import { appOrigin } from '#lib/origin.ts';
import { workerPlatform } from '#lib/platform.ts';

export const handle: Handle = async ({ event, resolve }) => {
    const response = await resolve(event);
    const app = appOrigin(workerPlatform(), dev);
    for (const [name, value] of Object.entries(contentHeaders())) response.headers.set(name, value);
    response.headers.set('Content-Security-Policy', contentPolicy(response.headers.get('Content-Security-Policy') ?? '', app));
    return response;
};
