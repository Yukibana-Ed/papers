import type { editor as Editor, IDisposable } from 'monaco-editor/editor/editor.api';
import * as Y from 'yjs';

/** Keeps a Monaco model and a Y.Text the same text, both ways: local edits become Yjs operations, remote operations
 *  become model edits (which keep the cursor where it belongs, unlike replacing the value).
 *
 *  Precondition: the model and the text start equal, or the model is overwritten with the text. */
export class TextBinding {
    private applyingRemote = false;
    private readonly sub: IDisposable;
    private readonly observer: (e: Y.YTextEvent, tr: Y.Transaction) => void;

    constructor(
        model: Editor.ITextModel,
        private readonly text: Y.Text,
    ) {
        if (model.getValue() !== text.toJSON()) {
            this.applyingRemote = true;
            model.setValue(text.toJSON());
            this.applyingRemote = false;
        }
        this.observer = (e, tr) => {
            if (tr.origin === this) return;
            this.applyingRemote = true;
            try {
                let index = 0;
                const edits: Editor.IIdentifiedSingleEditOperation[] = [];
                for (const d of e.delta) {
                    if (d.retain !== undefined) index += d.retain;
                    else if (d.insert !== undefined) {
                        const at = model.getPositionAt(index);
                        const s = typeof d.insert === 'string' ? d.insert : '';
                        edits.push({
                            range: { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column },
                            text: s,
                            forceMoveMarkers: true,
                        });
                        // Positions after this one are in the text as it will be; Monaco applies edits as a batch on the
                        // old text, so the index only moves past retained and deleted text.
                    } else if (d.delete !== undefined) {
                        const a = model.getPositionAt(index);
                        const b = model.getPositionAt(index + d.delete);
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
        this.sub = model.onDidChangeContent(e => {
            if (this.applyingRemote) return;
            const doc = text.doc;
            const apply = (): void => {
                // Highest offset first, so earlier offsets stay valid.
                for (const c of e.changes.toSorted((a, b) => b.rangeOffset - a.rangeOffset)) {
                    if (c.rangeLength) text.delete(c.rangeOffset, c.rangeLength);
                    if (c.text) text.insert(c.rangeOffset, c.text);
                }
            };
            if (doc) doc.transact(apply, this);
            else apply();
        });
    }

    /** Whether the model is changing because of a remote edit; the editor's own change handling skips those. */
    get remote(): boolean {
        return this.applyingRemote;
    }

    dispose(): void {
        this.text.unobserve(this.observer);
        this.sub.dispose();
    }
}
