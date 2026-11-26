import type * as Y from 'yjs';
import type { Thread } from '#lib/model/types.ts';
import type { Session } from '#lib/session.svelte.ts';
import type { RoomClient } from './client.ts';

/** Keeps a session's threads and presence and the room's review document the same, both ways. Threads are JSON values
 *  of the `threads` map, keyed by id: a thread changed by two people at once keeps the later write, and every change
 *  to a thread rewrites it whole (threads are small). Drafts stay local until posted. */
export function syncReview(session: Session, room: RoomClient): () => void {
    const map: Y.Map<string> = room.review.getMap<string>('threads');
    let fromRoom = false;

    const pull = (): void => {
        const local = new Map(session.threads.map(t => [t.id, t]));
        const next: Thread[] = [];
        for (const [id, json] of map) {
            const current = local.get(id);
            next.push(current && JSON.stringify(current) === json ? current : (JSON.parse(json) as Thread));
        }
        for (const t of session.threads) if (t.draft) next.push(t);
        fromRoom = true;
        session.threads = next;
        fromRoom = false;
    };
    map.observe(pull);
    if (map.size) pull();

    const stopPush = $effect.root(() => {
        $effect(() => {
            const threads = session.threads.filter(t => !t.draft);
            if (fromRoom) return;
            room.review.transact(() => {
                const ids = new Set<string>();
                for (const t of threads) {
                    ids.add(t.id);
                    const json = JSON.stringify(t);
                    if (map.get(t.id) !== json) map.set(t.id, json);
                }
                for (const id of Array.from(map.keys())) if (!ids.has(id)) map.delete(id);
            });
        });

        // My presence: where my cursor is.
        $effect(() => {
            const c = session.cursor;
            room.awareness.setLocalStateField('user', session.me);
            room.awareness.setLocalStateField('cursor', { file: c.file, line: c.line });
        });
    });

    const onAwareness = (): void => {
        const list = [];
        for (const [id, state] of room.awareness.getStates()) {
            if (id === room.awareness.clientID) continue;
            const user: unknown = state['user'];
            const cursor: unknown = state['cursor'];
            if (typeof user !== 'string' || typeof cursor !== 'object' || cursor === null) continue;
            const file: unknown = Reflect.get(cursor, 'file');
            const line: unknown = Reflect.get(cursor, 'line');
            if (typeof file === 'string' && typeof line === 'number') list.push({ user, file, line });
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
