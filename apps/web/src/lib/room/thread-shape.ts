import type { Comment, TextRange, Thread } from '#lib/model/types.ts';

/** How deep replies may nest in a thread from the room; deeper ones are someone else's malformed data. */
const MAX_DEPTH = 64;

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function optional(x: unknown, type: 'string' | 'boolean'): boolean {
    return x === undefined || typeof x === type;
}

function isRange(x: unknown): x is TextRange {
    if (!isRecord(x)) return false;
    return (['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'] as const).every(k => Number.isInteger(x[k]) && (x[k] as number) >= 1);
}

function isComment(x: unknown, depth: number): x is Comment {
    if (depth > MAX_DEPTH || !isRecord(x)) return false;
    return (
        typeof x['id'] === 'string' &&
        typeof x['author'] === 'string' &&
        typeof x['when'] === 'string' &&
        typeof x['resolved'] === 'boolean' &&
        typeof x['body'] === 'string' &&
        optional(x['replacement'], 'string') &&
        Array.isArray(x['replies']) &&
        x['replies'].every(r => isComment(r, depth + 1))
    );
}

/** The thread stored under `id` in the room's `threads` map, from its JSON, or null when it is not one: unparsable,
 *  not the shape of a `Thread` (every field's type, replies included, up to 64 levels deep), stored under another id, or
 *  a draft (drafts never leave the browser that writes them). The room is written by other people's browsers, so
 *  nothing in it is trusted to be what the editor expects. */
export function parseRoomThread(id: string, json: string): Thread | null {
    let x: unknown;
    try {
        x = JSON.parse(json);
    } catch {
        return null;
    }
    if (!isRecord(x)) return null;
    const ok =
        x['id'] === id &&
        (x['source'] === 'team' || x['source'] === 'github') &&
        optional(x['branch'], 'string') &&
        typeof x['file'] === 'string' &&
        typeof x['quote'] === 'string' &&
        (x['range'] === undefined || isRange(x['range'])) &&
        (x['draft'] === undefined || x['draft'] === false) &&
        isComment(x['root'], 0);
    return ok ? (x as unknown as Thread) : null;
}
