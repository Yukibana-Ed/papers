/** The shapes of a project session: what the room and GitHub give the editor. */

export interface User {
    readonly id: string;
    readonly name: string;
    readonly initials: string;
    /** The hue of the user's avatar, 0 to 360. */
    readonly hue: number;
    /** Their picture's URL, when they have one: shown in place of the initials. */
    readonly picture?: string;
}

/** A 1-based range in a file, as Monaco counts. */
export interface TextRange {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
}

/** One comment and the replies under it. Every comment with replies is a level with its own resolved state. */
export interface Comment {
    readonly id: string;
    readonly author: string;
    readonly when: string;
    readonly resolved: boolean;
    /** Markdown: the schema of `comments/schema.ts`, never raw HTML. */
    readonly body: string;
    /** A replacement for the thread's quote, offered in the comment. */
    readonly replacement?: string;
    readonly replies: readonly Comment[];
}

/** Where a thread lives: `team` threads are the room's; `github` threads are a pull request's review threads, flat. */
export type ThreadSource = 'team' | 'github';

export interface Thread {
    readonly id: string;
    readonly source: ThreadSource;
    /** For a GitHub thread: the branch whose pull request it belongs to. */
    readonly branch?: string;
    readonly file: string;
    /** The text the thread is anchored to, as it was when the thread was made. */
    readonly quote: string;
    /** The anchor, when known; otherwise the quote is found in the file. */
    readonly range?: TextRange;
    /** A thread being written: not yet posted. */
    readonly draft?: boolean;
    readonly root: Comment;
}

/** A suggested edit: replace the anchored text with `text`. */
export interface Suggestion {
    readonly id: string;
    readonly author: string;
    readonly when: string;
    readonly file: string;
    /** The text to find in the file for the anchor (seed data only). */
    readonly quote?: string;
    readonly text: string;
}

/** A suggestion where it currently is in its file. */
export interface PlacedSuggestion extends Suggestion {
    readonly oldText: string;
    readonly line: number;
    readonly col: number;
}

export interface PullRequest {
    readonly number: number;
    readonly title: string;
    readonly checks: 'passing' | 'failing' | 'pending';
}

export interface Branch {
    readonly name: string;
    /** Who is in the branch's session now. */
    readonly users: readonly string[];
    readonly pr: PullRequest | null;
}

export interface Commit {
    readonly hash: string;
    readonly author: string;
    readonly when: string;
    readonly msg: string;
}

/** Someone's cursor in one window: another person's, or the user's own in another window. */
export interface Presence {
    readonly user: string;
    readonly file: string;
    readonly line: number;
    /** The cursor's column, 1-based; where it is not known the cursor is shown at the end of its line. */
    readonly column?: number;
    /** What they have selected in `file`, if anything. */
    readonly selection?: TextRange;
}

/** A thread's anchor where it currently is. */
export interface Anchor {
    readonly startLine: number;
    readonly endLine: number;
    readonly startColumn: number;
    /** Exclusive, on `endLine`, 1-based. */
    readonly endColumn: number;
}

export interface Cursor {
    readonly file: string;
    readonly line: number;
    readonly col: number;
}

export interface Lines {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    /** With `endColumn`: the range runs from this column on `startLine` to before `endColumn` on `endLine` (1-based);
     *  without them it is whole lines. */
    readonly startColumn?: number;
    readonly endColumn?: number;
}
