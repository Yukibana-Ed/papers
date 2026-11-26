import { describe, expect, it } from 'vitest';
import { LatexIndex, complete, factsOf } from '#lib/latex/complete.ts';

const BIB = `@article{knuth84,
  author = {Knuth, Donald E. and Someone Else},
  title = {Literate {P}rogramming},
  year = 1984,
}
@string{x = "y"}
@inproceedings{becker2019, author = "Brett A. Becker", title = "Compiler Error Messages", year = {2019}}
`;

function index(): LatexIndex {
    const i = new LatexIndex();
    i.update(
        'main.tex',
        String.raw`\documentclass{article}
\newcommand{\tool}[1]{Q #1}
\newenvironment{claim}{}{}
\section{Intro}\label{sec:intro} % \label{commented}
`,
    );
    i.update('chapters/one.tex', String.raw`\begin{equation}\label{eq:one} x \end{equation}`);
    i.update('refs.bib', BIB);
    i.setPaths(['main.tex', 'chapters/one.tex', 'refs.bib', 'figures/plot.pdf', 'figures/photo.jpg', 'README.md']);
    return i;
}

const labels = (r: ReturnType<typeof complete>): string[] => r?.offers.map(o => o.label) ?? [];

describe('factsOf', () => {
    it('reads bibliography entries with their first author, year and title', () => {
        expect(factsOf('refs.bib', BIB).bib).toEqual([
            { key: 'knuth84', author: 'Knuth', authors: ['Knuth', 'Else'], others: false, year: '1984', title: 'Literate Programming' },
            { key: 'becker2019', author: 'Becker', authors: ['Becker'], others: false, year: '2019', title: 'Compiler Error Messages' },
        ]);
    });

    it('reads labels and definitions, not those in comments', () => {
        const f = factsOf(
            'main.tex',
            String.raw`\label{a} % \label{b}
\newcommand*{\foo}[2]{x}
\DeclareMathOperator{\argmax}{arg\,max}`,
        );
        expect(f.labels).toEqual(['a']);
        expect(f.commands).toEqual([
            { name: 'foo', args: 2 },
            { name: 'argmax', args: 0 },
        ]);
    });
});

