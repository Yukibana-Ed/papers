import { describe, expect, it } from 'vitest';
import { furthest, heldBytes, Machine, Run, Session, type Project, type Snapshot } from '../src/index.ts';
import { edited, engine, job, outputs, pdfPages, PREAMBLE, project, text } from './support.ts';

const ready = engine !== null;
/** A machine that checks, at every capture and restore, that the engine marked every page it wrote. */
const machine = (): Machine => {
    if (engine === null) throw new Error('no engine');
    return new Machine(engine, { verify: true });
};

/** The outputs of a run of `p` from the start, without snapshots. */
function plain(p: Project): Map<string, Uint8Array> {
    const run = new Run({ machine: machine(), job, project: p });
    expect(run.go()).toBe('done');
    expect(run.exitCode).toBe(0);
    return outputs(run.outputs());
}

const three = project({
    'main.tex': `${PREAMBLE}\\pages{3}\n\\input one\n\\input two\n\\pages{2}\n\\end\n`,
    'one.tex': '\\pages{4}\n\\pages{1}\n\\pages{2}\n',
    'two.tex': '\\pages{5}\n\\pages{2}\n',
});

describe.runIf(ready)('a run', () => {
    it('makes a PDF with the pages shipped out', () => {
        const out = plain(three);
        expect(pdfPages(out.get('main.pdf'))).toBe(19);
        expect(text(out.get('main.log'))).toContain('Output written on main.pdf (19 pages');
    });

    it('gives the same bytes when it pauses at every chance', () => {
        const want = plain(three);
        const run = new Run({ machine: machine(), job, project: three, snapshotEvery: 0 });
        expect(run.go()).toBe('done');
        expect(run.snapshots.length).toBeGreaterThan(19);
        expect(outputs(run.outputs())).toEqual(want);
    });

    it('goes on from any of its snapshots to the same bytes, in any order', () => {
        const want = plain(three);
        const m = machine();
        const run = new Run({ machine: m, job, project: three, snapshotEvery: 0 });
        run.go();
        // Backwards, so that a later resumption starts where an earlier one has already written its outputs past.
        for (const from of run.snapshots.toReversed()) {
            const again = new Run({ machine: m, job, project: three, from });
            expect(again.go()).toBe('done');
            expect(outputs(again.outputs())).toEqual(want);
        }
        const first = run.snapshots[0];
        const last = run.snapshots.at(-1);
        if (first === undefined || last === undefined) throw new Error('no snapshots');
        for (const from of [first, last, first]) {
            const again = new Run({ machine: m, job, project: three, from, snapshotEvery: 0 });
            again.go();
            expect(outputs(again.outputs())).toEqual(want);
        }
    });

    it('holds once a page is out, shows what it has, and goes on', () => {
        const want = plain(three);
        const m = machine();
        const run = new Run({ machine: m, job, project: three, snapshotEvery: 0 });
        expect(run.go({ untilPage: 7 })).toBe('held');
        expect(run.pages.at(-1)?.[0]).toBe(7);
        expect(pdfPages(run.preview().get('/project/main.pdf'))).toBe(7);
        expect(run.go({ untilPage: 12 })).toBe('held');
        expect(pdfPages(run.preview().get('/project/main.pdf'))).toBe(12);
        expect(run.go()).toBe('done');
        expect(outputs(run.outputs())).toEqual(want);
    });

    it('pauses when the time is up and goes on after another run used the machine', () => {
        const want = plain(three);
        const m = machine();
        let clock = 0;
        const run = new Run({ machine: m, job, project: three, now: () => clock++ });
        let pauses = 0;
        for (let stop = run.go({ deadline: clock + 4 }); stop !== 'done'; stop = run.go({ deadline: clock + 4 })) {
            expect(stop).toBe('paused');
            pauses++;
            if (pauses % 3 === 0) new Run({ machine: m, job, project: three }).go();
        }
        expect(pauses).toBeGreaterThan(3);
        expect(outputs(run.outputs())).toEqual(want);
    });
});

