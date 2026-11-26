import { error, redirect } from '@sveltejs/kit';
import { authEnv, finishLogin } from '#lib/server/auth.ts';
import { viewer } from '#lib/github/api.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async event => {
    const env = authEnv(event);
    if (!env) error(503, 'Sign-in is not configured here');
    const to = await finishLogin(event, env, viewer);
    if (to === null) error(400, 'Sign-in failed');
    redirect(302, to);
};