describe('complete', () => {
    it('offers commands after a backslash, the project’s first', () => {
        const r = complete(String.raw`Some \to`, '', index(), 'main.tex');
        expect(r?.start).toBe(6);
        expect(labels(r)[0]).toBe(String.raw`\tool`);
        expect(labels(r)).toContain(String.raw`\textbf`);
        expect(r?.offers.find(o => o.label === String.raw`\textbf`)?.insert).toBe('textbf{$1}');
    });

    it('offers whole environments after a backslash, after the commands', () => {
        const r = complete(String.raw`\it`, '', index(), 'main.tex');
        const itemize = r?.offers.find(o => o.label === String.raw`\begin{itemize}`);
        expect(itemize).toEqual({ label: String.raw`\begin{itemize}`, insert: 'begin{itemize}\n\t\\item $0\n\\end{itemize}', kind: 'snippet', detail: '' });
        expect(labels(r).indexOf(String.raw`\item`)).toBeLessThan(labels(r).indexOf(String.raw`\begin{itemize}`));
        // The project's own environments too.
        expect(labels(r)).toContain(String.raw`\begin{claim}`);
        const figure = r?.offers.find(o => o.label === String.raw`\begin{figure}`)?.insert ?? '';
        expect(figure).toContain('\\includegraphics[width=${2:\\linewidth}]{$3}');
        expect(figure.endsWith(String.raw`\end{figure}`)).toBe(true);
    });

    it('puts the commands and environments of loaded packages before those of the others', () => {
        const i = index();
        i.update(
            'pre.tex',
            String.raw`\usepackage[capitalise]{cleveref}
\usepackage{mathtools, pgfplots} % \usepackage{natbib}`,
        );
        expect([...i.loaded()].toSorted()).toEqual(['amsmath', 'article', 'cleveref', 'graphicx', 'mathtools', 'pgfplots', 'tikz', 'xcolor']);
        const r = complete(String.raw`\c`, '', i, 'main.tex');
        const at = (label: string): number => labels(r).indexOf(label);
        // Kernel, then loaded (mathtools loads amsmath), then the rest, which say where they come from.
        expect(at(String.raw`\cite`)).toBeLessThan(at(String.raw`\cref`));
        expect(at(String.raw`\cref`)).toBeLessThan(at(String.raw`\citep`));
        expect(at(String.raw`\cfrac`)).toBeLessThan(at(String.raw`\citep`));
        expect(r?.offers.find(o => o.label === String.raw`\citep`)?.detail).toBe('natbib');
        expect(at(String.raw`\begin{axis}`)).toBeLessThan(at(String.raw`\begin{frame}`));
        const b = complete(String.raw`\begin{`, '', i, 'main.tex');
        expect(labels(b).indexOf('align')).toBeLessThan(labels(b).indexOf('lstlisting'));
        expect(b?.offers.find(o => o.label === 'lstlisting')?.detail).toBe('listings');
        expect(new Set(labels(r)).size).toBe(labels(r).length);
    });

    it('offers environments after \\begin{, with their \\end, and the open one after \\end{', () => {
        const begin = complete(String.raw`\begin{it`, '', index(), 'main.tex');
        expect(labels(begin)).toContain('itemize');
        expect(labels(begin)).toContain('claim');
        expect(begin?.offers.find(o => o.label === 'itemize')?.insert).toBe('itemize}\n\t\\item $0\n\\end{itemize}');
        expect(begin?.offers.find(o => o.label === 'claim')?.insert).toBe('claim}\n\t$0\n\\end{claim}');
        // Editing an existing \begin{…}: the name only.
        expect(complete(String.raw`\begin{it`, '}', index(), 'main.tex')?.offers.find(o => o.label === 'itemize')?.insert).toBe('itemize');
        expect(labels(complete(String.raw`\begin{proof} text \end{`, '', index(), 'main.tex'))[0]).toBe('proof');
    });

    it('offers labels from every file for \\ref, \\eqref and \\cref', () => {
        for (const cmd of ['ref', 'eqref', 'cref', 'autoref']) expect(labels(complete(`see \\${cmd}{`, '}', index(), 'main.tex'))).toEqual(['sec:intro', 'eq:one']);
    });

    it('offers bibliography keys for the \\cite family, the item after the last comma', () => {
        const before = String.raw`\citep[p.~3]{knuth84, bec`;
        const r = complete(before, '}', index(), 'main.tex');
        expect(labels(r)).toEqual(['knuth84', 'becker2019']);
        expect(r?.start).toBe(before.length - 'bec'.length);
        expect(r?.offers[0]?.detail).toBe('Knuth and Else · 1984 · Literate Programming');
        // Found by any author, the year and the title, not only by the key.
        expect(r?.offers[0]?.filter).toBe('knuth84 Knuth Else 1984 Literate Programming');
        const others = new LatexIndex();
        others.update('r.bib', '@book{b, author = {Becker, Brett A. and others}, title = {T}, year = 2019}');
        expect(complete(String.raw`\cite{`, '', others, 'main.tex')?.offers[0]?.detail).toBe('Becker et al. · 2019 · T');
    });

    it('offers packages, classes and paths', () => {
        expect(labels(complete(String.raw`\usepackage{amsmath,gra`, '}', index(), 'main.tex'))).toContain('graphicx');
        expect(labels(complete(String.raw`\documentclass[11pt]{`, '}', index(), 'main.tex'))).toContain('article');
        expect(labels(complete(String.raw`\includegraphics[width=3cm]{`, '}', index(), 'main.tex'))).toEqual(['figures/plot.pdf', 'figures/photo.jpg']);
        expect(labels(complete(String.raw`\input{`, '}', index(), 'main.tex'))).toEqual(['chapters/one.tex']);
        expect(labels(complete(String.raw`\include{`, '}', index(), 'main.tex'))).toEqual(['chapters/one']);
        expect(labels(complete(String.raw`\bibliography{`, '}', index(), 'main.tex'))).toEqual(['refs']);
    });

    it('offers nothing in plain text', () => {
        expect(complete('Just words', '', index(), 'main.tex')).toBeNull();
    });

    it('answers within a few milliseconds for a large project', () => {
        const i = new LatexIndex();
        const chapter = Array.from({ length: 2000 }, (_, k) => `Text \\label{l${k}} and \\cite{k${k}}.`).join('\n');
        for (let c = 0; c < 20; c++) i.update(`ch${c}.tex`, chapter);
        i.update('big.bib', Array.from({ length: 3000 }, (_, k) => `@article{k${k}, author={A${k}}, title={T${k}}, year={2000}}`).join('\n'));
        const t0 = performance.now();
        for (let n = 0; n < 10; n++) {
            complete(String.raw`\ref{`, '}', i, 'ch0.tex');
            complete(String.raw`\cite{`, '}', i, 'ch0.tex');
        }
        expect((performance.now() - t0) / 20).toBeLessThan(50);
    });
});
