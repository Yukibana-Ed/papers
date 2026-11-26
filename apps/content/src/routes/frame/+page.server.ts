import { dev } from '$app/env';
import { appOrigin } from '#lib/origin.ts';
import { workerPlatform } from '#lib/platform.ts';

/** The frame needs to know which origin may talk to it before the first message arrives. */
export function load(): { appOrigin: string } {
    return { appOrigin: appOrigin(workerPlatform(), dev) };
}
