import * as Y from 'yjs';
import { merge3 } from '#lib/model/merge.ts';
import { setText } from '#lib/project/pull.ts';

/** The id of the Yjs item that holds `text` in its map: the same in two documents exactly when both got that text
 *  from the same place, so that Yjs merges their edits character by character. */
function identity(text: Y.Text): string {
    // The position past the end of a text names the text itself (no public API gives a type's id otherwise).
    const at = Y.createRelativePositionFromTypeIndex(text, text.length);
    return at.type === null ? '' : `${at.type.client}:${at.type.clock}`;
}

/** Whether every file `local` has is the very text `room` has under that path, so that the two documents are copies
 *  of one and may be merged as Yjs documents. Two texts made separately from the same file are not: merged as
 *  documents, one of them would be thrown away whole, with its edits. */
export function sameTexts(local: Y.Doc, room: Y.Doc): boolean {
    const mine = local.getMap<Y.Text>('files');
    const theirs = room.getMap<Y.Text>('files');
    for (const [path, text] of mine) {
        const other = theirs.get(path);
        if (!other || identity(text) !== identity(other)) return false;
    }
    return true;
}

/** Brings what was done away from the room back into it: `local` is a session's two documents as this browser has
 *  them, `room` the room's as just synced. Changes `room`'s documents only (as this user's own edits, which the
 *  room client sends), and returns the files in which both sides changed the same place differently, each kept with
 *  git's conflict markers around both versions.
 *
 *  Where `local` is a copy of the room's documents, the two are merged as Yjs documents: every edit lands where it
 *  was made. Otherwise (a session started from GitHub while the room was away, or a room made anew since) each
 *  file is merged as text, three ways: `base` gives, per path, the text both sides started from; a file with no
 *  base is taken to have started empty. A file the room does not have is left out: it joins the room through
 *  `open`, as any file does.
 *
 *  Comment threads and accepted suggestions are merged entry by entry in both cases: an entry both changed keeps one
 *  side's whole. */
export function rejoin(
    local: { readonly text: Y.Doc; readonly review: Y.Doc },
    room: { readonly text: Y.Doc; readonly review: Y.Doc },
    base: Readonly<Record<string, string>>,
): string[] {
    const conflicts: string[] = [];
    if (sameTexts(local.text, room.text)) {
        Y.applyUpdate(room.text, Y.encodeStateAsUpdate(local.text, Y.encodeStateVector(room.text)));
    } else {
        const theirs = room.text.getMap<Y.Text>('files');
        room.text.transact(() => {
            for (const [path, mine] of local.text.getMap<Y.Text>('files')) {
                const their = theirs.get(path);
                const was = base[path] ?? '';
                const text = mine.toJSON();
                if (!their || text === was) continue;
                const merged = merge3(was, text, their.toJSON(), 'this device', 'room');
                if (merged.conflicts > 0) conflicts.push(path);
                setText(their, merged.text);
            }
        });
    }
    // The review document's maps are the document's own (root) types: the same in any two documents.
    Y.applyUpdate(room.review, Y.encodeStateAsUpdate(local.review, Y.encodeStateVector(room.review)));
    return conflicts;
}
