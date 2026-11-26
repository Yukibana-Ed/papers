import { dev } from '$app/env';
import { appOrigin } from '#lib/origin.ts';

/** The frame needs to know which origin may talk to it before the first message arrives. */
export function load({ platform }: { platform?: App.Platform }): { appOrigin: string } {
    return { appOrigin: appOrigin(platform, dev) };
}
