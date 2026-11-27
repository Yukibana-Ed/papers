/** The room's wire format, between the app and the room's Durable Object.
 *
 *  A room is one branch of one repository. It holds two Yjs documents:
 *  - `text` (0): a `Y.Map<Y.Text>` named `files`, the text of every file someone opened or changed in this session.
 *    Only people with write access may change it.
 *  - `review` (1): the room's comment threads and suggestions, and everyone's presence (awareness). People with
 *    comment access may change it too.
 *
 *  Binary frames carry Yjs: `[doc: u8][y-protocols message]`, where the message is a sync message (`0`) or an
 *  awareness update (`1`), as y-protocols writes them. Text frames carry the JSON control messages below. */

import { IdSet } from './ids.ts';

export { IdSet };

/** The header the app's Worker sets on the room upgrade it forwards: the identity it checked (a JSON `Identity`). The
 *  room Worker has no route of its own, so only the app's Worker, through its Durable Object binding, can set it. */
export const IDENTITY_HEADER = 'X-Yukibana-Identity';

export const DOC_TEXT = 0;
export const DOC_REVIEW = 1;
export type DocId = typeof DOC_TEXT | typeof DOC_REVIEW;

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/** What a person may do in a room; derived from their GitHub permission on the repository (write and above: `write`;
 *  read: `comment`). */
export type Access = 'write' | 'comment';

/** Who a connection is, as the app's Worker vouches for them to the room. */
export interface Identity {
    readonly login: string;
    readonly name: string;
    readonly access: Access;
}

/** How live the room is, by its usage (see `limits.ts`): `live` sends every change as it happens; `batched` asks
 *  clients to send at most every `intervalMs`; `paused` stops syncing changes until `until` (epoch ms) — clients keep
 *  their edits and send them when the room is live again. */
export type SyncMode = { readonly mode: 'live' } | { readonly mode: 'batched'; readonly intervalMs: number } | { readonly mode: 'paused'; readonly until: number };

/** A file's committed state, as the room keeps it to tell what is uncommitted. */
export interface BaseFile {
    readonly path: string;
    /** The blob's git SHA-1. */
    readonly blob: string;
    readonly text: string;
    /** The characters of the session text that make up `text`, as an encoded `IdSet`: those still in the session are
     *  unchanged, those deleted from it are uncommitted deletions, and session characters outside it are uncommitted
     *  insertions. In the text's order the ids spell `text` (deleted ones included, though their content is gone).
     *  Empty when not known (a room from before ids were kept, or a push merged from outside): then the app compares
     *  texts instead. For an empty `text` the empty set is also the right one. */
    readonly items: string;
}

/** Who wrote and who deleted characters of the text document, as the room saw it happen: `writers` maps a Yjs client
 *  id to the login of the connection that first wrote with it (later writes with that id count as theirs), and
 *  `deleted` gives, for characters of a file's committed state, who deleted them (`[client, clock, len, login]`).
 *  Deletions of characters no committed state holds are not kept: they never show in a diff. */
export interface Authors {
    readonly writers: readonly (readonly [client: number, login: string])[];
    readonly deleted: readonly (readonly [client: number, clock: number, len: number, login: string])[];
}

/** Control messages from a client. */
export type ClientMessage =
    /** Puts `text` in the room as `path`'s session text, unless the room has it already. `blob` is the git blob it came
     *  from: it becomes the file's committed state. Write access only. */
    | { readonly type: 'open'; readonly path: string; readonly blob: string; readonly text: string; readonly commit: string }
    /** After a commit of the session's files: `commit` is the new head, and each file's committed state is its text
     *  as committed. Write access only. */
    | { readonly type: 'committed'; readonly commit: string; readonly files: readonly BaseFile[] }
    /** A WIP backup of the session was pushed to `refs/yukibana/wip/<branch>` at `commit`. */
    | { readonly type: 'backed-up'; readonly commit: string }
    /** The branch moved outside the room, from the room's base `from` to `to`: `update` (a Yjs update of the text
     *  document, base64) merges those commits' changes into the session, and `files` are the committed state of the
     *  files they changed. Taken as one step and only while the room's base is still `from`, so that of several
     *  people who notice the same push, one merge is applied. Write access only. */
    | { readonly type: 'pulled'; readonly from: string; readonly to: string; readonly update: string; readonly files: readonly BaseFile[] };

/** Control messages from the room. */
export type ServerMessage =
    /** The first message on a connection. */
    | { readonly type: 'welcome'; readonly you: Identity; readonly base: string | null; readonly files: readonly BaseFile[]; readonly sync: SyncMode; readonly authors: Authors }
    /** A file joined the room (someone opened it): its committed state. */
    | { readonly type: 'opened'; readonly file: BaseFile }
    /** More of `Authors`, after a change to the text: added to what the client has. */
    | ({ readonly type: 'authors' } & Authors)
    | { readonly type: 'base'; readonly base: string; readonly files: readonly BaseFile[] }
    | { readonly type: 'sync'; readonly sync: SyncMode }
    /** Someone with write access should push a WIP backup: the session has changes not in one yet. */
    | { readonly type: 'backup-due' }
    /** A message was refused, with why: `too-fast` when its sender went over their own share of the room's rate. */
    | { readonly type: 'refused'; readonly reason: 'access' | 'invalid' | 'paused' | 'too-large' | 'too-fast' };

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
}

function isBaseFile(x: unknown): x is BaseFile {
    return (
        isRecord(x) &&
        typeof x['path'] === 'string' &&
        typeof x['blob'] === 'string' &&
        typeof x['text'] === 'string' &&
        typeof x['items'] === 'string' &&
        IdSet.decode(x['items']) !== null
    );
}

/** `x` as a client message, or null if it is not one. Clients are other people's browsers: every field is checked. */
export function parseClientMessage(x: unknown): ClientMessage | null {
    if (!isRecord(x)) return null;
    switch (x['type']) {
        case 'open':
            return typeof x['path'] === 'string' && typeof x['blob'] === 'string' && typeof x['text'] === 'string' && typeof x['commit'] === 'string' && validPath(x['path'])
                ? { type: 'open', path: x['path'], blob: x['blob'], text: x['text'], commit: x['commit'] }
                : null;
        case 'committed': {
            const files = x['files'];
            return typeof x['commit'] === 'string' && Array.isArray(files) && files.every(isBaseFile) && files.every(f => validPath(f.path))
                ? { type: 'committed', commit: x['commit'], files }
                : null;
        }
        case 'backed-up':
            return typeof x['commit'] === 'string' ? { type: 'backed-up', commit: x['commit'] } : null;
        case 'pulled': {
            const files = x['files'];
            return typeof x['from'] === 'string' &&
                typeof x['to'] === 'string' &&
                typeof x['update'] === 'string' &&
                Array.isArray(files) &&
                files.every(isBaseFile) &&
                files.every(f => validPath(f.path))
                ? { type: 'pulled', from: x['from'], to: x['to'], update: x['update'], files }
                : null;
        }
        default:
            return null;
    }
}

/** A repository-relative path as git has it: no leading `/`, no `.` or `..` segments, no empty segments. */
export function validPath(p: string): boolean {
    return p.length > 0 && p.length <= 4096 && !p.startsWith('/') && p.split('/').every(s => s !== '' && s !== '.' && s !== '..');
}
