import type { User } from '#lib/model/types.ts';

/** A GitHub user as the app draws them, from their login alone: the hue is stable per login, the initials come from
 *  `name`, and the picture is their GitHub one (initials show until it loads, and if it does not). */
export function githubUser(login: string, name = login): User {
    let h = 0;
    for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const parts = name.split(/\s+/).filter(Boolean);
    const initials = ((parts[0]?.[0] ?? login[0] ?? '?') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
    return { id: login, name, initials, hue: h, picture: `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64` };
}
