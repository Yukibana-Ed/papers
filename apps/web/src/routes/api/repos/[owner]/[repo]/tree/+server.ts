import { error, json } from '@sveltejs/kit';
import { gh, requireSession } from '#lib/server/api.ts';
import { tree } from '#lib/server/github.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async event => {
    const s = await requireSession(event);
    const branch = event.url.searchParams.get('branch');
    if (!branch) error(400, 'Which branch?');
    return json(await gh(() => tree(s.access, event.params.owner, event.params.repo, branch)));
};
