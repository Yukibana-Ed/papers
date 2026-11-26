import type { editor as Editor, IDisposable, IPosition, IRange } from 'monaco-editor/editor/editor.api';
import type { Anchor, Cursor, Lines, PlacedSuggestion, Presence, Suggestion, TextRange, Thread, User } from '#lib/model/types.ts';
import type * as Y from 'yjs';
import { applyTheme, languageOf, modelUri, monaco, remeasureWhenFontsLoad } from './monaco.ts';
import { TextBinding } from './y-binding.ts';

type Model = Editor.ITextModel;
type Range = InstanceType<typeof monaco.Range>;

const NEVER = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
const GROW = monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;

/** What the editor tells the session. */
export interface SourceEditorEvents {
    change(file: string, text: string): void;
    cursor(c: Cursor): void;
    /** The selection, or null when it is empty. */
    selection(s: Lines | null): void;
    /** The cursor entered a thread's text (`fromText`), or its gutter mark was clicked (`open`). */
    openThread(id: string, opts: { open?: boolean; fromText?: boolean }): void;
    anchors(a: Readonly<Record<string, Anchor>>): void;
    suggestions(list: readonly PlacedSuggestion[]): void;
    /** Where the selection's comment button goes, in pixels from the editor's top; null hides it. */
    selectionButton(top: number | null): void;
}

export interface Diagnostic {
    readonly file: string;
    readonly line: number;
    readonly severity: 'error' | 'warning';
    readonly message: string;
}

interface SuggestionState {
    id: string;
    author: string;
    when: string;
    file: string;
    text: string;
}

interface FileDecorations {
    threads: string[];
    sugg: Record<string, string>;
    presence: string[];
    mirror: string[];
}

/** The source editor: one Monaco editor over a model per project file, with the decorations of comments,
 *  suggestions, others' cursors and the preview's selection, and suggestion mode.
 *
 *  Suggestion mode intercepts input before Monaco sees it (capture-phase keydown for the editing keys, `beforeinput`
 *  for typed text, `paste`): letting Monaco type and then reverting garbles its hidden textarea. What still reaches
 *  the model (cut, drag and drop) is put back as it was and recorded as a suggestion. */
export class SourceEditor {
    private readonly ed: Editor.IStandaloneCodeEditor;
    private readonly models = new Map<string, Model>();
    private readonly shadow = new Map<string, string>();
    private readonly deco = new Map<string, FileDecorations>();
    private readonly threadDeco = new Map<string, { file: string; id: string }>();
    private readonly sugg = new Map<string, SuggestionState>();
    private readonly bindings = new Map<string, TextBinding>();
    private readonly disposables: IDisposable[] = [];
    private readonly stopRemeasure: () => void;
    private presenceStyle: HTMLStyleElement | null = null;
    private internal = false;
    private settling = false;
    private lastKey = '';
    private threads: readonly Thread[] = [];
    private activeThread: string | null = null;
    private suggestMode = false;
    private readonly me: string;

