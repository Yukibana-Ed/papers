import * as Y from 'yjs';
import { IdSet } from '@yukibana/papers-room-protocol';
import { ReviewSource } from '#lib/review/source.svelte.ts';
import { visibleIds } from '#lib/review/yruns.ts';
import { BASE, FILES, ME } from './project.ts';

/** An edit someone else made in the demo's session: `insert` put after the first `after` in `file`. */
interface DemoEdit {
    readonly by: string;
    readonly file: string;
    readonly after: string;
    readonly insert: string;
}

/** The demo's uncommitted edits, by whom, in order: applied to the committed files they give the demo's files. Marco
 *  and Lena both edit the same line of the method. */
const EDITS: readonly DemoEdit[] = [
    {
        by: 'lena',
        file: 'sections/intro.tex',
        after: '  \\item A study with 412 students over one semester.\n',
        insert: '  \\item An analysis of which kinds of feedback students act on.\n',
    },
    { by: 'marco', file: 'sections/method.tex', after: 'first-year course\n', insert: 'on ' },
    { by: 'lena', file: 'sections/method.tex', after: 'first-year course\non ', insert: 'programming ' },
];

/** The demo's room, made up: a text document holding the committed files and the others' edits on top, as each of them
 *  would have made it in their own window, and the review source that tells who did what. The user's edits go into
 *  the same document, through the editor. Promises: the files read as `FILES`. */
export function demoSource(): ReviewSource {
    const origin = new Y.Doc();
    const files = origin.getMap<Y.Text>('files');
    origin.transact(() => {
        for (const [path, text] of Object.entries(BASE)) files.set(path, new Y.Text(text));
    });
    const base = Object.entries(BASE).map(([path, text]) => ({ path, text, items: visibleIds(files.get(path) ?? new Y.Text(), new IdSet()).encode() }));
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(origin));
    const docs = new Map<string, Y.Doc>();
    for (const e of EDITS) {
        const doc = docs.get(e.by) ?? new Y.Doc();
        docs.set(e.by, doc);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(mine, Y.encodeStateVector(doc)));
        const text = doc.getMap<Y.Text>('files').get(e.file);
        const at = text?.toJSON().indexOf(e.after) ?? -1;
        if (text && at >= 0) text.insert(at + e.after.length, e.insert);
        Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(mine)));
    }
    const writers = [...docs].map(([person, doc]) => [doc.clientID, person] as const);
    const source = new ReviewSource(mine, new Y.Doc(), ME);
    source.setBase(base);
    source.addAuthors({ writers, deleted: [] });
    if (import.meta.env.DEV) for (const [path, text] of mine.getMap<Y.Text>('files')) if (text.toJSON() !== FILES[path]) console.warn(`Demo edits do not give ${path}`);
    return source;
}
