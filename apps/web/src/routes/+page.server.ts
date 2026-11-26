import { authEnv, getSession } from '#lib/server/auth.ts';
import { workerPlatform } from '#lib/server/platform.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async event => {
    const s = await getSession(event);
    const slug = workerPlatform().env.GITHUB_APP_SLUG;
    return { me: s ? { login: s.login, name: s.name } : null, signIn: authEnv(event) !== null, install: slug ? `https://github.com/apps/${slug}/installations/new` : null };
};
