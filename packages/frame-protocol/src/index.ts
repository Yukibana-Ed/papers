/** The messages between the app (papers.yukibana.dev) and the content frame it embeds (user-content-papers.yukibana.run).
 *
 *  The app holds the user's token and the project; the frame compiles, checks and renders user content and never sees
 *  a token. They talk over one MessagePort that the frame hands the app after the app's `hello`, so after the handshake
 *  no message travels through `window.postMessage` and no other window can inject one.
 *
 *  Positions are 1-based lines and columns of a project file, as in the editor. Paths are project-relative with `/`. */

/** A project file's contents: text for sources, bytes for everything else (images, fonts). */
export type FileContents = string | Uint8Array;

/** The engines the frame can run. */
export type Engine = 'pdflatex' | 'xelatex' | 'lualatex' | 'typst';

/** A source position. */
export interface SourcePoint {
    readonly file: string;
    readonly line: number;
    readonly column?: number;
}

/** A range of whole source lines, `startLine <= endLine`. */
export interface SourceLines {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
}

/** A comment's anchor as the preview should mark it. */
export interface PreviewMark extends SourceLines {
    readonly id: string;
    /** `active` is the comment the user is on; at most one mark is. */
    readonly kind: 'comment' | 'active' | 'suggestion';
}

/** Someone else's cursor, for the dot in the page margin. */
export interface PreviewPresence extends SourcePoint {
    readonly user: string;
    readonly initial: string;
    /** The user's hue, 0 to 360, as the app draws their avatar. */
    readonly hue: number;
}

/** A problem a build or a language server found in the document. */
export interface Diagnostic {
    readonly file: string;
    readonly line: number;
    /** `info`: notes a build makes that change nothing (an overfull box); hidden unless asked for. */
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
    /** The last line the problem spans, when the reporter knows it (an overfull box in a paragraph). */
    readonly endLine?: number;
    /** For a TeX error: the log's lines after the message (the `l.<n>` context showing where TeX stopped). */
    readonly excerpt?: string;
}

/** A part of the build service the frame could not start: the TeX engine, the Typst compiler, or the TeX Live store.
 *  Not a problem with the document. */
export interface ServiceFailure {
    readonly what: 'tex-engine' | 'typst-compiler' | 'texlive';
    /** What failed, for people: the file and HTTP status when a download failed. */
    readonly detail: string;
}

/** What the app sends the frame. */
export type AppMessage =
    /** The whole project, once, and again when the user switches branch: replaces every file the frame holds. */
    | { readonly type: 'project'; readonly files: Readonly<Record<string, FileContents>>; readonly root: string; readonly engine: Engine }
    /** Files changed, added (`contents` set) or removed (`contents` null) since the last message. */
    | { readonly type: 'files'; readonly changes: readonly { readonly path: string; readonly contents: FileContents | null }[] }
    /** Which file compiles: the frame builds it now and after every later change. */
    | { readonly type: 'root'; readonly root: string; readonly engine: Engine }
    /** Show this source position. `follow`: move only if it is off-screen (the cursor moved); `jump`: always, and flash. */
    | { readonly type: 'reveal'; readonly at: SourcePoint; readonly mode: 'follow' | 'jump' }
    /** The source selection, mirrored in the preview; null clears it. */
    | { readonly type: 'mirror'; readonly lines: SourceLines | null }
    | { readonly type: 'marks'; readonly marks: readonly PreviewMark[] }
    | { readonly type: 'presence'; readonly presence: readonly PreviewPresence[] }
    /** The zoom on top of fitting the pane's width, 0.5 to 2. */
    | { readonly type: 'zoom'; readonly zoom: number }
    /** Asks for a `centre` reply: the source line in the middle of the view. */
    | { readonly type: 'centre?' }
    | { readonly type: 'theme'; readonly dark: boolean }
    /** Who builds: `browser` (the frame's own engine, the default) or `external` (the user's computer, through the app):
     *  then the frame keeps the files only for display and shows the `output`s it is sent. */
    | { readonly type: 'builder'; readonly builder: 'browser' | 'external' }
    /** A build made elsewhere: the PDF, its SyncTeX (gzip as the engine writes it, or plain), and its diagnostics. The
     *  frame renders it as one of its own builds; `ok` false keeps the last good pages. */
    | {
          readonly type: 'output';
          readonly ok: boolean;
          readonly pdf: Uint8Array | null;
          readonly synctex: Uint8Array | null;
          readonly ms: number;
          readonly diagnostics: readonly Diagnostic[];
      }
    /** Starts `server` in the frame (once; later starts are ignored). Its messages then flow as `lsp`. */
    | { readonly type: 'lsp-start'; readonly server: LanguageServer }
    /** A JSON-RPC message for `server`: a request, a notification, or the response to one of the server's requests. */
    | { readonly type: 'lsp'; readonly server: LanguageServer; readonly message: unknown }
    /** Try again after a `service` failure: the frame starts the failed part afresh and builds. */
    | { readonly type: 'retry' };

