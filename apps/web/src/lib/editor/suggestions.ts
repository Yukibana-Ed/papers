import type { editor as Editor } from 'monaco-editor/editor/editor.api';
import { monaco } from './monaco.ts';

type Model = Editor.ITextModel;

const NEVER = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
const GROW = monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;

/** A suggestion as the editor reports it: `oldText` (struck) is replaced by `text` (suggested), at (`line`, `col`). */
export interface SuggestionInfo {
    readonly id: string;
    readonly author: string;
    readonly when: string;
    readonly file: string;
    readonly text: string;
    readonly oldText: string;
    readonly line: number;
    readonly col: number;
}

/** What a file's suggestions need from the editor around them. */
export interface SuggestionHooks {
    /** Whether a user's edit to this file now is a suggestion (suggestion mode, not the room's edits, not the editor's). */
    suggesting(): boolean;
    /** The editor, when it shows this file: for the caret after a suggested deletion. */
    editor(): Editor.ICodeEditor | null;
    /** The suggestions or the file's committed text changed. */
    changed(): void;
    /** A person's display name, for the hover. */
    name(user: string): string;
}

interface Item {
    readonly id: string;
    readonly author: string;
    readonly when: string;
    /** The struck text: original text the suggestion deletes. */
    del: string;
    /** The suggested text: real text in the model, right after the struck text. */
    ins: string;
}

type Span = readonly [number, number];

interface Snapshot {
    readonly text: string;
    readonly items: readonly { readonly id: string; readonly author: string; readonly when: string; readonly del: Span; readonly ins: Span }[];
}

/** The suggestions of one file, kept as text in its Monaco model.
 *
 *  The model shows the file as it would read with every suggestion: suggested text is real text, marked (`sg-ins`), so
 *  Enter makes a real line, wrapping and the caret work as anywhere else; struck text is the original, kept and marked
 *  (`sg-del`). The file's committed text — what the session, the room, the preview and commits see — is the model's text
 *  without the suggested text (`committed()`), with the struck text still in it.
 *
 *  While suggesting, Monaco applies every edit as usual (typing, paste, Enter with its indentation, Backspace, word and
 *  line deletion, cut, drag and drop, multi-cursor); then each change is sorted out: typed text becomes or extends my
 *  suggested text, deleted original text is put back and struck, deleted suggested text of mine is simply gone. Undo and
 *  redo step through these states. */
export class FileSuggestions {
    private readonly items = new Map<string, Item>();
    private shadow: string;
    private spans: Snapshot['items'] = [];
    /** The marks of line breaks that suggestions add or strike. */
    private marks: string[] = [];
    private busy = false;
    private readonly history: { undo: Snapshot[]; redo: Snapshot[] } = { undo: [], redo: [] };

    constructor(
        private readonly m: Model,
        readonly file: string,
        private readonly me: string,
        private readonly hooks: SuggestionHooks,
    ) {
        this.shadow = m.getValue();
    }

    // --- reading ---------------------------------------------------------------------------------------------------------

    private range(id: string): Span | null {
        const it = this.items.get(id);
        const d = it ? this.m.getDecorationRange(it.del) : null;
        return d ? [this.m.getOffsetAt(d.getStartPosition()), this.m.getOffsetAt(d.getEndPosition())] : null;
    }

    private insRange(id: string): Span | null {
        const it = this.items.get(id);
        const d = it ? this.m.getDecorationRange(it.ins) : null;
        return d ? [this.m.getOffsetAt(d.getStartPosition()), this.m.getOffsetAt(d.getEndPosition())] : null;
    }

    /** The suggested text's spans, in order. */
    private insertions(): Span[] {
        return [...this.items.keys()]
            .map(id => this.insRange(id))
            .filter((r): r is Span => r !== null && r[1] > r[0])
            .toSorted((a, b) => a[0] - b[0]);
    }

