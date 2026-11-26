import { error, redirect } from '@sveltejs/kit';
import { authEnv, loginUrl } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = event => {
    const env = authEnv(event);
    if (!env) error(503, 'Sign-in is not configured here');
    redirect(302, loginUrl(event, env, event.url.searchParams.get('to') ?? '/'));
};
