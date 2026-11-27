import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IdSet } from '@yukibana/papers-room-protocol';
import { committedText, reviewFile, revertedText, textRuns, type FileReview } from '#lib/review/model.ts';
import { RangeMap } from '#lib/review/ranges.ts';
import { visibleIds, yRuns } from '#lib/review/yruns.ts';

/** People editing one file, each in their own Yjs document, synced on `sync()`; deletions of committed characters are
 *  recorded per person, as the room records them. */
class Team {
    readonly docs = new Map<string, Y.Doc>();
    readonly deleted = new RangeMap<string>();
    readonly suggested = new RangeMap<string>();
    readonly base: { text: string; ids: IdSet };

    constructor(text: string, people: readonly string[]) {
        const origin = new Y.Doc();
        origin.getText('f').insert(0, text);
        for (const p of people) {
            const d = new Y.Doc();
            Y.applyUpdate(d, Y.encodeStateAsUpdate(origin));
            this.docs.set(p, d);
            d.on('afterTransaction', (tr: Y.Transaction) => {
                if (!tr.local) return;
                for (const [client, items] of tr.deleteSet.clients) for (const item of items) this.deleted.set(client, item.clock, item.len, p);
            });
        }
        this.base = { text, ids: visibleIds(origin.getText('f'), new IdSet()) };
    }

    text(p: string): Y.Text {
        const d = this.docs.get(p);
        if (!d) throw new Error(p);
        return d.getText('f');
    }

    sync(): void {
        const all = [...this.docs.values()];
        for (const a of all) for (const b of all) if (a !== b) Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    }

    review(as: string): FileReview {
        const writers = new Map([...this.docs].map(([p, d]) => [d.clientID, p]));
        const runs = yRuns(this.text(as), this.base.text, this.base.ids, {
            writer: c => writers.get(c) ?? null,
            deleter: (c, k, n) => this.deleted.at(c, k, n),
            suggester: (c, k, n) => this.suggested.at(c, k, n),
        });
        if (!runs) throw new Error('ids do not spell the base');
        return reviewFile(runs, as);
    }

    commit(as: string, include: (c: number) => boolean): string {
        const r = this.review(as);
        const { text, items } = committedText(r, include);
        if (!items) throw new Error('no ids');
        this.base.text = text;
        this.base.ids = items;
        return text;
    }
}

const shown = (r: FileReview): string[] => r.rows.filter(x => x.kind !== 'ctx').map(x => `${x.kind === 'del' ? '-' : '+'}${x.text} ${x.authors.join(',')}`);

