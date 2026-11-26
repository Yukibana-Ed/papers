import { describe, expect, it } from 'vitest';
import { definition, nameAt, references, rename, validName, type Place } from '#lib/latex/navigate.ts';

/** A repository with two documents: main.tex (with macros.tex, sections/, refs.bib) and other/paper.tex, and hard.tex
 *  with what a text scan gets wrong first: verbatim, labels with spaces, \\hyperref[…], lists over two lines. */
const raw: Record<string, string> = import.meta.glob('./fixtures/latex-navigation/**/*.{tex,bib}', { query: '?raw', eager: true, import: 'default' });
const files = new Map(Object.entries(raw).map(([path, text]) => [path.slice('./fixtures/latex-navigation/'.length), text]));

/** The offset of the `|` in `marked`, which without it occurs once in `file`. */
function cursor(file: string, marked: string): number {
    const text = files.get(file) ?? '';
    const at = text.indexOf(marked.replace('|', ''));
    expect(at, `${file}: ${marked}`).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(marked.replace('|', ''), at + 1), `${file}: ${marked} twice`).toBe(-1);
    return at + marked.indexOf('|');
}

/** Each place as `file:line`, sorted. */
const lines = (places: readonly Place[]): string[] => places.map(p => `${p.file}:${(files.get(p.file) ?? '').slice(0, p.start).split('\n').length}`).toSorted();
const texts = (places: readonly Place[]): string[] => places.map(p => (files.get(p.file) ?? '').slice(p.start, p.end));

interface Case {
    readonly op: 'definition' | 'references' | 'rename';
    readonly file: string;
    readonly at: string;
    readonly expect: readonly string[];
    /** For a rename: the text every place must hold. */
    readonly name?: string;
    readonly note: string;
}

const CASES: readonly Case[] = [
    { op: 'definition', file: 'main.tex', at: '\\cref{sec:me|thod,sec:intro}', expect: ['sections/method.tex:1'], note: 'label, first of a list' },
    { op: 'definition', file: 'main.tex', at: '\\cref{sec:method,sec:in|tro}', expect: ['sections/intro.tex:1'], note: 'label, second of a list' },
    { op: 'definition', file: 'main.tex', at: '\\eqref{eq:no|rm}', expect: ['sections/method.tex:2'], note: 'equation label' },
    { op: 'definition', file: 'main.tex', at: '\\ref{sec:results-ex|tra}', expect: ['main.tex:24'], note: 'label that extends another' },
    { op: 'definition', file: 'main.tex', at: '\\autoref{claim:ma|in}', expect: ['main.tex:20'], note: 'label in own environment' },
    { op: 'definition', file: 'main.tex', at: '\\cite{knu|th84}', expect: ['refs.bib:1'], note: 'citation' },
    { op: 'definition', file: 'sections/intro.tex', at: '\\textcite{becker2019, knu|th84}', expect: ['refs.bib:1'], note: 'citation, second of a list' },
    { op: 'definition', file: 'main.tex', at: '\\in \\R|$', expect: ['macros.tex:1'], note: 'own command' },
    { op: 'definition', file: 'main.tex', at: '$\\no|rm{x} \\geq', expect: ['macros.tex:2'], note: 'own command with argument' },
    { op: 'definition', file: 'sections/intro.tex', at: '\\arg|max$', expect: ['macros.tex:3'], note: 'DeclareMathOperator' },
    { op: 'definition', file: 'main.tex', at: '\\begin{cl|aim}', expect: ['macros.tex:5'], note: 'own environment' },
    { op: 'definition', file: 'sections/intro.tex', at: '\\begin{lem|ma}', expect: ['macros.tex:4'], note: 'newtheorem' },
    { op: 'definition', file: 'main.tex', at: '\\input{sections/me|thod}', expect: ['sections/method.tex:1'], note: 'included file' },
    { op: 'definition', file: 'main.tex', at: '\\addbibresource{re|fs.bib}', expect: ['refs.bib:1'], note: 'bibliography file' },
    {
        op: 'references',
        file: 'sections/method.tex',
        at: '\\label{sec:me|thod}',
        expect: ['sections/method.tex:1', 'main.tex:18', 'sections/intro.tex:3'],
        note: 'label across files',
    },
    { op: 'references', file: 'main.tex', at: '\\label{sec:res|ults}', expect: ['main.tex:17'], note: 'not the comment, not sec:results-extra' },
    { op: 'references', file: 'refs.bib', at: '@article{knu|th84', expect: ['refs.bib:1', 'main.tex:18', 'sections/intro.tex:2'], note: 'citation from the .bib' },
    { op: 'references', file: 'sections/intro.tex', at: '\\autocite{hat|tie2007}', expect: ['sections/intro.tex:2', 'refs.bib:12'], note: 'citation from a use' },
    {
        op: 'references',
        file: 'macros.tex',
        at: '{\\no|rm}[1]',
        expect: ['macros.tex:2', 'main.tex:21', 'sections/intro.tex:5', 'sections/intro.tex:5', 'sections/intro.tex:5', 'sections/method.tex:3'],
        note: 'own command',
    },
    { op: 'references', file: 'macros.tex', at: '{\\R|}{', expect: ['macros.tex:1', 'main.tex:21', 'sections/intro.tex:3'], note: 'own command, not \\Rightarrow' },
    { op: 'references', file: 'macros.tex', at: '\\newtheorem{lem|ma}', expect: ['macros.tex:4', 'sections/intro.tex:4', 'sections/intro.tex:6'], note: 'own environment' },
    {
        op: 'rename',
        file: 'main.tex',
        at: '\\cref{sec:me|thod,sec:intro}',
        name: 'sec:method',
        expect: ['sections/method.tex:1', 'main.tex:18', 'sections/intro.tex:3'],
        note: 'label',
    },
    { op: 'rename', file: 'main.tex', at: '\\label{sec:res|ults}', name: 'sec:results', expect: ['main.tex:17'], note: 'label with traps' },
    { op: 'rename', file: 'main.tex', at: '\\cite{knu|th84}', name: 'knuth84', expect: ['refs.bib:1', 'main.tex:18', 'sections/intro.tex:2'], note: 'citation, the .bib too' },
    {
        op: 'rename',
        file: 'sections/method.tex',
        at: '\\no|rm{x} = ',
        name: 'norm',
        expect: ['macros.tex:2', 'main.tex:21', 'sections/intro.tex:5', 'sections/intro.tex:5', 'sections/intro.tex:5', 'sections/method.tex:3'],
        note: 'own command',
    },
    { op: 'rename', file: 'main.tex', at: '\\in \\R|$', name: 'R', expect: ['macros.tex:1', 'main.tex:21', 'sections/intro.tex:3'], note: 'own command, not \\Rightarrow' },
    { op: 'rename', file: 'main.tex', at: '\\begin{cl|aim}', name: 'claim', expect: ['macros.tex:5', 'main.tex:20', 'main.tex:22'], note: 'own environment with its definition' },
    {
        op: 'rename',
        file: 'sections/method.tex',
        at: '\\begin{equ|ation}',
        name: 'equation',
        expect: ['sections/method.tex:2', 'sections/method.tex:4'],
        note: 'a \\begin with its \\end',
    },
    {
        op: 'rename',
        file: 'sections/intro.tex',
        at: '\\begin{lem|ma}',
        name: 'lemma',
        expect: ['macros.tex:4', 'sections/intro.tex:4', 'sections/intro.tex:6'],
        note: 'newtheorem environment',
    },
    {
        op: 'references',
        file: 'hard.tex',
        at: '\\label{sec:a| b}',
        expect: ['hard.tex:6', 'hard.tex:11', 'hard.tex:11', 'hard.tex:12'],
        note: 'label with a space, \\hyperref[…], a list over two lines',
    },
    {
        op: 'references',
        file: 'hard.tex',
        at: '\\label{fig:in-ca|ption}',
        expect: ['hard.tex:7', 'hard.tex:11', 'hard.tex:13'],
        note: 'label in a caption, used in an optional argument, not in verbatim',
    },
    {
        op: 'references',
        file: 'hard.tex',
        at: '\\newcommand*\\ve|ct',
        expect: ['hard.tex:2', 'hard.tex:14', 'hard.tex:14'],
        note: '\\newcommand*\\name, not in verbatim or \\verb',
    },
    { op: 'references', file: 'hard.tex', at: '\\def\\ha|lf', expect: ['hard.tex:3', 'hard.tex:14'], note: '\\def, not in \\lstinline' },
    { op: 'definition', file: 'hard.tex', at: '\\ve|ct {w}', expect: ['hard.tex:2'], note: '\\newcommand*\\name' },
    { op: 'definition', file: 'hard.tex', at: '{lam|port94}', expect: ['hard.bib:1'], note: 'citation with two optional arguments' },
    { op: 'rename', file: 'hard.tex', at: '\\ref{ sec:a| b }', name: 'sec:a b', expect: ['hard.tex:6', 'hard.tex:11', 'hard.tex:11', 'hard.tex:12'], note: 'label with a space' },
    {
        op: 'references',
        file: 'other/paper.tex',
        at: '\\label{sec:in|tro}',
        expect: ['other/paper.tex:3', 'other/paper.tex:3'],
        note: 'a second document in the repository with the same label',
    },
    {
        op: 'rename',
        file: 'sections/intro.tex',
        at: '\\label{sec:in|tro}',
        name: 'sec:intro',
        expect: ['sections/intro.tex:1', 'main.tex:18', 'sections/method.tex:5'],
        note: 'rename must not touch the other document',
    },
];

