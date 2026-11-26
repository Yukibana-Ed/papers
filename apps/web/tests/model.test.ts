import { describe, expect, it } from 'vitest';
import { changedLines } from '#lib/model/diff.ts';
import { addReply, findComment, pathTo, setResolved } from '#lib/model/threads.ts';
import type { Comment } from '#lib/model/types.ts';

const c = (id: string, resolved: boolean, replies: Comment[] = []): Comment => ({ id, author: 'a', when: 'now', resolved, body: id, replies });

describe('threads', () => {
    const tree = c('r', false, [c('a', true, [c('a1', true)]), c('b', false)]);

    it('finds paths', () => {
        expect(pathTo(tree, 'a1')).toEqual(['r', 'a', 'a1']);
        expect(pathTo(tree, 'zz')).toBeNull();
    });

    it('reopens the levels above a new reply', () => {
        const t = addReply(tree, 'a1', c('new', false));
        expect(findComment(t, 'a')?.resolved).toBe(false);
        expect(findComment(t, 'a1')?.replies.map(x => x.id)).toEqual(['new']);
        expect(findComment(t, 'b')).toBe(findComment(tree, 'b'));
    });

    it('resolves a level with everything under it, and reopens only the level', () => {
        const done = setResolved(tree, 'r', true);
        expect(findComment(done, 'b')?.resolved).toBe(true);
        const again = setResolved(done, 'r', false);
        expect(again.resolved).toBe(false);
        expect(findComment(again, 'b')?.resolved).toBe(true);
    });
});

describe('changedLines', () => {
    it('counts like a diffstat', () => {
        expect(changedLines('a\nb\nc', 'a\nb\nc')).toEqual({ add: 0, del: 0 });
        expect(changedLines('a\nb\nc', 'a\nx\nc')).toEqual({ add: 1, del: 1 });
        expect(changedLines('a\nc', 'a\nb\nc')).toEqual({ add: 1, del: 0 });
        expect(changedLines('a\nb\nc\nd', 'b\nd\ne')).toEqual({ add: 1, del: 2 });
    });
});
