import { authEnv, getSession } from '#lib/server/auth.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async event => {
    const s = await getSession(event);
    return { me: s ? { login: s.login, name: s.name } : null, signIn: authEnv(event) !== null };
};
