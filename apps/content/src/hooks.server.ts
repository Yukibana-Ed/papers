import type { Handle } from '@sveltejs/kit/hooks';
import { dev } from '$app/env';
import { contentHeaders } from '#lib/headers.ts';
import { appOrigin } from '#lib/origin.ts';
import { workerPlatform } from '#lib/platform.ts';

export const handle: Handle = async ({ event, resolve }) => {
    const response = await resolve(event);
    for (const [name, value] of Object.entries(contentHeaders(appOrigin(workerPlatform(), dev)))) response.headers.set(name, value);
    return response;
};
