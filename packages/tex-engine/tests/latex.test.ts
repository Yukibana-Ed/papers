import { describe, expect, it } from 'vitest';
import { Latex, Machine, Run, type LatexResult, type Project } from '../src/index.ts';
import { bibtex, edited, engine, job, pdfPages, PREAMBLE, project, text, tree } from './support.ts';

/** A format of the tests' set-up, made by the engine. */
function format(): Uint8Array {
    if (engine === null) throw new Error('no engine');
    const run = new Run({ machine: new Machine(engine), job, project: project({ 'main.tex': `${PREAMBLE}\\dump\n` }) });
    expect(run.go()).toBe('done');
    const made = run.outputs().get('/project/main.fmt');
    if (made === undefined) throw new Error(text(run.outputs().get('/project/main.log')));
    return made.slice();
}

/** A document that asks for a bibliography as LaTeX does, in its .aux, and reads the .bbl when it is there. */
const MAIN = String.raw`\immediate\openout3=main.aux
\immediate\write3{\string\citation{a}}\immediate\write3{\string\bibdata{refs}}\immediate\write3{\string\bibstyle{min}}
\immediate\closeout3
\pages{2}
\openin4=main.bbl \ifeof4 \else \closein4 \input main.bbl \fi
\end
`;
/** A style that writes each entry's title. */
const STYLE = 'ENTRY { title } { } { }\nFUNCTION {article} { title write$ newline$ }\nREAD\nITERATE {call.type$}\n';
const bib = (pages: number): string => `@article{a, title = {\\pages{${pages}}}}\n`;
const sources = project({ 'main.tex': MAIN, 'min.bst': STYLE, 'refs.bib': bib(1) });

function settle(latex: Latex): LatexResult {
    while (latex.working) latex.work(Infinity);
    if (latex.result === null) throw new Error('no pass finished');
    return latex.result;
}

describe.runIf(engine !== null)('a format', () => {
    it('is loaded as it was dumped', () => {
        if (engine === null) throw new Error('no engine');
        const fmt = format();
        // The format is gzip's: its last eight bytes are the checksum and the length of what it holds.
        expect(fmt.subarray(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
        const p = project({ 'doc.tex': '\\pages{3}\\end\n' });
        const run = new Run({
            machine: new Machine(engine),
            job: { ...job, args: ['/bin/pdftex', '-fmt=main', '-interaction=batchmode', 'doc.tex'] },
            project: new Map([...p, ['main.fmt', fmt]]),
        });
        expect(run.go()).toBe('done');
        expect(text(run.outputs().get('/project/doc.log'))).toContain('Output written on doc.pdf (3 pages');
    });
});

describe.runIf(engine !== null && bibtex !== null)('a LaTeX document', () => {
    const latex = (): Latex => {
        if (engine === null) throw new Error('no engine');
        return new Latex({ pdftex: engine, bibtex, tree: tree({ '/fmt/test.fmt': format() }), program: '/bin/pdftex', format: 'test', time: job.time, zone: 0 });
    };
    const built = (s: Project): LatexResult => {
        const l = latex();
        l.set(s, 'main.tex');
        return settle(l);
    };

    it('gets its bibliography from BibTeX and a pass that reads it', () => {
        const r = built(sources);
        expect(r.ok).toBe(true);
        expect(r.settled).toBe(true);
        expect(r.pass).toBe(2);
        expect(r.bibtexLog).toContain('min.bst');
        expect(pdfPages(r.pdf ?? undefined)).toBe(3);
    });

    it('is, after edits, what a build from nothing makes', () => {
        const l = latex();
        l.set(sources, 'main.tex');
        settle(l);
        // The bibliography's database changes: BibTeX again, and a pass that reads its new .bbl.
        const second = edited(sources, 'refs.bib', bib(4));
        l.set(second, 'main.tex');
        const afterBib = settle(l);
        expect(pdfPages(afterBib.pdf ?? undefined)).toBe(6);
        expect(afterBib.pdf).toEqual(built(second).pdf);
        // The text changes after everything it reads: one pass, from a snapshot, settles it.
        const third = edited(second, 'main.tex', MAIN.replace('\\end', '\\pages{1}\\end'));
        l.set(third, 'main.tex');
        const afterText = settle(l);
        expect(afterText.pass).toBe(1);
        expect(afterText.pdf).toEqual(built(third).pdf);
        expect(afterText.log).toBe(built(third).log);
    });

    it('takes the bibliography the project brings when what it was made from is not there', () => {
        const brought = new Map([...sources, ['main.bbl', new TextEncoder().encode('\\pages{7}\n')]]);
        brought.delete('refs.bib');
        const r = built(brought);
        expect(r.bibtexLog).toContain("I couldn't open database file");
        expect(r.pass).toBe(1);
        expect(pdfPages(r.pdf ?? undefined)).toBe(9);
    });

    it('makes the bibliography again from a database the project has, whatever .bbl the project brings', () => {
        const r = built(new Map([...sources, ['main.bbl', new TextEncoder().encode('\\pages{7}\n')]]));
        const fresh = built(sources);
        expect(r.pass).toBe(2);
        expect(r.pdf).toEqual(fresh.pdf);
        expect(pdfPages(r.pdf ?? undefined)).not.toBe(9);
    });

    it('reads what a pass wrote in place of a file of that path the project brings, until that file changes', () => {
        // An .aux left in the project by a build elsewhere: the first pass reads it, the later ones their own.
        const stale = new TextEncoder().encode('\\relax\n');
        const r = built(new Map([...sources, ['main.aux', stale]]));
        const fresh = built(sources);
        expect(r.settled).toBe(true);
        expect(r.pdf).toEqual(fresh.pdf);
        expect(r.log).toBe(fresh.log);
    });
});
