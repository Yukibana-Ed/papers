import { importKey, seal, unseal } from './seal.ts';

/** A room ticket: who may join which room, with what access, until when. The app's Worker mints it after checking a
 *  GitHub token the page presents, once; the room's WebSocket upgrade then carries only the ticket, so no GitHub
 *  token is ever stored or sent to the room. Sealed with the session key; valid for a minute. */
export interface RoomTicket {
    readonly login: string;
    readonly name: string;
    readonly access: 'write' | 'comment';
    /** The room's name: `<owner>/<repo>#<branch>`, owner and repo lower-cased. */
    readonly room: string;
    readonly expires: number;
}

const PURPOSE = 'room-ticket/v1';
export const TICKET_TTL_MS = 60_000;

/** The room of a branch. GitHub names are case-insensitive, branch names are not. */
export function roomName(owner: string, repo: string, branch: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${branch}`;
}

export async function mintTicket(key: string, t: RoomTicket): Promise<string> {
    return seal(await importKey(key), PURPOSE, t);
}

/** The ticket `raw` holds if it is genuine, for `room`, and not expired at `now`; null otherwise. */
export async function checkTicket(key: string, raw: string, room: string, now: number): Promise<RoomTicket | null> {
    const t = await unseal(await importKey(key), PURPOSE, raw);
    if (typeof t !== 'object' || t === null) return null;
    const r = t as Record<string, unknown>;
    const access = r['access'];
    if (typeof r['login'] !== 'string' || typeof r['name'] !== 'string' || (access !== 'write' && access !== 'comment') || r['room'] !== room || typeof r['expires'] !== 'number')
        return null;
    if (r['expires'] < now) return null;
    return { login: r['login'], name: r['name'], access, room, expires: r['expires'] };
}
