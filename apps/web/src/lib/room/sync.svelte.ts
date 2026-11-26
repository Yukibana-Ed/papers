import type * as Y from 'yjs';
import type { Presence, Thread } from '#lib/model/types.ts';
import { githubUser } from '#lib/model/user.ts';
import type { Session } from '#lib/session.svelte.ts';
import type { RoomClient } from './client.ts';
import { parseRoomThread } from './thread-shape.ts';

/** Keeps a session's threads and presence and the room's review document the same, both ways. Threads are JSON values
 *  of the `threads` map, keyed by id: a thread changed by two people at once keeps the later write, and every change
 *  to a thread rewrites it whole (threads are small). Drafts stay local until posted. Entries that are not threads
 *  (`parseRoomThread`) are left out of the session, and left alone in the room. */
export function syncReview(session: Session, room: RoomClient): () => void {
    const map: Y.Map<string> = room.review.getMap<string>('threads');
    /** Ids in the room whose entries are not threads: not shown, and not deleted by the push below. */
    let invalid = new Set<string>();

    const pull = (): void => {
        const local = new Map(session.threads.map(t => [t.id, t]));
        const next: Thread[] = [];
        const bad = new Set<string>();
        for (const [id, json] of map) {
            const current = local.get(id);
            if (current && JSON.stringify(current) === json) next.push(current);
            else {
                const t = parseRoomThread(id, json);
                if (t) next.push(t);
                else bad.add(id);
            }
        }
        invalid = bad;
        for (const t of session.threads) if (t.draft) next.push(t);
        session.threads = next;
    };
    map.observe(pull);
    if (map.size) pull();

    const stopPush = $effect.root(() => {
        $effect(() => {
            // After a pull this writes nothing: every thread is already the JSON the map has.
            const threads = session.threads.filter(t => !t.draft);
            room.review.transact(() => {
                const ids = new Set<string>();
                for (const t of threads) {
                    ids.add(t.id);
                    const json = JSON.stringify(t);
                    if (map.get(t.id) !== json) map.set(t.id, json);
                }
                for (const id of Array.from(map.keys())) if (!ids.has(id) && !invalid.has(id)) map.delete(id);
            });
        });

        // My presence: who I am, where my cursor is and what I have selected, as one awareness change (the client
        // throttles what it sends).
        $effect(() => {
            const c = session.cursor;
            const s = session.selection;
            const user = session.me;
            const next = {
                user,
                name: session.users[user]?.name ?? user,
                cursor: { file: c.file, line: c.line, column: c.col },
                selection: s === null || s.startColumn === undefined || s.endColumn === undefined ? null : { file: s.file, range: [s.startLine, s.startColumn, s.endLine, s.endColumn] },
            };
            if (JSON.stringify(room.awareness.getLocalState()) === JSON.stringify(next)) return;
            room.awareness.setLocalState(next);
        });
    });

    const onAwareness = (): void => {
        const list: Presence[] = [];
        // Every other window in the room, the user's own other windows among them.
        for (const [id, state] of room.awareness.getStates()) {
            if (id === room.awareness.clientID) continue;
            const p = presenceOf(state);
            if (p === null) continue;
            const name: unknown = state['name'];
            session.meet(githubUser(p.user, typeof name === 'string' && name !== '' ? name.slice(0, 80) : p.user));
            list.push(p);
        }
        session.presence = list;
    };
    room.awareness.on('change', onAwareness);

    return () => {
        map.unobserve(pull);
        room.awareness.off('change', onAwareness);
        stopPush();
    };
}

/** The presence an awareness `state` describes, or null when it is not one: states are other clients' words, so
 *  every field is checked. */
export function presenceOf(state: Readonly<Record<string, unknown>>): Presence | null {
    const user = state['user'];
    const cursor = state['cursor'];
    if (typeof user !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user) || typeof cursor !== 'object' || cursor === null) return null;
    const file: unknown = Reflect.get(cursor, 'file');
    const line: unknown = Reflect.get(cursor, 'line');
    const column: unknown = Reflect.get(cursor, 'column');
    const at = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
    if (typeof file !== 'string' || !at(line)) return null;
    const selection = state['selection'];
    const range: unknown = typeof selection === 'object' && selection !== null && Reflect.get(selection, 'file') === file ? Reflect.get(selection, 'range') : null;
    const [startLineNumber, startColumn, endLineNumber, endColumn]: unknown[] = Array.isArray(range) && range.length === 4 ? range : [];
    return {
        user,
        file,
        line,
        ...(at(column) ? { column } : {}),
        ...(at(startLineNumber) && at(startColumn) && at(endLineNumber) && at(endColumn) ? { selection: { startLineNumber, startColumn, endLineNumber, endColumn } } : {}),
    };
}
