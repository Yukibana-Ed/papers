import * as Y from 'yjs';

/** A branch's session as this browser last had it: what a project opens from when its room cannot be reached, and
 *  what is brought back to the room afterwards (`rejoin.ts`). Kept in IndexedDB, one record per branch. */
export interface LocalCopy {
    /** The text and review documents, each as one Yjs update. */
    readonly text: Uint8Array;
    readonly review: Uint8Array;
    /** The commit the session stood on, and every file's text there (path → text). */
    readonly base: string;
    readonly committed: Readonly<Record<string, string>>;
    /** Whether the documents may hold changes the room has not been sent. */
    readonly unsent: boolean;
    /** When it was saved, epoch ms. */
    readonly saved: number;
}

const DB = 'yukibana-papers';
const STORE = 'sessions';
/** How long after a change the copy is saved. */
export const SAVE_MS = 1000;

/** The record key of `branch` of `owner/repo`. */
export function localKey(owner: string, repo: string, branch: string): string {
    return `${owner}/${repo}#${branch}`;
}

function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.addEventListener('upgradeneeded', () => open.result.createObjectStore(STORE));
        open.addEventListener('success', () => resolve(open.result));
        open.addEventListener('error', () => reject(open.error ?? new Error('IndexedDB failed')));
        open.addEventListener('blocked', () => reject(new Error('IndexedDB is blocked')));
    });
}

async function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const r = run(tx.objectStore(STORE));
            tx.addEventListener('complete', () => resolve(r.result));
            tx.addEventListener('error', () => reject(tx.error ?? new Error('IndexedDB failed')));
            tx.addEventListener('abort', () => reject(tx.error ?? new Error('IndexedDB failed')));
        });
    } finally {
        db.close();
    }
}

function isCopy(x: unknown): x is LocalCopy {
    if (typeof x !== 'object' || x === null) return false;
    const r = x as Record<string, unknown>;
    return (
        r['text'] instanceof Uint8Array &&
        r['review'] instanceof Uint8Array &&
        typeof r['base'] === 'string' &&
        typeof r['committed'] === 'object' &&
        r['committed'] !== null &&
        Object.values(r['committed']).every(v => typeof v === 'string') &&
        typeof r['unsent'] === 'boolean' &&
        typeof r['saved'] === 'number'
    );
}

/** The copy kept under `key`, or null when there is none, it cannot be read, or this browser keeps nothing (private
 *  windows, storage switched off). Never throws. */
export async function readLocal(key: string): Promise<LocalCopy | null> {
    try {
        const found: unknown = await request('readonly', store => store.get(key));
        return isCopy(found) ? found : null;
    } catch {
        return null;
    }
}

/** Keeps `copy` under `key`, in place of what was there. Returns whether it was kept. Never throws. */
export async function writeLocal(key: string, copy: LocalCopy): Promise<boolean> {
    try {
        await request('readwrite', store => store.put(copy, key));
        return true;
    } catch {
        return false;
    }
}

/** Forgets every branch kept in this browser: what signing out does, since the copies hold repositories' contents.
 *  Never throws. */
export async function dropAllLocal(): Promise<void> {
    try {
        await request('readwrite', store => store.clear());
    } catch {
        // Nothing was kept, or nothing can be.
    }
}

/** Keeps the session that runs on `text` and `review` under `key`: saved `SAVE_MS` after a change to either, and
 *  when `save` is called (a change to what `state` gives is not seen otherwise). `state` gives the rest of the copy
 *  as it is at that moment. Returns `save`, which saves now, and `stop`, which saves a pending change and ends it.
 *  Precondition: `stop` is called before the documents are destroyed. */
export function keepLocal(
    key: string,
    text: Y.Doc,
    review: Y.Doc,
    state: () => Pick<LocalCopy, 'base' | 'committed' | 'unsent'>,
    now: () => number = Date.now,
): { save(): void; stop(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = (): void => {
        clearTimeout(timer);
        timer = undefined;
        void writeLocal(key, { text: Y.encodeStateAsUpdate(text), review: Y.encodeStateAsUpdate(review), ...state(), saved: now() });
    };
    const later = (): void => {
        timer ??= setTimeout(save, SAVE_MS);
    };
    text.on('update', later);
    review.on('update', later);
    return {
        save,
        stop() {
            text.off('update', later);
            review.off('update', later);
            if (timer !== undefined) save();
        },
    };
}
