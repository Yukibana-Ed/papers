import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mergePush } from '#lib/project/pull.ts';

/** A session document with `files` (path → text). */
function session(files: Record<string, string>): Y.Doc {
    const doc = new Y.Doc();
    for (const [path, text] of Object.entries(files)) doc.getMap<Y.Text>('files').set(path, new Y.Text(text));
    return doc;
}

const texts = (files: Record<string, string>): Map<string, { text: string; blob: string }> =>
    new Map(Object.entries(files).map(([path, text]) => [path, { text, blob: `blob-of-${path}` }]));
const read = (doc: Y.Doc, path: string): string | undefined => doc.getMap<Y.Text>('files').get(path)?.toJSON();

describe('mergePush', () => {
    const committed = { 'a.tex': 'one\ntwo\nthree\n', 'b.tex': 'same\n' };

    it('merges what the push changed with what the session changed, and adds the files it added', () => {
        const doc = session({ 'a.tex': 'one, in the room\ntwo\nthree\n', 'b.tex': 'same\n' });
        const pull = mergePush(doc, committed, { commit: 'c2', texts: texts({ 'a.tex': 'one\ntwo\nthree, pushed\n', 'b.tex': 'same\n', 'c.tex': 'new\n' }) }, 'main');
        // The session itself is untouched until the room applies the update.
        expect(read(doc, 'a.tex')).toBe('one, in the room\ntwo\nthree\n');
        Y.applyUpdate(doc, pull.update);
        expect(read(doc, 'a.tex')).toBe('one, in the room\ntwo\nthree, pushed\n');
        expect(read(doc, 'b.tex')).toBe('same\n');
        expect(read(doc, 'c.tex')).toBe('new\n');
        expect(pull.files.map(f => f.path)).toEqual(['a.tex', 'c.tex']);
        expect(pull.files[0]).toEqual({ path: 'a.tex', blob: 'blob-of-a.tex', text: 'one\ntwo\nthree, pushed\n', items: '' });
        expect(pull.conflicts).toEqual([]);
    });

    it('names the files where both changed the same place, and keeps both versions there', () => {
        const doc = session({ 'a.tex': 'one\ntwo, in the room\nthree\n', 'b.tex': 'same\n' });
        const pull = mergePush(doc, committed, { commit: 'c2', texts: texts({ 'a.tex': 'one\ntwo, pushed\nthree\n', 'b.tex': 'same\n' }) }, 'main');
        Y.applyUpdate(doc, pull.update);
        expect(pull.conflicts).toEqual(['a.tex']);
        expect(read(doc, 'a.tex')).toBe('one\n<<<<<<< session\ntwo, in the room\n=======\ntwo, pushed\n>>>>>>> main\nthree\n');
    });

    it('changes nothing for a push that touches no text of the session', () => {
        const doc = session({ 'a.tex': 'one\ntwo\nthree\nand more\n', 'b.tex': 'same\n' });
        const pull = mergePush(doc, committed, { commit: 'c2', texts: texts(committed) }, 'main');
        Y.applyUpdate(doc, pull.update);
        expect(pull.files).toEqual([]);
        expect(read(doc, 'a.tex')).toBe('one\ntwo\nthree\nand more\n');
    });
});
