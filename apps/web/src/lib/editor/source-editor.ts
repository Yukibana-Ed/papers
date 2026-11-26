import type { editor as Editor, IDisposable, IPosition } from 'monaco-editor/editor/editor.api';
import type { Anchor, Cursor, Lines, PlacedSuggestion, Presence, Suggestion, TextRange, Thread, User } from '#lib/model/types.ts';
import type * as Y from 'yjs';
import { applyTheme, followPageTheme, languageOf, modelUri, monaco, remeasureWhenFontsLoad } from './monaco.ts';
import { FileSuggestions } from './suggestions.ts';
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
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
}

interface FileDecorations {
    threads: string[];
    presence: string[];
    mirror: string[];
}

/** The source editor: one Monaco editor over a model per project file, with the decorations of comments,
 *  suggestions, others' cursors and the preview's selection, and suggestion mode.
 *
 *  Suggestions are text in the models (see `FileSuggestions`): a model shows its file with every suggestion, suggested
 *  text marked, struck text kept and struck through; the session and the room get the file's committed text. While
 *  suggesting, Monaco applies every edit as usual and each change is then turned into suggestions; undo and redo step
 *  through them. No control character but tab and line feed gets into a model, and every model's line breaks are LF. */
export class SourceEditor {
    private readonly ed: Editor.IStandaloneCodeEditor;
    private readonly models = new Map<string, Model>();
    private readonly deco = new Map<string, FileDecorations>();
    private readonly threadDeco = new Map<string, { file: string; id: string }>();
    private readonly suggs = new Map<string, FileSuggestions>();
    private readonly bindings = new Map<string, TextBinding>();
    private readonly disposables: IDisposable[] = [];
    private readonly stopRemeasure: () => void;
    private readonly stopTheme: () => void;
    private presenceStyle: HTMLStyleElement | null = null;
    private internal = false;
    private readonly suggesting: Editor.IContextKey<boolean>;
    private threads: readonly Thread[] = [];
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
            // Hover, completion and parameter hints float over the page, not inside the editor's box, so they are never
            // cut off at the pane's edges.
            fixedOverflowWidgets: true,
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
            e.onMouseDown(ev => {
                if (ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
                const f = this.fileOf(e.getModel());
                const line = ev.target.position?.lineNumber;
                if (f === null || line === undefined) return;
                const hit = this.threads.find(t => t.file === f && !t.root.resolved && this.anchorOf(t.id)?.startLineNumber === line);
                const s = this.suggs
                    .get(f)
                    ?.list()
                    .find(x => x.line === line);
                if (hit) this.on.openThread(hit.id, { open: true });
                else if (s) this.on.openThread(s.id, { open: true });
            }),
        );
        // Undo and redo step through suggestions while suggesting; Monaco's own stack holds only real edits.
        this.suggesting = e.createContextKey('ykSuggesting', false);
        const K = monaco.KeyMod;
        const C = monaco.KeyCode;
        const shown = (): FileSuggestions | undefined => this.suggs.get(this.fileOf(e.getModel()) ?? '');
        e.addCommand(K.CtrlCmd | C.KeyZ, () => shown()?.undo(), 'ykSuggesting');
        e.addCommand(K.CtrlCmd | C.KeyY, () => shown()?.redo(), 'ykSuggesting');
        e.addCommand(K.CtrlCmd | K.Shift | C.KeyZ, () => shown()?.redo(), 'ykSuggesting');
        this.stopRemeasure = remeasureWhenFontsLoad();
        this.stopTheme = followPageTheme();
    }

    dispose(): void {
        this.stopRemeasure();
        this.stopTheme();
        for (const b of this.bindings.values()) b.dispose();
        for (const d of this.disposables) d.dispose();
        this.ed.dispose();
        for (const m of this.models.values()) m.dispose();
        this.presenceStyle?.remove();
    }

    private addModel(f: string, text: string): void {
        const m = monaco.editor.createModel(text, languageOf(f), modelUri(f));
        m.setEOL(monaco.editor.EndOfLineSequence.LF);
        this.models.set(f, m);
        const s = new FileSuggestions(m, f, this.me, {
            suggesting: () => this.suggestMode,
            editor: () => this.ed,
            changed: () => this.finishChange(f, m),
            name: u => this.users[u]?.name ?? u,
        });
        this.suggs.set(f, s);
        this.disposables.push(m.onDidChangeContent(ev => s.onChange(ev, this.internal || (this.bindings.get(f)?.remote ?? false))));
        // Every editing command applies its edits here: what it inserts loses control characters (a pasted carriage
        // return or form feed would show as a glyph and end up in the file).
        const apply = m.pushEditOperations.bind(m);
        m.pushEditOperations = (before, ops, computer, ...rest) => apply(before, ops.map(cleanOp), computer, ...rest);
    }

    /** Keeps `file`'s committed text the same text as `text`, a file of the room, both ways; adds the file if it is new.
     *  When they differ, the room's text wins and the file's suggestions go. */
    bind(file: string, text: Y.Text): void {
        if (!this.models.has(file)) this.addModel(file, text.toJSON());
        const s = this.suggs.get(file);
        if (!s) return;
        if (s.committed() !== text.toJSON()) s.reset(text.toJSON());
        this.bindings.get(file)?.dispose();
        this.bindings.set(file, new TextBinding(this.model(file), text, s));
        this.finishChange(file, this.model(file));
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
            d = { threads: [], presence: [], mirror: [] };
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
     *  their `range`, or to the first match of their `quote`; Monaco then tracks the anchor through edits. The anchor of
     *  a thread that is gone (a cancelled draft, a deleted thread) is removed. */
    setThreads(threads: readonly Thread[], active: string | null): void {
        this.threads = threads;
        const ids = new Set(threads.map(t => t.id));
        for (const [id, d] of this.threadDeco) {
            if (ids.has(id)) continue;
            this.models.get(d.file)?.deltaDecorations([d.id], []);
            this.threadDeco.delete(id);
        }
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

    /** Adds suggestions from elsewhere (seed data, the room) at their quotes: their text is put after the quote, marked
     *  as suggested. Ones already shown are left alone. */
    addSuggestions(list: readonly Suggestion[], users: Readonly<Record<string, User>>): void {
        this.users = users;
        for (const s of list) if (s.quote !== undefined) this.suggs.get(s.file)?.add(s.id, s.author, s.when, s.quote, s.text);
        this.reportSuggestions();
    }

    private users: Readonly<Record<string, User>> = {};

    /** Where a suggestion is now, with the text a comment on it quotes: its struck text, or its suggested text when it
     *  strikes nothing; null when it is gone. */
    suggestionPlace(id: string): { file: string; range: TextRange; quote: string } | null {
        const s = this.suggestionsWith(id);
        return s ? s.place(id) : null;
    }

    private reportSuggestions(): void {
        this.on.suggestions([...this.suggs.values()].flatMap(s => s.list()));
    }

    /** Turns suggestion mode on or off: while on, the user's edits become suggestions. */
    setSuggestMode(on: boolean): void {
        this.suggestMode = on;
        this.suggesting.set(on);
    }

    private finishChange(f: string, m: Model): void {
        this.bindings.get(f)?.push();
        this.on.change(f, this.suggs.get(f)?.committed() ?? m.getValue());
        this.reportAnchors();
        this.reportSuggestions();
    }

    private suggestionsWith(id: string): FileSuggestions | null {
        for (const s of this.suggs.values()) if (s.has(id)) return s;
        return null;
    }

    /** Accepts suggestion `id`: its suggested text becomes the file's, its struck text goes. */
    acceptSuggestion(id: string): void {
        this.suggestionsWith(id)?.accept(id);
    }

    /** Rejects suggestion `id`: its suggested text goes, the file stays as it was. */
    rejectSuggestion(id: string): void {
        this.suggestionsWith(id)?.reject(id);
    }

    /** Replaces a thread's anchored text with `text`, as an ordinary edit (a replacement offered in a comment). */
    replaceAnchor(threadId: string, text: string): void {
        const t = this.threads.find(x => x.id === threadId);
        const r = this.anchorOf(threadId);
        if (!t || !r) return;
        this.applyInternal(t.file, this.model(t.file), r, text);
    }

    private applyInternal(_file: string, m: Model, r: TextRange, text: string): void {
        this.internal = true;
        try {
            m.pushEditOperations([], [{ range: r, text }], () => null);
        } finally {
            this.internal = false;
        }
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

    /** Shows the build's problems: squiggles with the message on hover, the line number in the problem's colour, and
     *  for an error its message at the end of its line, so a broken line says what is wrong without opening anything.
     *  Callers pass problems only once a build has settled, never mid-word. */
    setDiagnostics(list: readonly Diagnostic[]): void {
        for (const [f, m] of this.models) {
            const mine = list.filter(d => d.file === f && d.line >= 1 && d.line <= m.getLineCount());
            const markers = mine.map(d => ({
                severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
                message: d.message,
                startLineNumber: d.line,
                endLineNumber: d.line,
                startColumn: m.getLineFirstNonWhitespaceColumn(d.line) || 1,
                endColumn: m.getLineMaxColumn(d.line),
            }));
            monaco.editor.setModelMarkers(m, 'tex', markers);
            const seen = new Set<number>();
            const decos: Editor.IModelDeltaDecoration[] = [];
            for (const d of mine) {
                if (d.severity === 'info' || seen.has(d.line)) continue;
                seen.add(d.line);
                const end = m.getLineMaxColumn(d.line);
                decos.push({
                    range: new monaco.Range(d.line, end, d.line, end),
                    options: {
                        showIfCollapsed: true,
                        lineNumberClassName: `ln-${d.severity}`,
                        ...(d.severity === 'error'
                            ? { after: { content: `  ${d.message}`, inlineClassName: 'inline-problem', cursorStops: monaco.editor.InjectedTextCursorStops.None } }
                            : {}),
                    },
                });
            }
            this.problemDecos.set(f, m.deltaDecorations(this.problemDecos.get(f) ?? [], decos));
        }
    }

    private readonly problemDecos = new Map<string, string[]>();

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
        const s = this.suggestionsWith(id);
        const sr = s?.extent(id);
        if (s && sr) this.reveal(s.file, sr.startLineNumber, sr.startColumn, { focus: false });
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

    /** For browser tests: the shown file's committed text (`text`), the model's text with suggestions (`shown`), its line
     *  count, the caret, the selection and the suggestions. */
    testState(): {
        text: string;
        shown: string;
        lines: number;
        caret: { line: number; column: number } | null;
        selection: string;
        suggestions: { id: string; text: string; oldText: string; line: number; col: number }[];
    } {
        const m = this.ed.getModel();
        const p = this.ed.getPosition();
        const sel = this.ed.getSelection();
        const f = this.fileOf(m);
        const s = f === null ? undefined : this.suggs.get(f);
        return {
            text: s?.committed() ?? m?.getValue() ?? '',
            shown: m?.getValue() ?? '',
            lines: m?.getLineCount() ?? 0,
            caret: p ? { line: p.lineNumber, column: p.column } : null,
            selection: sel && m ? m.getValueInRange(sel) : '',
            suggestions: (s?.list() ?? []).map(x => ({ id: x.id, text: x.text, oldText: x.oldText, line: x.line, col: x.col })),
        };
    }

    /** Monaco's theme as applied, for browser tests. */
    get themeIsDark(): boolean {
        return this.host.querySelector('.monaco-editor')?.classList.contains('vs-dark') ?? false;
    }
}

/** `op` without control characters (but tab and line feed) in its text; a CR LF becomes LF. */
function cleanOp(op: Editor.IIdentifiedSingleEditOperation): Editor.IIdentifiedSingleEditOperation {
    const text = op.text;
    if (!text) return op;
    const clean = Array.from(text)
        .filter(ch => {
            const c = ch.charCodeAt(0);
            return c === 9 || c === 10 || (c >= 32 && c !== 127);
        })
        .join('');
    return clean === text ? op : { ...op, text: clean };
}

/** The first match of `quote` in `m`, or null. */
function findRange(m: Model, quote: string): Range | null {
    return m.findMatches(quote, false, false, true, null, false)[0]?.range ?? null;
}
