import { json } from '@sveltejs/kit';
import { gh, requireSession } from '#lib/server/api.ts';
import { repoInfo } from '#lib/server/github.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async event => {
    const s = await requireSession(event);
    return json(await gh(() => repoInfo(s.access, event.params.owner, event.params.repo)));
};
