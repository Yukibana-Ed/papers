// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomClient } from '#lib/room/client.ts';
import { syncReview } from '#lib/room/sync.svelte.ts';
import { Session, type SessionSeed } from '#lib/session.svelte.ts';
import type { Thread } from '#lib/model/types.ts';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

const MAIN = 'main.tex';

function seed(over: Partial<SessionSeed> = {}): SessionSeed {
    const text = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
    return {
        repo: { owner: 'o', name: 'r' },
        me: 'me',
        users: { me: { id: 'me', name: 'Me', initials: 'ME', hue: 10 } },
        files: { [MAIN]: text },
        order: [MAIN],
        base: { [MAIN]: text },
        branches: { main: { name: 'main', users: [], pr: null } },
        branch: 'main',
        commits: [],
        threads: [],
        presence: [],
        ...over,
    };
}

const thread = (id: string, body: string, draft = false): Thread => ({
    id,
    source: 'team',
    file: MAIN,
    quote: 'Hello',
    ...(draft ? { draft } : {}),
    root: { id: `${id}r`, author: 'me', when: 'now', resolved: false, body, replies: [] },
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Session.commit', () => {
    it('commits through the backend, makes the files the base, and clears the message', async () => {
        const s = new Session(seed());
        s.edit(MAIN, `${s.files[MAIN]}More.\n`);
        expect(s.uncommitted).toBeGreaterThan(0);
        const commit = vi.fn(async () => 'abcdef1234567890');
        s.backend = { commit };
        s.commitMessage = '  Say more  ';
        await s.commit();
        expect(commit).toHaveBeenCalledWith('Say more', [{ path: MAIN, text: s.files[MAIN] }]);
        expect(s.uncommitted).toBe(0);
        expect(s.commits[0]).toMatchObject({ hash: 'abcdef1', msg: 'Say more', author: 'me' });
        expect(s.commitMessage).toBe('');
        expect(s.justCommitted).toBe(true);
    });

    it('uses the default message, and keeps everything uncommitted when the backend refuses', async () => {
        const s = new Session(seed());
        s.edit(MAIN, 'changed\n');
        const commit = vi.fn(async (_message: string): Promise<string> => {
            throw new Error('Pull first');
        });
        s.backend = { commit };
        await s.commit();
        expect(commit.mock.calls[0]?.[0]).toBe(`Update ${MAIN}`);
        expect(s.uncommitted).toBeGreaterThan(0);
        expect(s.toast?.text).toBe('Pull first');
        expect(s.committing).toBe(false);
    });

    it('does nothing with nothing to commit, and shows "committed" for 2 s after the last commit', async () => {
        vi.useFakeTimers();
        const s = new Session(seed());
        const commit = vi.fn(async () => '1111111');
        s.backend = { commit };
        await s.commit();
        expect(commit).not.toHaveBeenCalled();
        s.edit(MAIN, 'one\n');
        await s.commit();
        vi.advanceTimersByTime(1500);
        s.edit(MAIN, 'two\n');
        await s.commit();
        vi.advanceTimersByTime(1500);
        // The first commit's timer must not end the second one's moment.
        expect(s.justCommitted).toBe(true);
        vi.advanceTimersByTime(600);
        expect(s.justCommitted).toBe(false);
    });
});

/** The parts of a `RoomClient` that `syncReview` uses: a review document and its awareness. */
function fakeRoom(): { room: RoomClient; review: Y.Doc; awareness: Awareness } {
    const review = new Y.Doc();
    const awareness = new Awareness(review);
    return { room: { review, awareness } as unknown as RoomClient, review, awareness };
}

describe('syncReview', () => {
    it("pushes posted threads to the room's map, never drafts, and deletes what is gone", () => {
        const s = new Session(seed());
        const { room, review } = fakeRoom();
        const stop = syncReview(s, room);
        s.threads = [thread('a', 'first'), thread('d', '', true)];
        flushSync();
        const map = review.getMap<string>('threads');
        expect([...map.keys()]).toEqual(['a']);
        expect(JSON.parse(map.get('a') ?? '{}')).toMatchObject({ id: 'a', root: { body: 'first' } });
        s.threads = s.threads.filter(t => t.id !== 'a');
        flushSync();
        expect(map.size).toBe(0);
        stop();
    });

    it("pulls the room's threads, keeping local drafts and unchanged objects, and writes nothing back for them", () => {
        const kept = thread('a', 'same');
        const s = new Session(seed({ threads: [kept] }));
        const { room, review } = fakeRoom();
        const map = review.getMap<string>('threads');
        map.set('a', JSON.stringify(kept));
        const stop = syncReview(s, room);
        flushSync();
        s.threads = [...s.threads, thread('d', '', true)];
        flushSync();
        const local = s.threads[0];
        const updates: Uint8Array[] = [];
        review.on('update', (u: Uint8Array) => updates.push(u));
        const other = new Y.Doc();
        Y.applyUpdate(other, Y.encodeStateAsUpdate(review));
        other.getMap<string>('threads').set('b', JSON.stringify(thread('b', 'theirs')));
        Y.applyUpdate(review, Y.encodeStateAsUpdate(other), 'remote');
        flushSync();
        expect(s.threads.map(t => t.id)).toEqual(['a', 'b', 'd']);
        expect(s.threads[0]).toBe(local);
        // Only the remote update itself: the pull wrote nothing back.
        expect(updates).toHaveLength(1);
        stop();
    });

    it('sets my presence in one awareness change per cursor line, and lists the others', () => {
        const s = new Session(seed());
        const { room, awareness } = fakeRoom();
        const changes: unknown[] = [];
        awareness.on('change', (c: unknown) => changes.push(c));
        const stop = syncReview(s, room);
        flushSync();
        expect(awareness.getLocalState()).toEqual({ user: 'me', cursor: { file: s.cursor.file, line: s.cursor.line } });
        const before = changes.length;
        expect(before).toBe(1);
        s.cursor = { ...s.cursor, col: 5 };
        flushSync();
        expect(changes).toHaveLength(before);
        s.cursor = { ...s.cursor, line: 3 };
        flushSync();
        expect(changes).toHaveLength(before + 1);

        const peer = new Awareness(new Y.Doc());
        peer.setLocalState({ user: 'ann', cursor: { file: MAIN, line: 2 } });
        awareness.getStates().set(peer.clientID, { user: 'ann', cursor: { file: MAIN, line: 2 } });
        awareness.emit('change', [{ added: [peer.clientID], updated: [], removed: [] }, 'remote']);
        expect(s.presence).toEqual([{ user: 'ann', file: MAIN, line: 2 }]);
        peer.destroy();
        stop();
    });
});