describe('review of uncommitted changes', () => {
    it('credits each line to whoever typed in it, with concurrent edits merged', () => {
        const t = new Team('alpha\nbeta\ngamma\n', ['ada', 'lena']);
        t.text('ada').insert(5, ' one');
        t.text('lena').insert(t.base.text.indexOf('gamma') + 5, ' two');
        t.sync();
        const r = t.review('ada');
        expect(shown(r)).toEqual(['-alpha ada', '+alpha one ada', '-gamma lena', '+gamma two lena']);
        expect(r.changes.map(c => c.authors)).toEqual([['ada'], ['lena']]);
        expect(r.rows.find(x => x.kind === 'add')?.mark).toEqual([5, 9]);
    });

    it('credits a line two people edited to both, and a deletion to whoever deleted', () => {
        const t = new Team('first line here\nsecond\nthird\n', ['ada', 'lena', 'marco']);
        t.text('lena').insert(5, ' new');
        t.sync();
        t.text('marco').insert(t.text('marco').toJSON().indexOf(' here'), ' old');
        t.sync();
        t.text('lena').delete(t.text('lena').toJSON().indexOf('third'), 6);
        t.sync();
        const r = t.review('ada');
        expect(shown(r)).toEqual(['-first line here lena,marco', '+first new line old here lena,marco', '-third lena']);
        expect(r.authors).toEqual(['lena', 'marco']);
    });

    it('commits only the ticked changes, and the rest stays uncommitted under the same authors', () => {
        const t = new Team('a\nb\nc\nd\n', ['ada', 'lena']);
        t.text('ada').insert(2, 'B\n');
        t.text('lena').delete(4, 2);
        t.sync();
        const r = t.review('ada');
        expect(r.changes).toHaveLength(2);
        const lenas = r.changes.findIndex(c => c.authors[0] === 'lena');
        expect(t.commit('ada', c => c !== lenas)).toBe('a\nB\nb\nc\nd\n');
        expect(shown(t.review('lena'))).toEqual(['-c lena']);
        // Lena keeps typing: her change is still one, and still hers.
        t.text('lena').insert(0, 'z');
        t.sync();
        expect(shown(t.review('ada'))).toEqual(['-a lena', '+za lena', '-c lena']);
    });

    it('shows nothing for a change undone by retyping the same text', () => {
        const t = new Team('keep\nthis\n', ['ada']);
        t.text('ada').delete(5, 5);
        t.text('ada').insert(5, 'this\n');
        const r = t.review('ada');
        expect(r.changes).toEqual([]);
        expect(committedText(r, () => false).text).toBe('keep\nthis\n');
    });

    it('treats a split line as one change, and reverts it whole', () => {
        const t = new Team('one two\nend\n', ['ada']);
        t.text('ada').insert(3, '\n');
        t.text('ada').delete(4, 1);
        const r = t.review('ada');
        expect(r.changes).toHaveLength(1);
        expect(shown(r)).toEqual(['-one two ada', '+one ada', '+two ada']);
        expect(revertedText(r, c => c === 0)).toBe('one two\nend\n');
        expect(committedText(r, () => false).text).toBe('one two\nend\n');
    });

    it('credits an accepted suggestion to who suggested it, saying who accepted it', () => {
        const t = new Team('very important\n', ['ada']);
        const ada = t.docs.get('ada');
        const before = ada ? Y.getState(ada.store, ada.clientID) : 0;
        t.text('ada').insert(0, 'central ');
        t.suggested.set(ada?.clientID ?? 0, before, 8, 'lena');
        const add = t.review('ada').rows.find(x => x.kind === 'add');
        expect(add?.authors).toEqual(['lena']);
        expect(add?.suggested).toEqual({ by: 'lena', acceptedBy: 'ada' });
    });

    it('compares texts by lines when there are no ids, keyed by text', () => {
        const r = reviewFile(
            textRuns('a\nb\n', 'a\nc\n', () => 'lena'),
            'ada',
        );
        expect(shown(r)).toEqual(['-b lena', '+c lena']);
        expect(r.changes.map(c => c.keys)).toEqual([['-b#0'], ['+c#0']]);
        expect(committedText(r, () => true)).toEqual({ text: 'a\nc\n', items: null });
    });

    it('puts hunks under their section heading with three lines of context', () => {
        const base = ['\\section{Intro}', ...Array.from({ length: 10 }, (_, i) => `l${i}`)].join('\n') + '\n';
        const now = base.replace('l7', 'L7');
        const r = reviewFile(
            textRuns(base, now, () => 'ada'),
            'ada',
        );
        expect(r.hunks).toEqual([{ start: 5, end: 12, oldStart: 6, newStart: 6, header: '\\section{Intro}', changes: [0, 1] }]);
    });

    it('holds up under random concurrent edits and partial commits', () => {
        let seed = 7;
        const rand = (n: number): number => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return seed % n;
        };
        const words = ['x', 'yy\n', 'zz z', '\n', 'w\nv'];
        for (let round = 0; round < 40; round++) {
            const t = new Team('a\nbb\nccc\ndd\ne\n', ['ada', 'lena', 'marco']);
            for (let step = 0; step < 30; step++) {
                const who = ['ada', 'lena', 'marco'][rand(3)] ?? 'ada';
                const text = t.text(who);
                const len = text.length;
                if (rand(2) === 0 || len === 0) text.insert(rand(len + 1), words[rand(words.length)] ?? 'x');
                else {
                    const at = rand(len);
                    text.delete(at, 1 + rand(Math.min(4, len - at)));
                }
                if (rand(4) === 0) t.sync();
                if (rand(10) === 0) {
                    t.sync();
                    const r = t.review('ada');
                    const pick = r.changes.map(() => rand(2) === 0);
                    t.commit('ada', c => pick[c] ?? false);
                }
            }
            t.sync();
            const r = t.review('ada');
            const now = t.text('ada').toJSON();
            expect(committedText(r, () => true).text).toBe(now);
            expect(committedText(r, () => false).text).toBe(t.base.text);
            // Every shown line is in exactly the session or the base, by number.
            const nowLines = now.split('\n');
            for (const row of r.rows) if (row.new !== null) expect(row.text).toBe(nowLines[row.new - 1]);
            const baseLines = t.base.text.split('\n');
            for (const row of r.rows) if (row.old !== null) expect(row.text).toBe(baseLines[row.old - 1]);
            for (const c of r.changes) expect(revertedText(r, k => k === c.index)).toBe(committedText(r, k => k !== c.index).text);
        }
    });
});
