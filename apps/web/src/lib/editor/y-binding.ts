import type { editor as Editor, IDisposable } from 'monaco-editor/editor/editor.api';
import * as Y from 'yjs';

/** How a model shows a file whose model text is not the file's text (suggested text shown in the model, not in the file). */
export interface TextView {
    /** The file's text: what the room stores. */
    committed(): string;
    /** The model offset of offset `c` of `committed()`. */
    toModel(c: number): number;
}

/** Keeps a Monaco model and a Y.Text the same text, both ways: local edits become Yjs operations, remote operations
 *  become model edits (which keep the cursor where it belongs, unlike replacing the value).
 *
 *  Without a `view`, the model's text is the file's text: every local change of the model goes to the Y.Text as it
 *  happens. With a `view`, the Y.Text holds `view.committed()`: the binding does not listen to the model, the owner calls
 *  `push()` once a local change has settled, and remote operations land at `view.toModel` of their offsets.
 *
 *  Precondition: the model's file text and the Y.Text start equal, or (without a view) the model is overwritten with
 *  the text. */
export class TextBinding {
    private applyingRemote = false;
    private readonly sub: IDisposable | null;
    private readonly observer: (e: Y.YTextEvent, tr: Y.Transaction) => void;

    constructor(
        model: Editor.ITextModel,
        private readonly text: Y.Text,
        private readonly view: TextView | null = null,
    ) {
        if (!view && model.getValue() !== text.toJSON()) {
            this.applyingRemote = true;
            model.setValue(text.toJSON());
            this.applyingRemote = false;
        }
        const at = (c: number): number => (view ? view.toModel(c) : c);
        this.observer = (e, tr) => {
            if (tr.origin === this) return;
            this.applyingRemote = true;
            try {
                let index = 0;
                const edits: Editor.IIdentifiedSingleEditOperation[] = [];
                for (const d of e.delta) {
                    if (d.retain !== undefined) index += d.retain;
                    else if (d.insert !== undefined) {
                        const p = model.getPositionAt(at(index));
                        const s = typeof d.insert === 'string' ? d.insert : '';
                        edits.push({
                            range: { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column },
                            text: s,
                            forceMoveMarkers: true,
                        });
                        // Positions after this one are in the text as it will be; Monaco applies edits as a batch on the
                        // old text, so the index only moves past retained and deleted text.
                    } else if (d.delete !== undefined) {
                        const a = model.getPositionAt(at(index));
                        const b = model.getPositionAt(at(index + d.delete));
                        edits.push({ range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: '' });
                        index += d.delete;
                    }
                }
                model.pushEditOperations([], edits, () => null);
            } finally {
                this.applyingRemote = false;
            }
        };
        text.observe(this.observer);
        this.sub = view
            ? null
            : model.onDidChangeContent(e => {
                  if (this.applyingRemote) return;
                  this.transact(() => {
                      // Highest offset first, so earlier offsets stay valid.
                      for (const c of e.changes.toSorted((a, b) => b.rangeOffset - a.rangeOffset)) {
                          if (c.rangeLength) text.delete(c.rangeOffset, c.rangeLength);
                          if (c.text) text.insert(c.rangeOffset, c.text);
                      }
                  });
              });
    }

    private transact(apply: () => void): void {
        const doc = this.text.doc;
        if (doc) doc.transact(apply, this);
        else apply();
    }

    /** With a view: makes the Y.Text `view.committed()`, as one change spanning where they differ. Does nothing while a
     *  remote operation is being applied, or when they are equal. */
    push(): void {
        if (!this.view || this.applyingRemote) return;
        const next = this.view.committed();
        const prev = this.text.toJSON();
        if (next === prev) return;
        let a = 0;
        while (a < next.length && a < prev.length && next[a] === prev[a]) a++;
        let b = 0;
        while (b < next.length - a && b < prev.length - a && next[next.length - 1 - b] === prev[prev.length - 1 - b]) b++;
        this.transact(() => {
            if (prev.length - a - b > 0) this.text.delete(a, prev.length - a - b);
            if (next.length - a - b > 0) this.text.insert(a, next.slice(a, next.length - b));
        });
    }

    /** Whether the model is changing because of a remote edit; the editor's own change handling skips those. */
    get remote(): boolean {
        return this.applyingRemote;
    }

    dispose(): void {
        this.text.unobserve(this.observer);
        this.sub?.dispose();
    }
}
