import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { rejoin, sameTexts } from '#lib/room/rejoin.ts';

const BASE = ['\\section{One}', 'First line.', '', '\\section{Two}', 'Second line.', ''].join('\n');

/** A session's two documents, with `paper.tex` made here from `text`. */
function made(text: string): { text: Y.Doc; review: Y.Doc } {
    const docs = { text: new Y.Doc(), review: new Y.Doc() };
    docs.text.getMap<Y.Text>('files').set('paper.tex', new Y.Text(text));
    return docs;
}

/** A copy of `of`, as a browser that synced with it holds. */
function copy(of: { text: Y.Doc; review: Y.Doc }): { text: Y.Doc; review: Y.Doc } {
    const docs = { text: new Y.Doc(), review: new Y.Doc() };
    Y.applyUpdate(docs.text, Y.encodeStateAsUpdate(of.text));
    Y.applyUpdate(docs.review, Y.encodeStateAsUpdate(of.review));
    return docs;
}

function paper(docs: { text: Y.Doc }): Y.Text {
    const t = docs.text.getMap<Y.Text>('files').get('paper.tex');
    if (!t) throw new Error('no paper');
    return t;
}

function edit(docs: { text: Y.Doc }, find: string, to: string): void {
    const t = paper(docs);
    const at = t.toJSON().indexOf(find);
    t.delete(at, find.length);
    t.insert(at, to);
}

describe('rejoin', () => {
    it('tells a copy of the room’s documents from documents made separately from the same text', () => {
        const room = made(BASE);
        expect(sameTexts(copy(room).text, room.text)).toBe(true);
        expect(sameTexts(made(BASE).text, room.text)).toBe(false);
        // A file the room lacks is not the room's.
        const more = copy(room);
        more.text.getMap<Y.Text>('files').set('new.tex', new Y.Text('x'));
        expect(sameTexts(more.text, room.text)).toBe(false);
    });

    it('merges a copy as a document: both sides’ edits, each once, where they were made', () => {
        const room = made(BASE);
        const local = copy(room);
        edit(local, 'First line.', 'First line, edited away.');
        edit(room, 'Second line.', 'Second line, edited in the room.');
        // Both typed in the same line: a text merge would call it a conflict, a document merge keeps both.
        paper(local).insert(0, 'A');
        paper(room).insert(0, 'B');
        expect(rejoin(local, room, { 'paper.tex': BASE })).toEqual([]);
        const text = paper(room).toJSON();
        expect(text).toContain('First line, edited away.');
        expect(text).toContain('Second line, edited in the room.');
        expect(text.match(/section\{One\}/g)).toHaveLength(1);
        expect(text.slice(0, 2).split('').toSorted()).toEqual(['A', 'B']);
    });

    it('merges documents made separately as text: nothing is doubled, nothing of either side is lost', () => {
        const room = made(BASE);
        const local = made(BASE);
        edit(local, 'First line.', 'First line, edited away.');
        edit(room, 'Second line.', 'Second line, edited in the room.');
        expect(rejoin(local, room, { 'paper.tex': BASE })).toEqual([]);
        expect(paper(room).toJSON()).toBe(BASE.replace('First line.', 'First line, edited away.').replace('Second line.', 'Second line, edited in the room.'));
        // The local documents are left as they were.
        expect(paper(local).toJSON()).toBe(BASE.replace('First line.', 'First line, edited away.'));
    });

    it('leaves the room’s text alone when nothing was done away from it', () => {
        const room = made(BASE);
        edit(room, 'Second line.', 'Changed.');
        const before = Y.encodeStateVector(room.text);
        expect(rejoin(made(BASE), room, { 'paper.tex': BASE })).toEqual([]);
        expect(Y.encodeStateVector(room.text)).toEqual(before);
    });

    it('keeps both versions of a place both changed, and names the file', () => {
        const room = made(BASE);
        const local = made(BASE);
        edit(local, 'First line.', 'Mine.');
        edit(room, 'First line.', 'Theirs.');
        expect(rejoin(local, room, { 'paper.tex': BASE })).toEqual(['paper.tex']);
        const text = paper(room).toJSON();
        expect(text).toContain('<<<<<<< this device\nMine.\n=======\nTheirs.\n>>>>>>> room');
    });

    it('merges from the text both started from, when the room has moved on to later commits', () => {
        const later = BASE.replace('\\section{Two}', '\\section{Two, renamed in a commit}');
        const room = made(later);
        const local = made(BASE);
        edit(local, 'First line.', 'First line, edited away.');
        expect(rejoin(local, room, { 'paper.tex': BASE })).toEqual([]);
        expect(paper(room).toJSON()).toBe(later.replace('First line.', 'First line, edited away.'));
    });

    it('skips a file the room does not have', () => {
        const room = made(BASE);
        const local = made(BASE);
        local.text.getMap<Y.Text>('files').set('new.tex', new Y.Text('x'));
        expect(rejoin(local, room, { 'paper.tex': BASE })).toEqual([]);
        expect(room.text.getMap<Y.Text>('files').has('new.tex')).toBe(false);
    });

    it('brings comment threads written away into the room', () => {
        const room = made(BASE);
        room.review.getMap<string>('threads').set('t1', '{"id":"t1"}');
        const local = made(BASE);
        local.review.getMap<string>('threads').set('t2', '{"id":"t2"}');
        rejoin(local, room, { 'paper.tex': BASE });
        expect([...room.review.getMap<string>('threads').keys()].toSorted()).toEqual(['t1', 't2']);
    });
});
