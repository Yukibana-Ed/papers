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
    /** Stops `server` (its worker ends); a later `lsp-start` starts a fresh one. */
    | { readonly type: 'lsp-stop'; readonly server: LanguageServer }
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
    /** The pointer is over the typeset text of these source lines in the preview, or (null) over none. */
    | { readonly type: 'hover'; readonly lines: SourceLines | null }
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

/** Whether `x` is the app's hello (any version: the frame answers only its own). */
export function isHello(x: unknown): x is Hello {
    return isRecord(x) && x['kind'] === HELLO && typeof x['version'] === 'number';
}

/** Whether `x` is the frame's welcome, which carries the port. */
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

/** Whether `x` is the frame saying it is ready to be greeted. */
export function isReady(x: unknown): x is Ready {
    return isRecord(x) && x['kind'] === READY && typeof x['version'] === 'number';
}

// --- validation ---------------------------------------------------------------------------------------------------------
// Each side checks every field of what it receives: the frame runs user content, so the app treats its messages as
// untrusted; the frame checks the app's messages against version skew. A message that is not exactly one of the shapes
// above is dropped, never half-used.

const isString = (x: unknown): x is string => typeof x === 'string';
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isLine = (x: unknown): x is number => isNumber(x) && Number.isInteger(x) && x >= 0;
const isBytes = (x: unknown): x is Uint8Array => x instanceof Uint8Array;
const isContents = (x: unknown): x is FileContents => isString(x) || isBytes(x);

/** Whether `x` is one of `values`. */
function oneOf(x: unknown, ...values: readonly string[]): boolean {
    return isString(x) && values.includes(x);
}

/** Whether `x` is an array whose every item passes `item`. */
function arrayOf(x: unknown, item: (y: unknown) => boolean): boolean {
    return Array.isArray(x) && x.every(item);
}

function isPoint(x: unknown): x is SourcePoint {
    return isRecord(x) && isString(x['file']) && isLine(x['line']) && (x['column'] === undefined || isLine(x['column']));
}
function isLines(x: unknown): x is SourceLines {
    return isRecord(x) && isString(x['file']) && isLine(x['startLine']) && isLine(x['endLine']) && x['startLine'] <= x['endLine'];
}
function isDiagnostic(x: unknown): boolean {
    return (
        isRecord(x) &&
        isString(x['file']) &&
        isLine(x['line']) &&
        oneOf(x['severity'], 'error', 'warning', 'info') &&
        isString(x['message']) &&
        (x['endLine'] === undefined || isLine(x['endLine'])) &&
        (x['excerpt'] === undefined || isString(x['excerpt']))
    );
}
function isServiceFailure(x: unknown): boolean {
    return isRecord(x) && oneOf(x['what'], 'tex-engine', 'typst-compiler', 'texlive') && isString(x['detail']);
}
function isMark(x: unknown): boolean {
    return isLines(x) && isString(Reflect.get(x, 'id')) && oneOf(Reflect.get(x, 'kind'), 'comment', 'active', 'suggestion');
}
function isPresence(x: unknown): boolean {
    return isPoint(x) && isString(Reflect.get(x, 'user')) && isString(Reflect.get(x, 'initial')) && isNumber(Reflect.get(x, 'hue'));
}
function isPackage(x: unknown): boolean {
    return isRecord(x) && isString(x['namespace']) && isString(x['name']) && isString(x['version']) && isString(x['sha256']);
}
function isChange(x: unknown): boolean {
    return isRecord(x) && isString(x['path']) && (x['contents'] === null || isContents(x['contents']));
}

/** Whether the fields of `x` (whose `type` is a string) match the app message of that type. */
function appFieldsMatch(x: Record<string, unknown>): boolean {
    switch (x['type']) {
        case 'project':
            return isRecord(x['files']) && Object.values(x['files']).every(isContents) && isString(x['root']) && oneOf(x['engine'], 'pdflatex', 'xelatex', 'lualatex', 'typst');
        case 'files':
            return arrayOf(x['changes'], isChange);
        case 'root':
            return isString(x['root']) && oneOf(x['engine'], 'pdflatex', 'xelatex', 'lualatex', 'typst');
        case 'reveal':
            return isPoint(x['at']) && oneOf(x['mode'], 'follow', 'jump');
        case 'mirror':
            return x['lines'] === null || isLines(x['lines']);
        case 'marks':
            return arrayOf(x['marks'], isMark);
        case 'presence':
            return arrayOf(x['presence'], isPresence);
        case 'zoom':
            return isNumber(x['zoom']);
        case 'centre?':
            return true;
        case 'theme':
            return isBool(x['dark']);
        case 'builder':
            return oneOf(x['builder'], 'browser', 'external');
        case 'output':
            return (
                isBool(x['ok']) &&
                (x['pdf'] === null || isBytes(x['pdf'])) &&
                (x['synctex'] === null || isBytes(x['synctex'])) &&
                isNumber(x['ms']) &&
                arrayOf(x['diagnostics'], isDiagnostic)
            );
        case 'lsp-start':
        case 'lsp-stop':
            return oneOf(x['server'], 'tinymist');
        case 'lsp':
            return oneOf(x['server'], 'tinymist') && 'message' in x;
        case 'retry':
            return true;
        default:
            return false;
    }
}

/** Whether the fields of `x` (whose `type` is a string) match the frame message of that type. */
function frameFieldsMatch(x: Record<string, unknown>): boolean {
    switch (x['type']) {
        case 'built':
            return (
                isBool(x['ok']) &&
                isLine(x['pages']) &&
                isNumber(x['ms']) &&
                arrayOf(x['diagnostics'], isDiagnostic) &&
                (x['packages'] === undefined || arrayOf(x['packages'], isPackage)) &&
                (x['log'] === undefined || isString(x['log']))
            );
        case 'service':
            return x['failure'] === null || isServiceFailure(x['failure']);
        case 'status':
            return oneOf(x['status'], 'loading', 'compiling', 'idle');
        case 'jump':
            return isPoint(x['at']) && (x['word'] === null || isString(x['word']));
        case 'selection':
            return (x['lines'] === null || isLines(x['lines'])) && isString(x['text']);
        case 'hover':
            return x['lines'] === null || isLines(x['lines']);
        case 'action':
            return oneOf(x['action'], 'comment', 'suggest', 'source') && isLines(x['lines']) && isString(x['text']);
        case 'centre':
            return x['at'] === null || isPoint(x['at']);
        case 'scale':
            return isNumber(x['scale']) && x['scale'] > 0;
        case 'key':
            return isString(x['key']) && isString(x['code']) && isBool(x['ctrl']) && isBool(x['shift']) && isBool(x['alt']);
        case 'lsp':
            return oneOf(x['server'], 'tinymist') && 'message' in x;
        case 'lsp-status':
            return oneOf(x['server'], 'tinymist') && oneOf(x['status'], 'starting', 'ready', 'failed') && (x['detail'] === undefined || isString(x['detail']));
        default:
            return false;
    }
}

/** Whether `x` is exactly one of `AppMessage`'s shapes: every field is checked, not only `type`. */
export function isAppMessage(x: unknown): x is AppMessage {
    return isRecord(x) && isString(x['type']) && appFieldsMatch(x);
}

/** Whether `x` is exactly one of `FrameMessage`'s shapes: every field is checked, not only `type`. The frame runs user
 *  content, so a message that is not exactly right is dropped; and the app still uses the fields only as data (a path
 *  is only ever looked up, never used to build a URL or HTML). */
export function isFrameMessage(x: unknown): x is FrameMessage {
    return isRecord(x) && isString(x['type']) && frameFieldsMatch(x);
}