describe('LaTeX navigation', () => {
    for (const op of ['definition', 'references', 'rename'] as const) {
        describe(op, () => {
            for (const c of CASES.filter(x => x.op === op)) {
                it(c.note, () => {
                    const found = { definition, references, rename }[op](files, c.file, cursor(c.file, c.at));
                    expect(lines(found)).toEqual(c.expect.toSorted());
                    if (c.name !== undefined) expect(new Set(texts(found))).toEqual(new Set([c.name]));
                });
            }
        });
    }

    it('names what is at a position', () => {
        expect(nameAt(files, 'main.tex', cursor('main.tex', '\\cref{sec:me|thod,sec:intro}'))).toMatchObject({ kind: 'label', name: 'sec:method' });
        expect(nameAt(files, 'main.tex', cursor('main.tex', '\\in \\R|$'))).toMatchObject({ kind: 'command', name: 'R' });
        expect(nameAt(files, 'main.tex', cursor('main.tex', 'Feedback at the ri|ght time'))).toBeNull();
    });

    it('gives nothing for a command the project does not define', () => {
        expect(references(files, 'main.tex', cursor('main.tex', '\\make|title'))).toEqual([]);
        expect(definition(files, 'main.tex', cursor('main.tex', '\\make|title'))).toEqual([]);
    });

    it('knows which names can be written', () => {
        expect(validName('label', 'sec:new one')).toBe(true);
        expect(validName('label', 'a}b')).toBe(false);
        expect(validName('label', '')).toBe(false);
        expect(validName('citation', 'knuth:84')).toBe(true);
        expect(validName('citation', 'a,b')).toBe(false);
        expect(validName('command', 'vect')).toBe(true);
        expect(validName('command', 'vect2')).toBe(false);
        expect(validName('environment', 'claim*')).toBe(true);
    });
});
