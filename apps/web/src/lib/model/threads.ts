import type { Comment } from './types.ts';

/** `c` with the comment `id` replaced by `fn` of it. Unchanged subtrees are shared. */
export function mapTree(c: Comment, id: string, fn: (c: Comment) => Comment): Comment {
    if (c.id === id) return fn(c);
    let changed = false;
    const replies = c.replies.map(r => {
        const n = mapTree(r, id, fn);
        if (n !== r) changed = true;
        return n;
    });
    return changed ? { ...c, replies } : c;
}

/** `c` and everything under it, resolved. */
export function resolveAll(c: Comment): Comment {
    return { ...c, resolved: true, replies: c.replies.map(resolveAll) };
}

/** The ids from `c` down to the comment `id`, both included; null if `id` is not under `c`. */
export function pathTo(c: Comment, id: string): string[] | null {
    if (c.id === id) return [c.id];
    for (const r of c.replies) {
        const p = pathTo(r, id);
        if (p) return [c.id, ...p];
    }
    return null;
}

/** The comment `id` under `c`, or null. */
export function findComment(c: Comment, id: string): Comment | null {
    if (c.id === id) return c;
    for (const r of c.replies) {
        const f = findComment(r, id);
        if (f) return f;
    }
    return null;
}

/** `root` with `reply` added under `parentId`. A reply under a resolved comment reopens that level and every level
 *  above it: a new answer is an open question again. */
export function addReply(root: Comment, parentId: string, reply: Comment): Comment {
    let r = root;
    for (const id of pathTo(root, parentId) ?? []) r = mapTree(r, id, c => ({ ...c, resolved: false }));
    return mapTree(r, parentId, c => ({ ...c, replies: [...c.replies, reply] }));
}

/** `root` with the comment `id` resolved (with all under it) or reopened (itself only). */
export function setResolved(root: Comment, id: string, resolved: boolean): Comment {
    return mapTree(root, id, c => (resolved ? resolveAll(c) : { ...c, resolved: false }));
}
