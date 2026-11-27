import * as Y from 'yjs';
import type { IdSet } from '@yukibana/papers-room-protocol';
import type { Run } from './model.ts';

/** What `yRuns` needs to know about people. */
export interface Who {
    /** The login `client` writes as, or null when not known. */
    writer(client: number): string | null;
    /** Who deleted `client`'s `clock`, and for how many clocks from there (at most `len`) that holds. */
    deleter(client: number, clock: number, len: number): { readonly value: string | null; readonly len: number };
    /** Who suggested the text inserted at `client`'s `clock`, if it was an accepted suggestion, with the run length. */
    suggester(client: number, clock: number, len: number): { readonly value: string | null; readonly len: number };
}

/** The runs of `text` against its committed state: `baseText`, made of the characters `baseIds` names.
 *
 *  Walks the text's items in their CRDT order, deleted ones included: an item's characters are in the committed state
 *  when `baseIds` has them, and in the session's text when the item is not deleted. Deleted characters keep their place
 *  and ids but not their content, which `baseText` gives back, in order. Returns null when `baseIds` does not spell
 *  `baseText` (ids from another state of the room): the caller compares texts instead. */
export function yRuns(text: Y.Text, baseText: string, baseIds: IdSet, who: Who): Run[] | null {
    const runs: Run[] = [];
    let at = 0;
    // The items, deleted ones included, are only reachable through Yjs's own field: no public API walks them with ids.
    // oxlint-disable-next-line no-underscore-dangle
    for (let item = text._start; item !== null; item = item.right) {
        if (!item.countable) continue;
        const str = !item.deleted && item.content instanceof Y.ContentString ? item.content.str : null;
        if (!item.deleted && str === null) return null;
        const { client, clock } = item.id;
        let off = 0;
        while (off < item.length) {
            const b = baseIds.run(client, clock + off, item.length - off);
            let len = b.len;
            const now = !item.deleted;
            if (!b.inSet && !now) {
                off += len;
                continue;
            }
            let by: string | null = null;
            let acceptedBy: string | undefined;
            if (now && !b.inSet) {
                const s = who.suggester(client, clock + off, len);
                len = s.len;
                const writer = who.writer(client);
                if (s.value !== null) {
                    by = s.value;
                    if (writer !== null) acceptedBy = writer;
                } else by = writer;
            } else if (!now) {
                const d = who.deleter(client, clock + off, len);
                len = d.len;
                by = d.value;
            }
            let piece: string;
            if (b.inSet) {
                piece = baseText.slice(at, at + len);
                if (piece.length !== len || (str !== null && str.slice(off, off + len) !== piece)) return null;
                at += len;
            } else piece = (str ?? '').slice(off, off + len);
            runs.push({ text: piece, base: b.inSet, now, id: [client, clock + off], by, ...(acceptedBy !== undefined ? { acceptedBy } : {}) });
            off += len;
        }
    }
    return at === baseText.length ? runs : null;
}

/** The ids of `text`'s characters that are in it now, in order: the committed state of a text just made from a commit. */
export function visibleIds(text: Y.Text, into: IdSet): IdSet {
    // oxlint-disable-next-line no-underscore-dangle
    for (let item = text._start; item !== null; item = item.right) if (!item.deleted && item.countable) into.add(item.id.client, item.id.clock, item.length);
    return into;
}
