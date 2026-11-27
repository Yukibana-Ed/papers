import * as Y from 'yjs';
import { IdSet, type Authors, type BaseFile } from '@yukibana/papers-room-protocol';
import type { Run } from './model.ts';
import { RangeMap } from './ranges.ts';
import { yRuns } from './yruns.ts';

/** The review document's map of accepted suggestions: `client:clock` of the inserted text → JSON `{ len, by }`, `by`
 *  being who suggested it. Who accepted it is whoever wrote those characters. */
export const ACCEPTED = 'accepted';

/** What the commit review reads from the room: the text document's files with every character's id, each file's
 *  committed characters, who wrote and who deleted what, and which insertions were accepted suggestions.
 *
 *  `version` changes whenever any of that changes other than the texts themselves (the session sees those), so that a
 *  `$derived` reading it recomputes. My own writes and deletions are known at once, before the room confirms them:
 *  the room says the same later, and both name me. */
export class ReviewSource {
    version = $state(0);
    readonly files: Y.Map<Y.Text>;
    private readonly writers = new Map<number, string>();
    private readonly deleted = new RangeMap<string>();
    private suggested = new RangeMap<string>();
    private readonly base = new Map<string, IdSet | null>();
    private readonly stop: () => void;

    /** Precondition: `text` and `review` are the room's two documents (or the demo's), and `me` is the signed-in login. */
    constructor(
        readonly text: Y.Doc,
        readonly review: Y.Doc,
        readonly me: string,
    ) {
        this.files = text.getMap<Y.Text>('files');
        this.writers.set(text.clientID, me);
        const onTransaction = (tr: Y.Transaction): void => {
            if (!tr.local) return;
            let any = false;
            for (const [client, items] of tr.deleteSet.clients) {
                for (const d of items) {
                    for (const ids of this.base.values()) {
                        if (!ids) continue;
                        let clock = d.clock;
                        while (clock < d.clock + d.len) {
                            const r = ids.run(client, clock, d.clock + d.len - clock);
                            if (r.inSet) {
                                this.deleted.set(client, clock, r.len, me);
                                any = true;
                            }
                            clock += r.len;
                        }
                    }
                }
            }
            if (any) this.version++;
        };
        text.on('afterTransaction', onTransaction);
        const accepted = review.getMap<string>(ACCEPTED);
        const read = (): void => {
            const map = new RangeMap<string>();
            for (const [key, json] of accepted) {
                const m = /^(\d+):(\d+)$/.exec(key);
                if (!m) continue;
                try {
                    const v: unknown = JSON.parse(json);
                    const len = typeof v === 'object' && v !== null ? Reflect.get(v, 'len') : null;
                    const by = typeof v === 'object' && v !== null ? Reflect.get(v, 'by') : null;
                    if (typeof len === 'number' && Number.isInteger(len) && len > 0 && typeof by === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(by))
                        map.set(Number(m[1]), Number(m[2]), len, by);
                } catch {
                    // Someone else's word: an entry that is not one is left out.
                }
            }
            this.suggested = map;
            this.version++;
        };
        accepted.observe(read);
        read();
        this.stop = () => {
            text.off('afterTransaction', onTransaction);
            accepted.unobserve(read);
        };
    }

    /** Takes what the room says about who wrote and deleted what. */
    addAuthors(a: Authors): void {
        for (const [client, login] of a.writers) if (!this.writers.has(client)) this.writers.set(client, login);
        for (const [client, clock, len, login] of a.deleted) this.deleted.set(client, clock, len, login);
        this.version++;
    }

    /** Takes files' committed characters (an empty `items` with text: not known). */
    setBase(files: readonly Pick<BaseFile, 'path' | 'text' | 'items'>[]): void {
        for (const f of files) this.base.set(f.path, f.items === '' && f.text !== '' ? null : IdSet.decode(f.items));
        this.version++;
    }

    /** Sets `path`'s committed characters to `ids` (after a commit from here; null when not known). */
    setBaseIds(path: string, ids: IdSet | null): void {
        this.base.set(path, ids);
        this.version++;
    }

    /** `path`'s runs against `baseText`, its committed text, or null when the room has no ids for that state (then the
     *  caller compares texts). Reads `version`. */
    runs(path: string, baseText: string): Run[] | null {
        void this.version;
        const text = this.files.get(path);
        const ids = this.base.get(path);
        if (!text || !ids) return null;
        return yRuns(text, baseText, ids, {
            writer: c => this.writers.get(c) ?? null,
            deleter: (c, k, n) => this.deleted.at(c, k, n),
            suggester: (c, k, n) => this.suggested.at(c, k, n),
        });
    }

    /** Makes `path`'s session text `to`, as one change spanning where they differ (a revert, or its undo). Does
     *  nothing for a file the room does not have. */
    replace(path: string, to: string): void {
        const text = this.files.get(path);
        if (!text) return;
        const from = text.toJSON();
        let start = 0;
        while (start < from.length && start < to.length && from[start] === to[start]) start++;
        let end = 0;
        while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
        this.text.transact(() => {
            if (from.length - start - end > 0) text.delete(start, from.length - start - end);
            if (to.length - start - end > 0) text.insert(start, to.slice(start, to.length - end));
        });
    }

    /** Runs `accept` (which inserts a suggestion's text into the room's text as me) and records that what it inserted
     *  was suggested by `by`. */
    accepting(by: string, accept: () => void): void {
        const client = this.text.clientID;
        const before = Y.getState(this.text.store, client);
        accept();
        const after = Y.getState(this.text.store, client);
        if (after > before && by !== this.me) this.review.getMap<string>(ACCEPTED).set(`${client}:${before}`, JSON.stringify({ len: after - before, by }));
    }

    dispose(): void {
        this.stop();
    }
}
