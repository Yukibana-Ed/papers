import type { PageServerLoad } from './$types';
import { contentOrigin } from '#lib/server/content-origin.ts';
import { workerPlatform } from '#lib/server/platform.ts';

export const load: PageServerLoad = () => ({ contentOrigin: contentOrigin(workerPlatform()) });
