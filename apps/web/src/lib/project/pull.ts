import type { BaseFile } from '@yukibana/papers-room-protocol';
import * as Y from 'yjs';
import { merge3 } from '#lib/model/merge.ts';

/** What a push made outside the room brings: the branch's head and its text files there. */
export interface Theirs {
    readonly commit: string;
    readonly texts: ReadonlyMap<string, { readonly text: string; readonly blob: string }>;
}

/** A push merged into a session, ready to hand to the room in one step (`RoomClient.pulled`). */
export interface Pull {
    /** The Yjs update that makes the session's texts the merged ones. */
    readonly update: Uint8Array;
    /** The committed state of the files the push changed or added. */
    readonly files: readonly BaseFile[];
    /** The files in which the session and the push changed the same place differently, each kept with git's conflict
     *  markers around both versions. */
    readonly conflicts: readonly string[];
}

/** Makes `text` read `to`, as one change spanning where they differ. */
function setText(text: Y.Text, to: string): void {
    const from = text.toJSON();
    let start = 0;
    while (start < from.length && start < to.length && from[start] === to[start]) start++;
    let end = 0;
    while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
    if (from.length - start - end > 0) text.delete(start, from.length - start - end);
    if (to.length - start - end > 0) text.insert(start, to.slice(start, to.length - end));
}

/** The merge of `theirs` into the session `doc` holds (its `files` map: path → text):
 *  per file the push changed, a three-way merge of the committed text, the session's and theirs; files the push added
 *  join the session. Files the push deleted stay in the session. `doc` itself is not changed: the merge is made on a
 *  copy, and the room applies it for everyone, the sender included.
 *
 *  A push that changes no text file of the session gives an update that changes nothing and no files. `committed` is
 *  the session's committed state (path → text); `branch` names their side in conflict markers. */
export function mergePush(doc: Y.Doc, committed: Readonly<Record<string, string>>, theirs: Theirs, branch: string): Pull {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(copy);
    const files = copy.getMap<Y.Text>('files');
    const changed: BaseFile[] = [];
    const conflicts: string[] = [];
    copy.transact(() => {
        for (const [path, their] of theirs.texts) {
            const was = committed[path];
            const ours = files.get(path);
            if (was === their.text && ours !== undefined) continue;
            changed.push({ path, blob: their.blob, text: their.text });
            if (ours === undefined) {
                files.set(path, new Y.Text(their.text));
                continue;
            }
            const merged = merge3(was ?? '', ours.toJSON(), their.text, 'session', branch);
            if (merged.conflicts > 0) conflicts.push(path);
            setText(ours, merged.text);
        }
    });
    return { update: Y.encodeStateAsUpdate(copy, before), files: changed, conflicts };
}
