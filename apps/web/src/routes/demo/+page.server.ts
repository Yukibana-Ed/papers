import type { PageServerLoad } from './$types';
import { contentOrigin } from '#lib/server/content-origin.ts';

export const load: PageServerLoad = ({ platform }) => ({ contentOrigin: contentOrigin(platform) });
