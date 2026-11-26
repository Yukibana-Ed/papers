import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextBinding } from '#lib/editor/y-binding.ts';

interface Range {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}

/** The part of Monaco's text model the binding uses, over a plain string. */
class FakeModel {
    private value: string;
    private listeners: ((e: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void)[] = [];
    constructor(v: string) {
        this.value = v;
    }
    getValue(): string {
        return this.value;
    }
    setValue(v: string): void {
        const old = this.value;
        this.value = v;
        this.emit([{ rangeOffset: 0, rangeLength: old.length, text: v }]);
    }
    getPositionAt(offset: number): { lineNumber: number; column: number } {
        const before = this.value.slice(0, offset).split('\n');
        return { lineNumber: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
    }
    getOffsetAt(p: { lineNumber: number; column: number }): number {
        const lines = this.value.split('\n');
        let o = 0;
        for (let i = 0; i < p.lineNumber - 1; i++) o += (lines[i]?.length ?? 0) + 1;
        return o + p.column - 1;
    }
    /** Applies edits as Monaco does: all ranges refer to the text before any of them. */
    pushEditOperations(_s: unknown, edits: { range: Range; text: string }[]): null {
        const ops = edits
            .map(e => ({
                start: this.getOffsetAt({ lineNumber: e.range.startLineNumber, column: e.range.startColumn }),
                end: this.getOffsetAt({ lineNumber: e.range.endLineNumber, column: e.range.endColumn }),
                text: e.text,
            }))
            .toSorted((a, b) => b.start - a.start);
        for (const o of ops) this.value = this.value.slice(0, o.start) + o.text + this.value.slice(o.end);
        this.emit(ops.map(o => ({ rangeOffset: o.start, rangeLength: o.end - o.start, text: o.text })));
        return null;
    }
    /** A local edit, as typing makes one. */
    type(offset: number, del: number, text: string): void {
        this.value = this.value.slice(0, offset) + text + this.value.slice(offset + del);
        this.emit([{ rangeOffset: offset, rangeLength: del, text }]);
    }
    onDidChangeContent(f: (e: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void): { dispose(): void } {
        this.listeners.push(f);
        return { dispose: () => (this.listeners = this.listeners.filter(x => x !== f)) };
    }
    private emit(changes: { rangeOffset: number; rangeLength: number; text: string }[]): void {
        for (const l of this.listeners) l({ changes });
    }
}

/** Two editors on two Yjs replicas of one text, with updates exchanged between the replicas. */
function pair(initial: string) {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u, 'net'));
    b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(a, u, 'net'));
    a.getText('t').insert(0, initial);
    const ma = new FakeModel(initial);
    const mb = new FakeModel(initial);
    const bindings = [new TextBinding(ma as never, a.getText('t')), new TextBinding(mb as never, b.getText('t'))];
    return { ma, mb, a, b, bindings };
}

describe('TextBinding', () => {
    it('carries local edits to the other side, across lines', () => {
        const { ma, mb } = pair('one\ntwo\nthree');
        ma.type(4, 3, 'TWO');
        mb.type(0, 0, '> ');
        expect(ma.getValue()).toBe('> one\nTWO\nthree');
        expect(mb.getValue()).toBe('> one\nTWO\nthree');
    });

    it('stays equal under random edits from both sides', () => {
        const { ma, mb, a } = pair('The quick brown fox\njumps over\nthe lazy dog.');
        let seed = 7;
        const rnd = (n: number): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        for (let i = 0; i < 300; i++) {
            const m = rnd(2) ? ma : mb;
            const len = m.getValue().length;
            const at = rnd(len + 1);
            const del = Math.min(rnd(4), len - at);
            m.type(at, del, ['x', '\n', 'yz', '', 'é'][rnd(5)] ?? '');
            expect(ma.getValue()).toBe(mb.getValue());
        }
        expect(a.getText('t').toJSON()).toBe(ma.getValue());
    });

    it('applies a remote batch of inserts and deletes at once', () => {
        const { ma, mb, a } = pair('abcdef\nghij');
        a.transact(() => {
            a.getText('t').delete(1, 2);
            a.getText('t').insert(4, 'XY\n');
            a.getText('t').insert(0, 'Z');
        });
        expect(mb.getValue()).toBe(a.getText('t').toJSON());
        expect(ma.getValue()).toBe(a.getText('t').toJSON());
    });

    it('with a view, keeps text shown only in the model out of the room and maps remote edits around it', () => {
        const doc = new Y.Doc();
        const t = doc.getText('t');
        t.insert(0, 'abc def');
        // The model shows "NEW " suggested at offset 4, which the file does not have.
        const m = new FakeModel('abc NEW def');
        const view = {
            committed: (): string => m.getValue().slice(0, 4) + m.getValue().slice(8),
            toModel: (c: number): number => (c > 4 ? c + 4 : c),
        };
        const b = new TextBinding(m as never, t, view);
        m.type(0, 0, 'X');
        expect(t.toJSON()).toBe('abc def'); // not pushed yet: the owner pushes once the change has settled
        view.committed = (): string => m.getValue().slice(0, 5) + m.getValue().slice(9);
        view.toModel = (c: number): number => (c > 5 ? c + 4 : c);
        b.push();
        expect(t.toJSON()).toBe('Xabc def');
        t.insert(8, '!');
        expect(m.getValue()).toBe('Xabc NEW def!');
        t.delete(6, 3);
        expect(m.getValue()).toBe('Xabc NEW d');
    });
});
