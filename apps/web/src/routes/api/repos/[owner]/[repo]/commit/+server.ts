import { error, json } from '@sveltejs/kit';
import { body, gh, parseChanges, requireSession } from '#lib/server/api.ts';
import { commit } from '#lib/server/github.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async event => {
    const s = await requireSession(event);
    const b = await body(event);
    const changes = parseChanges(b['changes']);
    const { branch, head, message } = b;
    if (typeof branch !== 'string' || typeof head !== 'string' || typeof message !== 'string' || !changes?.length) error(400, 'Invalid commit');
    return json({ commit: await gh(() => commit(s.access, event.params.owner, event.params.repo, branch, head, message, changes)) });
};