    /** Creates the editor in `host`, with a model per file of `files`, showing `active`.
     *  Precondition: `active` is a key of `files`. */
    constructor(
        private readonly host: HTMLElement,
        files: Readonly<Record<string, string>>,
        active: string,
        me: string,
        private readonly on: SourceEditorEvents,
    ) {
        this.me = me;
        for (const [f, text] of Object.entries(files)) this.addModel(f, text);
        this.ed = monaco.editor.create(host, {
            model: this.models.get(active) ?? null,
            theme: 'yk',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontLigatures: false,
            fontSize: 14,
            lineHeight: 22,
            wordWrap: 'on',
            wrappingIndent: 'same',
            minimap: { enabled: false },
            glyphMargin: true,
            lineNumbersMinChars: 3,
            folding: false,
            renderLineHighlight: 'line',
            scrollBeyondLastLine: false,
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            unicodeHighlight: { ambiguousCharacters: false },
            quickSuggestions: false,
            contextmenu: true,
            guides: { indentation: false },
            stickyScroll: { enabled: false },
        });
        const e = this.ed;
        this.disposables.push(
            e.onDidChangeCursorPosition(ev => {
                const f = this.fileOf(e.getModel());
                if (f === null) return;
                this.on.cursor({ file: f, line: ev.position.lineNumber, col: ev.position.column });
                const hit = this.threadAt(f, ev.position);
                if (hit !== null) this.on.openThread(hit, { fromText: true });
            }),
            e.onDidChangeCursorSelection(ev => {
                const s = ev.selection;
                const f = this.fileOf(e.getModel());
                if (f === null) return;
                this.on.selection(s.isEmpty() ? null : { file: f, startLine: s.startLineNumber, endLine: s.endLineNumber });
                this.placeSelectionButton();
            }),
            e.onDidScrollChange(() => this.placeSelectionButton()),
            e.onKeyDown(k => {
                this.lastKey = k.code;
            }),
            e.onMouseDown(ev => {
                if (ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
                const f = this.fileOf(e.getModel());
                const line = ev.target.position?.lineNumber;
                if (f === null || line === undefined) return;
                const hit = this.threads.find(t => t.file === f && !t.root.resolved && this.anchorOf(t.id)?.startLineNumber === line);
                const s = [...this.sugg.values()].find(x => x.file === f && this.rangeOfSugg(x.id)?.startLineNumber === line);
                if (hit) this.on.openThread(hit.id, { open: true });
                else if (s) this.on.openThread(s.id, { open: true });
            }),
        );
        host.addEventListener('keydown', this.suggestKey, true);
        host.addEventListener('beforeinput', this.suggestInput, true);
        host.addEventListener('paste', this.suggestPaste, true);
        this.stopRemeasure = remeasureWhenFontsLoad();
    }

    dispose(): void {
        this.host.removeEventListener('keydown', this.suggestKey, true);
        this.host.removeEventListener('beforeinput', this.suggestInput, true);
        this.host.removeEventListener('paste', this.suggestPaste, true);
        this.stopRemeasure();
        for (const b of this.bindings.values()) b.dispose();
        for (const d of this.disposables) d.dispose();
        this.ed.dispose();
        for (const m of this.models.values()) m.dispose();
        this.presenceStyle?.remove();
    }

    private addModel(f: string, text: string): void {
        const m = monaco.editor.createModel(text, languageOf(f), modelUri(f));
        this.models.set(f, m);
        this.shadow.set(f, text);
        this.disposables.push(m.onDidChangeContent(e => this.onModelChange(f, m, e)));
    }

    /** Keeps `file` the same text as `text`, a file of the room, both ways; adds the file if it is new. */
    bind(file: string, text: Y.Text): void {
        if (!this.models.has(file)) this.addModel(file, text.toJSON());
        this.bindings.get(file)?.dispose();
        this.bindings.set(file, new TextBinding(this.model(file), text));
    }

    private fileOf(m: Model | null): string | null {
        if (!m) return null;
        for (const [f, x] of this.models) if (x === m) return f;
        return null;
    }

    private model(f: string): Model {
        const m = this.models.get(f);
        if (!m) throw new Error(`No model for ${f}`);
        return m;
    }

    private D(f: string): FileDecorations {
        let d = this.deco.get(f);
        if (!d) {
            d = { threads: [], sugg: {}, presence: [], mirror: [] };
            this.deco.set(f, d);
        }
        return d;
    }

    private placeSelectionButton(): void {
        const s = this.ed.getSelection();
        if (!s || s.isEmpty()) return this.on.selectionButton(null);
        const p = this.ed.getScrolledVisiblePosition(s.getStartPosition());
        this.on.selectionButton(p ? Math.max(4, p.top) : null);
    }

    // --- threads -------------------------------------------------------------------------------------------------------

    /** Shows `threads` (open ones marked in the text and the gutter) and marks `active`. New threads are anchored to
     *  their `range`, or to the first match of their `quote`; Monaco then tracks the anchor through edits. */
    setThreads(threads: readonly Thread[], active: string | null): void {
        this.threads = threads;
        this.activeThread = active;
        for (const t of threads) this.placeThread(t);
        for (const [f, m] of this.models) {
            const list = threads
                .filter(t => t.file === f && !t.root.resolved)
                .flatMap((t): Editor.IModelDeltaDecoration[] => {
                    const r = this.anchorOf(t.id);
                    if (!r) return [];
                    const gh = t.source === 'github';
                    const cls = `cm-anchor${gh ? ' cm-gh' : ''}${t.id === active ? ' cm-active' : ''}${t.draft ? ' cm-draft' : ''}`;
                    return [
                        { range: r, options: { inlineClassName: cls, stickiness: NEVER } },
                        {
                            range: new monaco.Range(r.startLineNumber, 1, r.startLineNumber, 1),
                            options: {
                                glyphMarginClassName: `glyph-comment${gh ? ' glyph-gh' : ''}`,
                                glyphMarginHoverMessage: { value: gh ? 'Review thread · open' : 'Comment · open' },
                            },
                        },
                    ];
                });
            this.D(f).threads = m.deltaDecorations(this.D(f).threads, list);
        }
        this.reportAnchors();
    }

    private placeThread(t: Thread): void {
        const m = this.models.get(t.file);
        if (!m || this.threadDeco.has(t.id)) return;
        const r = t.range ? new monaco.Range(t.range.startLineNumber, t.range.startColumn, t.range.endLineNumber, t.range.endColumn) : findRange(m, t.quote);
        if (!r) return;
        const [id] = m.deltaDecorations([], [{ range: r, options: { stickiness: NEVER } }]);
        if (id !== undefined) this.threadDeco.set(t.id, { file: t.file, id });
    }

    private anchorOf(threadId: string): Range | null {
        const d = this.threadDeco.get(threadId);
        return d ? (this.models.get(d.file)?.getDecorationRange(d.id) ?? null) : null;
    }

    private threadAt(f: string, pos: IPosition): string | null {
        return this.threads.find(t => t.file === f && !t.root.resolved && this.anchorOf(t.id)?.containsPosition(pos))?.id ?? null;
    }

    private reportAnchors(): void {
        const out: Record<string, Anchor> = {};
        for (const t of this.threads) {
            const r = this.anchorOf(t.id);
            if (r) out[t.id] = { startLine: r.startLineNumber, endLine: r.endLineNumber, startColumn: r.startColumn };
        }
        this.on.anchors(out);
    }

    // --- suggestions ---------------------------------------------------------------------------------------------------

    /** Adds suggestions from elsewhere (seed data, the room) at their quotes. Ones already shown are left alone. */
    addSuggestions(list: readonly Suggestion[], users: Readonly<Record<string, User>>): void {
        this.users = users;
        for (const s of list) {
            if (this.sugg.has(s.id)) continue;
            const m = this.models.get(s.file);
            const r = m && s.quote !== undefined ? findRange(m, s.quote) : null;
            if (!m || !r) continue;
            const st: SuggestionState = { id: s.id, author: s.author, when: s.when, file: s.file, text: s.text };
            this.sugg.set(s.id, st);
            const [id] = m.deltaDecorations([], [this.suggDeco(r, st)]);
            if (id !== undefined) this.D(s.file).sugg[s.id] = id;
        }
        this.reportSuggestions();
    }

    private users: Readonly<Record<string, User>> = {};

    private suggDeco(r: IRange, s: SuggestionState): Editor.IModelDeltaDecoration {
        const empty = r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn;
        const options: Editor.IModelDecorationOptions = {
            stickiness: NEVER,
            showIfCollapsed: true,
            hoverMessage: { value: `Suggestion by ${this.users[s.author]?.name ?? s.author}` },
            glyphMarginClassName: 'glyph-sugg',
            ...(empty ? {} : { inlineClassName: 'sg-del' }),
            ...(s.text ? { after: { content: s.text, inlineClassName: 'sg-ins', cursorStops: monaco.editor.InjectedTextCursorStops.None } } : {}),
        };
        return { range: r, options };
    }

    private rangeOfSugg(id: string): Range | null {
        const s = this.sugg.get(id);
        if (!s) return null;
        const d = this.D(s.file).sugg[id];
        return d === undefined ? null : (this.models.get(s.file)?.getDecorationRange(d) ?? null);
    }

    private redrawSugg(id: string, range?: IRange): void {
        const s = this.sugg.get(id);
        const r = range ?? this.rangeOfSugg(id);
        if (!s || !r) return;
        const m = this.model(s.file);
        const old = this.D(s.file).sugg[id];
        const [n] = m.deltaDecorations(old === undefined ? [] : [old], [this.suggDeco(r, s)]);
        if (n !== undefined) this.D(s.file).sugg[id] = n;
    }

    private dropSugg(id: string): void {
        const s = this.sugg.get(id);
        if (!s) return;
        const old = this.D(s.file).sugg[id];
        if (old !== undefined) this.model(s.file).deltaDecorations([old], []);
        delete this.D(s.file).sugg[id];
        this.sugg.delete(id);
    }

    private reportSuggestions(): void {
        const list: PlacedSuggestion[] = [];
        for (const s of this.sugg.values()) {
            const r = this.rangeOfSugg(s.id);
            if (!r) continue;
            list.push({ ...s, oldText: this.model(s.file).getValueInRange(r), line: r.startLineNumber, col: r.startColumn });
        }
        this.on.suggestions(list);
    }

    setSuggestMode(on: boolean): void {
        this.suggestMode = on;
    }

    private onModelChange(f: string, m: Model, e: Editor.IModelContentChangedEvent): void {
        const before = this.shadow.get(f) ?? '';
        this.shadow.set(f, m.getValue());
        const c = e.changes[0];
        if (this.bindings.get(f)?.remote) return this.finishChange(f, m);
        if (this.internal || !this.suggestMode || e.isUndoing || e.isRedoing || e.changes.length !== 1 || !c) return this.finishChange(f, m);
        // Suggesting: put the text back as it was and record the change as a suggestion instead.
        const removed = before.substr(c.rangeOffset, c.rangeLength);
        const start = m.getPositionAt(c.rangeOffset);
        const insEnd = m.getPositionAt(c.rangeOffset + c.text.length);
        this.internal = true;
        m.applyEdits([{ range: monaco.Range.fromPositions(start, insEnd), text: removed }]);
        this.internal = false;
        this.shadow.set(f, m.getValue());
        const delRange = monaco.Range.fromPositions(start, m.getPositionAt(c.rangeOffset + removed.length));
        this.recordSuggestion(f, m, delRange, removed, c.text, true);
    }

    private readonly suggestKey = (ev: KeyboardEvent): void => {
        if (!this.suggestMode || ev.isComposing) return;
        const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
        let text: string;
        if (plain && ev.key === 'Enter') text = '\n';
        else if (plain && ev.key === 'Tab') text = '  ';
        else if (ev.key === 'Backspace' || ev.key === 'Delete') text = '';
        else return;
        ev.preventDefault();
        ev.stopPropagation();
        this.lastKey = ev.code;
        this.suggestAtSelection(text, ev.key);
    };

    private readonly suggestInput = (ev: InputEvent): void => {
        if (!this.suggestMode) return;
        if (ev.inputType === 'insertText' || ev.inputType === 'insertReplacementText') {
            ev.preventDefault();
            if (ev.data) this.suggestAtSelection(ev.data);
        }
    };

    private readonly suggestPaste = (ev: ClipboardEvent): void => {
        if (!this.suggestMode) return;
        ev.preventDefault();
        ev.stopPropagation();
        const t = ev.clipboardData?.getData('text/plain');
        if (t) this.suggestAtSelection(t);
    };

    private suggestAtSelection(text: string, key?: string): void {
        const m = this.ed.getModel();
        const sel = this.ed.getSelection();
        const f = this.fileOf(m);
        if (!m || !sel || f === null) return;
        let r: Range = sel;
        if (r.isEmpty() && text === '') {
            const p = r.getStartPosition();
            const off = m.getOffsetAt(p);
            if (key === 'Backspace') {
                if (off === 0) return;
                r = monaco.Range.fromPositions(m.getPositionAt(off - 1), p);
            } else {
                if (off >= m.getValueLength()) return;
                r = monaco.Range.fromPositions(p, m.getPositionAt(off + 1));
            }
        }
        if (text) this.lastKey = '';
        this.recordSuggestion(f, m, monaco.Range.lift(r), m.getValueInRange(r), text, false);
    }

    /** Records an edit as a suggestion, continuing one of my own when the edit touches it: a word typed is one
     *  suggestion, not one per key. */
    private recordSuggestion(f: string, m: Model, delRange: Range, removed: string, insert: string, deferCursor: boolean): void {
        const mine = [...this.sugg.values()]
            .filter(x => x.file === f && x.author === this.me)
            .map(x => ({ x, r: this.rangeOfSugg(x.id) }))
            .filter((o): o is { x: SuggestionState; r: Range } => o.r !== null);
        const ds = delRange.getStartPosition();
        const de = delRange.getEndPosition();
        const isDel = removed !== '' && insert === '';
        const typing = removed === '' && insert !== '';
        const pick =
            (typing && mine.find(o => ds.equals(o.r.getEndPosition()))) ||
            (typing && mine.find(o => !o.x.text && !o.r.isEmpty() && ds.equals(o.r.getStartPosition()))) ||
            (isDel && mine.find(o => o.x.text && de.equals(o.r.getEndPosition()))) ||
            (isDel && mine.find(o => !o.x.text && de.equals(o.r.getStartPosition()))) ||
            (isDel && mine.find(o => ds.equals(o.r.getEndPosition()))) ||
            null;
        let id: string;
        let trimmed = false;
        if (pick && typing) {
            pick.x.text += insert; // typing on, or typing over what was just struck
            id = pick.x.id;
            this.redrawSugg(id);
        } else if (pick && isDel && de.equals(pick.r.getEndPosition()) && pick.x.text) {
            pick.x.text = pick.x.text.slice(0, Math.max(0, pick.x.text.length - removed.length)); // backspace through the suggested text
            id = pick.x.id;
            trimmed = true;
            if (!pick.x.text && pick.r.isEmpty()) {
                this.dropSugg(id);
                this.reportSuggestions();
                return;
            }
            this.redrawSugg(id);
        } else if (pick && isDel && de.equals(pick.r.getStartPosition()) && !pick.x.text) {
            id = pick.x.id; // backspace before a deletion: strike one more
            this.redrawSugg(id, monaco.Range.fromPositions(ds, pick.r.getEndPosition()));
        } else if (pick && isDel && ds.equals(pick.r.getEndPosition())) {
            id = pick.x.id; // forward delete after a deletion
            this.redrawSugg(id, monaco.Range.fromPositions(pick.r.getStartPosition(), de));
        } else {
            id = `s${Math.random().toString(36).slice(2, 9)}`;
            const st: SuggestionState = { id, author: this.me, when: 'now', file: f, text: insert };
            this.sugg.set(id, st);
            const [d] = m.deltaDecorations([], [this.suggDeco(delRange, st)]);
            if (d !== undefined) this.D(f).sugg[id] = d;
        }
        const r = this.rangeOfSugg(id);
        if (!r) return;
        // Typing, or backspacing through suggested text, leaves the cursor after the suggestion. Backspace over the
        // document's own text leaves it before what is struck; Delete leaves it after, so the next Delete strikes on.
        const pos = isDel && !trimmed && this.lastKey !== 'Delete' ? ds : r.getEndPosition();
        if (deferCursor) {
            // After Monaco has placed the cursor for the edit it thinks happened.
            this.settling = true;
            setTimeout(() => {
                this.ed.setPosition(pos, 'api');
                this.settling = false;
            }, 0);
        } else this.ed.setPosition(pos, 'api');
        this.reportSuggestions();
    }

    /** Whether a cursor move is still settling after a suggestion; for callers that react to cursor moves. */
    get isSettling(): boolean {
        return this.settling;
    }

    private finishChange(f: string, m: Model): void {
        this.on.change(f, m.getValue());
        this.reportAnchors();
        this.reportSuggestions();
    }

    acceptSuggestion(id: string): void {
        const s = this.sugg.get(id);
        const r = this.rangeOfSugg(id);
        if (!s || !r) return;
        const m = this.model(s.file);
        this.dropSugg(id);
        this.applyInternal(s.file, m, r, s.text);
    }

    rejectSuggestion(id: string): void {
        this.dropSugg(id);
        this.reportSuggestions();
    }

    /** Replaces a thread's anchored text with `text`, as an ordinary edit (a replacement offered in a comment). */
    replaceAnchor(threadId: string, text: string): void {
        const t = this.threads.find(x => x.id === threadId);
        const r = this.anchorOf(threadId);
        if (!t || !r) return;
        this.applyInternal(t.file, this.model(t.file), r, text);
    }

    /** Merges a change made outside the session (a push to the branch) into the file, and lights up its line for a
     *  moment. Returns the line, or null when `find` is not in the file. */
    applyExternal(file: string, find: string, replace: string): number | null {
        const m = this.models.get(file);
        const r = m ? findRange(m, find) : null;
        if (!m || !r) return null;
        this.applyInternal(file, m, r, replace);
        const [id] = m.deltaDecorations([], [{ range: new monaco.Range(r.startLineNumber, 1, r.startLineNumber, 1), options: { isWholeLine: true, className: 'incoming-line' } }]);
        if (id !== undefined) setTimeout(() => m.deltaDecorations([id], []), 2400);
        return r.startLineNumber;
    }

    private applyInternal(file: string, m: Model, r: IRange, text: string): void {
        this.internal = true;
        m.pushEditOperations([], [{ range: r, text }], () => null);
        this.internal = false;
        this.finishChange(file, m);
    }

    // --- presence, mirror, diagnostics, theme ---------------------------------------------------------------------------

    /** Others' cursors: a caret at the end of their line, with their name. */
    setPresence(list: readonly Presence[], users: Readonly<Record<string, User>>): void {
        this.users = users;
        if (!this.presenceStyle) {
            this.presenceStyle = document.createElement('style');
            document.head.append(this.presenceStyle);
        }
        // One rule per user: their colour and name. Names come from GitHub; CSS.escape keeps them inert.
        this.presenceStyle.textContent = list
            .map(p => {
                const u = users[p.user];
                const name = (u?.name.split(' ')[0] ?? p.user).replace(/["\\\n]/g, '');
                return `.presence-${CSS.escape(p.user)}{--pc:oklch(55% 0.15 ${u?.hue ?? 0})}.presence-${CSS.escape(p.user)}::after{content:"${name}"}`;
            })
            .join('\n');
        for (const [f, m] of this.models) {
            const decos = list
                .filter(p => p.file === f && p.line <= m.getLineCount())
                .map(p => {
                    const col = m.getLineMaxColumn(p.line);
                    return {
                        range: new monaco.Range(p.line, col, p.line, col),
                        options: { beforeContentClassName: `presence-caret presence-${p.user}`, hoverMessage: { value: users[p.user]?.name ?? p.user }, stickiness: GROW },
                    };
                });
            this.D(f).presence = m.deltaDecorations(this.D(f).presence, decos);
        }
    }

    /** The lines the preview's selection came from, highlighted; null clears them. */
    setMirror(lines: Lines | null): void {
        for (const [f, m] of this.models) {
            const list =
                lines && lines.file === f ? [{ range: new monaco.Range(lines.startLine, 1, lines.endLine, 1), options: { isWholeLine: true, className: 'mirror-line' } }] : [];
            this.D(f).mirror = m.deltaDecorations(this.D(f).mirror, list);
        }
    }

    setDiagnostics(list: readonly Diagnostic[]): void {
        for (const [f, m] of this.models) {
            const markers = list
                .filter(d => d.file === f && d.line >= 1 && d.line <= m.getLineCount())
                .map(d => ({
                    severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                    message: d.message,
                    startLineNumber: d.line,
                    endLineNumber: d.line,
                    startColumn: m.getLineFirstNonWhitespaceColumn(d.line) || 1,
                    endColumn: m.getLineMaxColumn(d.line),
                }));
            monaco.editor.setModelMarkers(m, 'tex', markers);
        }
    }

    setTheme(dark: boolean): void {
        applyTheme(dark);
    }

    // --- navigation ------------------------------------------------------------------------------------------------------

    show(file: string): void {
        const m = this.models.get(file);
        if (m && this.ed.getModel() !== m) {
            this.ed.setModel(m);
            this.placeSelectionButton();
        }
    }

    /** Shows `file` at (`line`, `col`), scrolling only if it is off-screen, and selects `select` if given. */
    reveal(file: string, line: number, col = 1, opts: { focus?: boolean; select?: TextRange } = {}): void {
        this.show(file);
        if (opts.select) this.ed.setSelection(opts.select);
        else this.ed.setPosition({ lineNumber: line, column: col });
        this.ed.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
        if (opts.focus !== false) this.ed.focus();
    }

    /** Shows a thread's or a suggestion's anchor without taking the focus. */
    revealItem(id: string): void {
        const t = this.threads.find(x => x.id === id);
        const r = this.anchorOf(id);
        if (t && r) return this.reveal(t.file, r.startLineNumber, r.startColumn, { focus: false });
        const sr = this.rangeOfSugg(id);
        const s = this.sugg.get(id);
        if (sr && s) this.reveal(s.file, sr.startLineNumber, sr.startColumn, { focus: false });
    }

    /** The selection with its text, or null when it is empty. */
    selection(): { file: string; range: TextRange; quote: string } | null {
        const s = this.ed.getSelection();
        const m = this.ed.getModel();
        const f = this.fileOf(m);
        if (!s || s.isEmpty() || !m || f === null) return null;
        return {
            file: f,
            range: { startLineNumber: s.startLineNumber, startColumn: s.startColumn, endLineNumber: s.endLineNumber, endColumn: s.endColumn },
            quote: m.getValueInRange(s),
        };
    }

    /** Selects whole lines (a selection made in the preview), so a comment can be made on them. */
    selectLines(lines: Lines): void {
        const m = this.models.get(lines.file);
        if (!m) return;
        const end = Math.min(lines.endLine, m.getLineCount());
        this.reveal(lines.file, lines.startLine, 1, {
            select: {
                startLineNumber: lines.startLine,
                startColumn: m.getLineFirstNonWhitespaceColumn(lines.startLine) || 1,
                endLineNumber: end,
                endColumn: m.getLineMaxColumn(end),
            },
        });
    }

    lineText(file: string, line: number): string | null {
        const m = this.models.get(file);
        return m && line >= 1 && line <= m.getLineCount() ? m.getLineContent(line) : null;
    }

    focus(): void {
        this.ed.focus();
    }

    get currentThread(): string | null {
        return this.activeThread;
    }
}

/** The first match of `quote` in `m`, or null. */
function findRange(m: Model, quote: string): Range | null {
    return m.findMatches(quote, false, false, true, null, false)[0]?.range ?? null;
}