    /** The file as committed: the model's text without suggested text. */
    committed(): string {
        const text = this.m.getValue();
        let out = '';
        let at = 0;
        for (const [a, b] of this.insertions()) {
            out += text.slice(at, a);
            at = b;
        }
        return out + text.slice(at);
    }

    /** The model offset of offset `c` of the committed text; at the edge of suggested text, before it. */
    toModel(c: number): number {
        let off = c;
        for (const [a, b] of this.insertions()) if (a < off) off += b - a;
        return off;
    }

    /** The whole extent of a suggestion (struck and suggested text), as a model range. */
    extent(id: string): InstanceType<typeof monaco.Range> | null {
        const d = this.range(id);
        const i = this.insRange(id);
        if (!d || !i) return null;
        return monaco.Range.fromPositions(this.m.getPositionAt(Math.min(d[0], i[0])), this.m.getPositionAt(Math.max(d[1], i[1])));
    }

    /** Where suggestion `id` is: its struck text, or its suggested text when it strikes nothing, as a model range with
     *  that text; null when it is not here. */
    place(id: string): { file: string; range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; quote: string } | null {
        const d = this.range(id);
        const i = this.insRange(id);
        if (!d || !i) return null;
        const [a, b] = d[1] > d[0] ? d : i;
        const r = this.at(a, b);
        return {
            file: this.file,
            range: { startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn },
            quote: this.m.getValue().slice(a, b),
        };
    }

    has(id: string): boolean {
        return this.items.has(id);
    }

    list(): SuggestionInfo[] {
        const text = this.m.getValue();
        const out: SuggestionInfo[] = [];
        for (const it of this.items.values()) {
            const d = this.range(it.id);
            const i = this.insRange(it.id);
            if (!d || !i) continue;
            const p = this.m.getPositionAt(d[0]);
            out.push({
                id: it.id,
                author: it.author,
                when: it.when,
                file: this.file,
                text: text.slice(i[0], i[1]),
                oldText: text.slice(d[0], d[1]),
                line: p.lineNumber,
                col: p.column,
            });
        }
        return out.toSorted((a, b) => a.line - b.line || a.col - b.col);
    }

    // --- decorations -------------------------------------------------------------------------------------------------------

    private delOptions(author: string, empty: boolean): Editor.IModelDecorationOptions {
        return {
            stickiness: NEVER,
            showIfCollapsed: true,
            glyphMarginClassName: 'glyph-sugg',
            hoverMessage: { value: `Suggestion by ${this.hooks.name(author)}` },
            ...(empty ? {} : { inlineClassName: 'sg-del' }),
        };
    }

    private static readonly INS: Editor.IModelDecorationOptions = { stickiness: GROW, showIfCollapsed: true, inlineClassName: 'sg-ins' };

    private at(a: number, b: number): InstanceType<typeof monaco.Range> {
        return monaco.Range.fromPositions(this.m.getPositionAt(a), this.m.getPositionAt(b));
    }

    /** Creates a suggestion striking [d0, d1) with suggested text [i0, i1). */
    private create(id: string, author: string, when: string, del: Span, ins: Span): void {
        const [d, i] = this.m.deltaDecorations(
            [],
            [
                { range: this.at(del[0], del[1]), options: this.delOptions(author, del[0] === del[1]) },
                { range: this.at(ins[0], ins[1]), options: FileSuggestions.INS },
            ],
        );
        if (d !== undefined && i !== undefined) this.items.set(id, { id, author, when, del: d, ins: i });
    }

    private setDel(it: Item, del: Span): void {
        it.del = this.m.deltaDecorations([it.del], [{ range: this.at(del[0], del[1]), options: this.delOptions(it.author, del[0] === del[1]) }])[0] ?? it.del;
    }

    private setIns(it: Item, ins: Span): void {
        it.ins = this.m.deltaDecorations([it.ins], [{ range: this.at(ins[0], ins[1]), options: FileSuggestions.INS }])[0] ?? it.ins;
    }

