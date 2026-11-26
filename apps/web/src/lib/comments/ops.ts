import type { Session } from '#lib/session.svelte.ts';

/** What the comment cards ask of the workbench beyond the session's state: things that go through the editor. */
export interface CommentOps {
    readonly session: Session;
    /** Makes a thread or suggestion current; `open` also opens the panel. Shows its anchor unless `fromText`. */
    focusItem(id: string, opts?: { open?: boolean; fromText?: boolean }): void;
    acceptReplacement(threadId: string, commentId: string): void;
    acceptSuggestion(id: string): void;
    rejectSuggestion(id: string): void;
    /** Starts a team thread on a suggestion's text with `body` as its first comment: suggestions are discussed as
     *  threads anchored where the suggestion is. */
    discussSuggestion(id: string, body: string): void;
    /** Starts a thread on the editor's selection. */
    newComment(): void;
}

/** The name a comment shows: the first name, or the whole name for a title like "Prof. Weber". */
export function displayName(name: string | undefined): string {
    if (!name) return 'Someone';
    const first = name.split(' ')[0] ?? name;
    return first.endsWith('.') ? name : first;
}