describe.runIf(ready)('a snapshot', () => {
    const m = ready ? machine() : null;
    const snapshots = (p: Project): Snapshot[] => {
        if (m === null) throw new Error('no engine');
        const run = new Run({ machine: m, job, project: p, snapshotEvery: 0 });
        run.go();
        return run.snapshots;
    };
    /** A run of `p` that goes on from the furthest of `from` that fits it. */
    const resumed = (from: Snapshot[], p: Project): { at: Snapshot | null; out: Map<string, Uint8Array> } => {
        if (m === null) throw new Error('no engine');
        const at = furthest(from, p);
        const run = new Run({ machine: m, job, project: p, ...(at === null ? {} : { from: at }) });
        run.go();
        return { at, out: outputs(run.outputs()) };
    };

    it('fits an edit after what the run had read, and no edit before', () => {
        const base = snapshots(three);
        const lines = ['\\pages{4}', '\\pages{1}', '\\pages{2}'];
        let before = -1;
        for (let line = 0; line < lines.length; line++) {
            const p = edited(three, 'one.tex', lines.map((l, i) => (i === line ? '\\pages{3}' : l)).join('\n') + '\n');
            const { at, out } = resumed(base, p);
            expect(out).toEqual(plain(p));
            // The later the edited line, the more of the first run is reused: 3 pages before one.tex, then its lines.
            expect(at?.pages).toBeGreaterThanOrEqual(3);
            expect(at?.pages ?? 0).toBeGreaterThan(before);
            before = at?.pages ?? 0;
        }
        const early = edited(three, 'main.tex', text(three.get('main.tex')).replace('\\pdfpagewidth=200pt', '\\pdfpagewidth=201pt'));
        const { at, out } = resumed(base, early);
        expect(at?.pages ?? 0).toBe(0);
        expect(out).toEqual(plain(early));
    });

    it('fits an edit of a file the run reads later, up to where it is read', () => {
        const base = snapshots(three);
        const p = edited(three, 'two.tex', '\\pages{1}\n');
        const { at, out } = resumed(base, p);
        expect(at?.pages).toBe(10);
        expect(out).toEqual(plain(p));
    });

    it('does not fit once a file the run found missing is there, or one it read is gone', () => {
        const asks = project({ 'main.tex': `${PREAMBLE}\\pages{2}\n\\openin1=extra \\ifeof1 \\pages{1}\\else \\pages{3}\\fi\n\\pages{2}\n\\end\n` });
        const base = snapshots(asks);
        const added = edited(asks, 'extra.tex', 'x\n');
        const { at, out } = resumed(base, added);
        expect(at?.pages).toBe(2);
        expect(pdfPages(out.get('main.pdf'))).toBe(7);
        expect(out).toEqual(plain(added));

        const removed: Project = new Map([...three].filter(([path]) => path !== 'two.tex'));
        const gone = furthest(snapshots(three), removed);
        expect(gone?.pages).toBe(10);
    });

    it('depends on the length of a file whose size the document asked for', () => {
        const sized = project({ 'main.tex': `${PREAMBLE}\\pages{2}\n\\total=\\pdffilesize{data.txt}\n\\pages{2}\n\\end\n`, 'data.txt': '12345' });
        const base = snapshots(sized);
        const same = edited(sized, 'data.txt', 'abcde');
        expect(furthest(base, same)?.pages).toBe(4);
        const longer = edited(sized, 'data.txt', '1234567');
        const { at, out } = resumed(base, longer);
        expect(at?.pages).toBe(2);
        expect(out).toEqual(plain(longer));
    });
});

describe.runIf(ready)('a session', () => {
    it('gives every edit the bytes of a run from the start, within its budget', () => {
        if (engine === null) throw new Error('no engine');
        const budget = 3 * 2 ** 20;
        const session = new Session({ module: engine, job, snapshotEvery: 0, budget, verify: true });
        let p = three;
        let reused = 0;
        for (let i = 0; i < 12; i++) {
            p = edited(p, 'two.tex', `\\pages{${1 + (i % 4)}}\n\\pages{2}\n`);
            const { pages } = session.edit(p);
            reused += pages;
            expect(session.advance({ untilPage: 12 })).toBe('held');
            expect(pdfPages(session.run.preview().get('/project/main.pdf'))).toBeGreaterThanOrEqual(12);
            if (i % 3 === 2) {
                expect(session.advance()).toBe('done');
                expect(outputs(session.run.outputs())).toEqual(plain(p));
            }
            expect(session.held).toBeLessThanOrEqual(budget + heldBytes([session.run.last?.memory ?? { chunks: [], size: 0 }]));
        }
        expect(reused).toBeGreaterThanOrEqual(11 * 10);
    });
});