    private drop(id: string): void {
        const it = this.items.get(id);
        if (!it) return;
        this.m.deltaDecorations([it.del, it.ins], []);
        this.items.delete(id);
    }

    /** Remembers every suggestion's spans, and drops suggestions with nothing left in them. */
    private settleSpans(): void {
        const out: Snapshot['items'][number][] = [];
        for (const it of Array.from(this.items.values())) {
            const d = this.range(it.id);
            const i = this.insRange(it.id);
            if (!d || !i || (d[0] === d[1] && i[0] === i[1])) {
                this.drop(it.id);
                continue;
            }
            out.push({ id: it.id, author: it.author, when: it.when, del: d, ins: i });
        }
        this.spans = out;
        this.drawMarks();
    }

    /** A line break is no character on screen: each one a suggestion adds or strikes gets a mark at the end of its line
     *  (a decoration, never text of the file). */
    private drawMarks(): void {
        const text = this.m.getValue();
        const list: Editor.IModelDeltaDecoration[] = [];
        for (const s of this.spans)
            for (const [[a, b], cls] of [
                [s.ins, 'sg-nl sg-nl-ins'],
                [s.del, 'sg-nl sg-nl-del'],
            ] as const)
                for (let o = text.indexOf('\n', a); o !== -1 && o < b; o = text.indexOf('\n', o + 1)) {
                    const p = this.m.getPositionAt(o);
                    list.push({
                        range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column),
                        options: {
                            stickiness: NEVER,
                            showIfCollapsed: true,
                            after: { content: '\u21b5', inlineClassName: cls, cursorStops: monaco.editor.InjectedTextCursorStops.None },
                        },
                    });
                }
        this.marks = this.m.deltaDecorations(this.marks, list);
    }

    private edit(ops: { range: InstanceType<typeof monaco.Range>; text: string }[]): void {
        this.busy = true;
        try {
            this.m.pushEditOperations([], ops, () => null);
        } finally {
            this.busy = false;
        }
        this.shadow = this.m.getValue();
    }

    /** Makes the file `text` with no suggestions (the room's text, when it differs from the file's). */
    reset(text: string): void {
        for (const id of Array.from(this.items.keys())) this.drop(id);
        if (this.m.getValue() !== text) this.edit([{ range: this.m.getFullModelRange(), text }]);
        this.history.undo = [];
        this.history.redo = [];
        this.settleSpans();
    }

    // --- from outside --------------------------------------------------------------------------------------------------------

    /** Adds someone's suggestion replacing the first match of `quote` with `text` (seed data, the room). */
    add(id: string, author: string, when: string, quote: string, text: string): void {
        if (this.items.has(id)) return;
        const r = this.m.findMatches(quote, false, false, true, null, false)[0]?.range;
        if (!r) return;
        const d0 = this.m.getOffsetAt(r.getStartPosition());
        const d1 = this.m.getOffsetAt(r.getEndPosition());
        if (text) this.edit([{ range: this.at(d1, d1), text }]);
        this.create(id, author, when, [d0, d1], [d1, d1 + text.length]);
        this.settleSpans();
        this.hooks.changed();
    }

    /** Accepts a suggestion: the struck text goes, the suggested text stays as the file's own. */
    accept(id: string): void {
        const d = this.range(id);
        if (!d) return;
        this.drop(id);
        if (d[1] > d[0]) this.edit([{ range: this.at(d[0], d[1]), text: '' }]);
        this.settleSpans();
        this.hooks.changed();
    }

    /** Rejects a suggestion: the suggested text goes, the struck text stays. */
    reject(id: string): void {
        const i = this.insRange(id);
        if (!i) return;
        this.drop(id);
        if (i[1] > i[0]) this.edit([{ range: this.at(i[0], i[1]), text: '' }]);
        this.settleSpans();
        this.hooks.changed();
    }

    // --- edits -------------------------------------------------------------------------------------------------------------

    /** Sorts out one change of the model. `external`: the room's or the editor's own edit, never a suggestion. */
    onChange(e: Editor.IModelContentChangedEvent, external: boolean): void {
        const before = this.shadow;
        this.shadow = this.m.getValue();
        if (this.busy) return;
        const changes = e.changes.toSorted((a, b) => a.rangeOffset - b.rangeOffset);
        if (external || !this.hooks.suggesting() || e.isUndoing || e.isRedoing) {
            this.keepTypedTextOut(changes);
            this.settleSpans();
            this.hooks.changed();
            return;
        }
        // Suggesting. Monaco has applied the edit; work out, in the text before it, what original text it removed.
        const editor = this.hooks.editor();
        const sel = editor?.getModel() === this.m ? editor.getSelection() : null; // still the selection before the edit
        const caret = sel && sel.isEmpty() ? offsetIn(before, sel.positionLineNumber, sel.positionColumn) : null;
        const mine = this.spans.filter(s => s.ins[1] > s.ins[0]);
        const restores: { at: number; text: string; backward: boolean; forward: boolean }[] = [];
        const typed: Span[] = [];
        let shift = 0;
        for (const c of changes) {
            const start = c.rangeOffset;
            const end = start + c.rangeLength;
            // Removed text outside any suggested text is the file's own: it comes back, struck.
            let kept = '';
            let at = start;
            for (const s of mine.toSorted((a, b) => a.ins[0] - b.ins[0])) {
                if (s.ins[1] <= at || s.ins[0] >= end) continue;
                kept += before.slice(at, Math.max(at, s.ins[0]));
                at = Math.max(at, s.ins[1]);
            }
            if (at < end) kept += before.slice(at, end);
            const after = start + shift;
            if (kept) {
                // The caret's offset is of the text before the edit, as `start` and `end` are.
                restores.push({ at: after, text: kept, backward: c.text === '' && caret === end, forward: c.text === '' && caret === start });
            }
            if (c.text) typed.push([after, after + c.text.length]);
            shift += c.text.length - c.rangeLength;
        }
        this.history.undo.push({ text: before, items: this.spans });
        this.history.redo = [];
        // After Monaco has moved the caret for its edit.
        queueMicrotask(() => this.settle(restores, typed));
    }

    /** Text typed by an ordinary edit at the edge of suggested text is the file's own: suggested text never grows by it. */
    private keepTypedTextOut(changes: readonly Editor.IModelContentChange[]): void {
        let shift = 0;
        for (const c of changes) {
            const p = c.rangeOffset + shift;
            const q = p + c.text.length;
            shift += c.text.length - c.rangeLength;
            if (p === q) continue;
            for (const it of this.items.values()) {
                const i = this.insRange(it.id);
                if (!i) continue;
                if (i[0] === p && i[1] >= q) this.setIns(it, [q, i[1]]);
                else if (i[1] === q && i[0] <= p) this.setIns(it, [i[0], p]);
            }
        }
    }

    private settle(restores: readonly { at: number; text: string; backward: boolean; forward: boolean }[], typed: readonly Span[]): void {
        // 1. The original text comes back, each piece where it was (from the end, so the offsets before stay valid).
        if (restores.length) this.edit(restores.toSorted((a, b) => b.at - a.at).map(r => ({ range: this.at(r.at, r.at), text: r.text })));
        const moved = (p: number, inclusive: boolean): number => p + restores.filter(r => (inclusive ? r.at <= p : r.at < p)).reduce((n, r) => n + r.text.length, 0);
        const struck: { span: Span; backward: boolean; forward: boolean }[] = restores.map(r => {
            const x = moved(r.at, false);
            return { span: [x, x + r.text.length] as const, backward: r.backward, forward: r.forward };
        });
        // Restored text never belongs to suggested text it was put back next to.
        for (const s of struck) this.keepOut(s.span);
        // 2. Struck text joins my struck text it touches, or starts a suggestion.
        for (const s of struck) this.strike(s.span);
        // 3. Typed text is my suggested text: of the suggestion whose struck text it follows, or of a new one.
        for (const t of typed) this.claim([moved(t[0], true), moved(t[1], true)]);
        this.settleSpans();
        // 4. The caret after a deletion: before what Backspace struck, after what Delete struck.
        const editor = this.hooks.editor();
        const last = struck.at(-1);
        if (editor && editor.getModel() === this.m && last && (last.backward || last.forward)) {
            const p = this.m.getPositionAt(last.backward ? last.span[0] : last.span[1]);
            editor.setSelection(new monaco.Selection(p.lineNumber, p.column, p.lineNumber, p.column));
        }
        this.hooks.changed();
    }

    /** Shrinks any suggested text that took in [a, b) at its edge. */
    private keepOut([a, b]: Span): void {
        for (const it of this.items.values()) {
            const i = this.insRange(it.id);
            if (!i || i[1] <= a || i[0] >= b) continue;
            if (i[0] >= a) this.setIns(it, [Math.max(b, i[0]), Math.max(b, i[1])]);
            else this.setIns(it, [i[0], Math.min(a, i[1])]);
        }
    }

    private strike([x, y]: Span): void {
        for (const it of this.items.values()) {
            if (it.author !== this.me) continue;
            const d = this.range(it.id);
            const i = this.insRange(it.id);
            if (!d || !i) continue;
            if (d[1] === x && i[0] === i[1]) {
                this.setDel(it, [d[0], y]); // Delete after my struck text: strike on
                this.setIns(it, [y, y]);
                return;
            }
            if (d[0] === y) {
                this.setDel(it, [x, d[1]]); // Backspace before my struck text: strike more
                return;
            }
        }
        this.create(newId(), this.me, 'now', [x, y], [y, y]);
    }

    private claim([p, q]: Span): void {
        for (const it of this.items.values()) {
            const i = this.insRange(it.id);
            if (!i || i[0] > p || i[1] < q) continue;
            if (it.author === this.me) return; // it grew into my suggested text
            // Someone else's suggested text took it in at its edge: give it back.
            if (i[0] === p) this.setIns(it, [q, i[1]]);
            else if (i[1] === q) this.setIns(it, [i[0], p]);
            else return; // typed inside their suggested text: an edit of their suggestion
        }
        for (const it of this.items.values()) {
            if (it.author !== this.me) continue;
            const d = this.range(it.id);
            const i = this.insRange(it.id);
            if (d && i && i[0] === i[1] && d[1] === p) {
                this.setIns(it, [p, q]);
                return;
            }
        }
        this.create(newId(), this.me, 'now', [p, p], [p, q]);
    }

    // --- undo ---------------------------------------------------------------------------------------------------------------

    private restore(s: Snapshot): void {
        for (const id of Array.from(this.items.keys())) this.drop(id);
        this.edit([{ range: this.m.getFullModelRange(), text: s.text }]);
        for (const it of s.items) this.create(it.id, it.author, it.when, it.del, it.ins);
        this.settleSpans();
        this.hooks.changed();
    }

    undo(): void {
        const s = this.history.undo.pop();
        if (!s) return;
        this.history.redo.push({ text: this.m.getValue(), items: this.spans });
        this.restore(s);
    }

    redo(): void {
        const s = this.history.redo.pop();
        if (!s) return;
        this.history.undo.push({ text: this.m.getValue(), items: this.spans });
        this.restore(s);
    }
}

/** The offset of (`line`, `col`) in `text`. */
function offsetIn(text: string, line: number, col: number): number {
    let o = 0;
    for (let l = 1; l < line; l++) {
        const n = text.indexOf('\n', o);
        if (n === -1) return text.length;
        o = n + 1;
    }
    return o + col - 1;
}

function newId(): string {
    return `s${crypto.randomUUID()}`;
}
