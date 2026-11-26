import { redirect } from '@sveltejs/kit';
import { logout } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
    logout(cookies);
    redirect(303, '/');
};
