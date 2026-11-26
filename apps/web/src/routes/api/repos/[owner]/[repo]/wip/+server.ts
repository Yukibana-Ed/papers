import { error, json } from '@sveltejs/kit';
import { body, gh, parseChanges, requireSession } from '#lib/server/api.ts';
import { wipBackup } from '#lib/server/github.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async event => {
    const s = await requireSession(event);
    const b = await body(event);
    const changes = parseChanges(b['changes']);
    const { branch, head } = b;
    if (typeof branch !== 'string' || typeof head !== 'string' || !changes) error(400, 'Invalid backup');
    return json({ commit: await gh(() => wipBackup(s.access, event.params.owner, event.params.repo, branch, head, changes)) });
};