/** The language servers the frame can run. They read user content, so they run on the content origin; the editor, on
 *  the app's, talks to them through the frame. */
export type LanguageServer = 'tinymist';

/** The actions of the preview's selection toolbar. */
export type SelectionAction = 'comment' | 'suggest' | 'source';

/** What the frame sends the app. */
export type FrameMessage =
    /** A build finished. `ok` false keeps the last good pages on screen. */
    | {
          readonly type: 'built';
          readonly ok: boolean;
          readonly pages: number;
          readonly ms: number;
          readonly diagnostics: readonly Diagnostic[];
          /** The engine's log (TeX's, the last 256 KB), for "Show log". */
          readonly log?: string;
          /** A Typst build's Typst Universe packages so far, each with its archive's SHA-256, for papers.lock. */
          readonly packages?: readonly { readonly namespace: string; readonly name: string; readonly version: string; readonly sha256: string }[];
      }
    /** The engine is loading or running, for the status in the preview's bar. */
    | { readonly type: 'status'; readonly status: 'loading' | 'compiling' | 'idle' }
    /** A part of the build service could not start (`failure`), or works again (`failure` null). While it fails there
     *  are no builds and no `built` messages. */
    | { readonly type: 'service'; readonly failure: ServiceFailure | null }
    /** The user clicked a spot in the preview: go to its source. `word` is the word under the pointer, if any. */
    | { readonly type: 'jump'; readonly at: SourcePoint; readonly word: string | null }
    /** The user selected text in the preview, or chose an action of the selection's toolbar. */
    | { readonly type: 'selection'; readonly lines: SourceLines | null; readonly text: string }
    | { readonly type: 'action'; readonly action: SelectionAction; readonly lines: SourceLines; readonly text: string }
    | { readonly type: 'centre'; readonly at: SourcePoint | null }
    /** The effective scale of the pages (fit times zoom), for the zoom readout. */
    | { readonly type: 'scale'; readonly scale: number }
    /** The frame wants the app's keyboard shortcut handled (the frame has focus, so the app does not see the key). */
    | { readonly type: 'key'; readonly key: string; readonly code: string; readonly ctrl: boolean; readonly shift: boolean; readonly alt: boolean }
    /** A JSON-RPC message from `server`: a response, a notification, or a request of its own for the editor. */
    | { readonly type: 'lsp'; readonly server: LanguageServer; readonly message: unknown }
    | { readonly type: 'lsp-status'; readonly server: LanguageServer; readonly status: 'starting' | 'ready' | 'failed'; readonly detail?: string };

/** The handshake, over `window.postMessage`: the app sends `hello` to the frame's origin; the frame answers `welcome`
 *  to the app's origin with the port that carries every later message. */
export const HELLO = 'yukibana-papers/hello' as const;
export const WELCOME = 'yukibana-papers/welcome' as const;
export const PROTOCOL_VERSION = 1;

export interface Hello {
    readonly kind: typeof HELLO;
    readonly version: number;
}
export interface Welcome {
    readonly kind: typeof WELCOME;
    readonly version: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
}

export function isHello(x: unknown): x is Hello {
    return isRecord(x) && x['kind'] === HELLO && typeof x['version'] === 'number';
}

export function isWelcome(x: unknown): x is Welcome {
    return isRecord(x) && x['kind'] === WELCOME && typeof x['version'] === 'number';
}

/** Posted by the frame to the app's origin once its scripts run: a `hello` sent before then (on the iframe's `load`,
 *  which can fire before the frame's code starts) may be lost, so the app answers `ready` with a `hello` too. The frame
 *  also keeps any `hello` that arrived before its code started, so either side may go first. */
export const READY = 'yukibana-papers/ready' as const;

export interface Ready {
    readonly kind: typeof READY;
    readonly version: number;
}

export function isReady(x: unknown): x is Ready {
    return isRecord(x) && x['kind'] === READY && typeof x['version'] === 'number';
}

const APP_TYPES: ReadonlySet<string> = new Set([
    'project',
    'files',
    'root',
    'reveal',
    'mirror',
    'marks',
    'presence',
    'zoom',
    'centre?',
    'theme',
    'builder',
    'output',
    'lsp-start',
    'lsp',
    'retry',
]);
const FRAME_TYPES: ReadonlySet<string> = new Set(['built', 'status', 'jump', 'selection', 'action', 'centre', 'scale', 'key', 'lsp', 'lsp-status', 'service']);

/** Whether `x` is shaped as an app message: an object with a known `type`. The port is private to the two sides, so this
 *  guards against version skew, not against an attacker. */
export function isAppMessage(x: unknown): x is AppMessage {
    return isRecord(x) && typeof x['type'] === 'string' && APP_TYPES.has(x['type']);
}

/** Whether `x` is shaped as a frame message. The frame runs user content, so the app must still treat every field as
 *  untrusted: a path is only ever looked up, never used to build a URL or HTML. */
export function isFrameMessage(x: unknown): x is FrameMessage {
    return isRecord(x) && typeof x['type'] === 'string' && FRAME_TYPES.has(x['type']);
}
