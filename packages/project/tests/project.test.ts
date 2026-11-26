import { describe, expect, it } from 'vitest';
import { ConfigError, formatLock, memoryFiles, outline, parseConfig, parseLock, readProject } from '../src/index.ts';

const PAPER = {
    'paper.tex': String.raw`% !TEX program = pdflatex
\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\graphicspath{{figures/}}
\begin{document}
\input{sections/intro}
\section{Results}
\includegraphics{plot}
\includegraphics{missing}
\printbibliography
\end{document}
`,
    'sections/intro.tex': '\\section{Introduction}\n% \\input{commented}\n\\subsection{The \\emph{why}}\n',
    'refs.bib': '@book{a, title={A}}\n',
    'figures/plot.pdf': '%PDF',
    'slides.tex': '\\documentclass{beamer}\n\\usepackage{fontspec}\n',
    'notes/draft.tex': 'not a root',
};

describe('readProject', () => {
    it('finds the documents and what they read', () => {
        const p = readProject(memoryFiles(PAPER));
        expect(p.declared).toBe(false);
        expect(p.environment).toEqual({ kind: 'managed', texlive: '2026', packages: [] });
        expect(p.documents.map(d => d.root)).toEqual(['paper.tex', 'slides.tex']);
        const paper = p.documents[0];
        expect(paper?.inputs).toEqual(['paper.tex', 'refs.bib', 'sections/intro.tex', 'figures/plot.pdf']);
        expect(paper?.missing).toEqual(['missing']);
        expect(paper).toMatchObject({ engine: 'pdflatex', bibliography: 'biber', index: 'none' });
        expect(p.documents[1]?.engine).toBe('xelatex');
    });

    it('applies the declaration and checks the lock against it', () => {
        const files = { ...PAPER, 'papers.toml': '[environment]\ntexlive = "2025"\n\n[[document]]\nroot = "paper.tex"\nengine = "lualatex"\n' };
        const p = readProject(memoryFiles(files));
        expect(p.documents).toHaveLength(1);
        expect(p.documents[0]?.engine).toBe('lualatex');
        const lock = formatLock({ version: 1, texlive: { year: '2026', snapshot: 'a'.repeat(64) } });
        expect(() => readProject(memoryFiles({ ...files, 'papers.lock': lock }))).toThrow(/pins 2026/);
    });

    it('reads the outline in reading order', () => {
        const p = readProject(memoryFiles(PAPER));
        const doc = p.documents[0];
        if (!doc) throw new Error('no document');
        expect(outline(p.files, doc).map(h => `${h.level}:${h.title}@${h.file}:${h.line}`)).toEqual([
            'section:Introduction@sections/intro.tex:1',
            'subsection:The why@sections/intro.tex:3',
            'section:Results@paper.tex:8',
        ]);
    });
});

describe('parseConfig', () => {
    it('reads every kind of environment', () => {
        expect(parseConfig('[environment]\nkind = "system"\n').environment).toEqual({ kind: 'system' });
        expect(parseConfig('[environment]\nkind = "nix"\nflake = "github:o/r#paper"\n').environment).toEqual({ kind: 'nix', flake: 'github:o/r#paper' });
        expect(parseConfig(`[environment]\nkind = "oci"\nimage = "ghcr.io/o/tex@sha256:${'0'.repeat(64)}"\n`).environment.kind).toBe('oci');
    });

    it('refuses what it does not understand', () => {
        expect(() => parseConfig('[environment]\nkind = "docker"\n')).toThrow(ConfigError);
        expect(() => parseConfig('[environment]\nkind = "oci"\nimage = "ghcr.io/o/tex:latest"\n')).toThrow(/digest/);
        expect(() => parseConfig('[enviroment]\n')).toThrow(/unknown key/);
        expect(() => parseConfig('[[document]]\nroot = "../x.tex"\n')).toThrow(/inside the project/);
        expect(() => parseConfig('[[document]]\nroot = "a.tex"\nengine = "tectonic"\n')).toThrow(/engine/);
        expect(() => parseConfig('[environment]\nkind = "system"\ntexlive = "2026"\n')).toThrow(/not allowed/);
    });
});

describe('parseLock', () => {
    it('round-trips', () => {
        const lock = { version: 1, texlive: { year: '2026', snapshot: 'b'.repeat(64) } } as const;
        expect(parseLock(formatLock(lock))).toEqual(lock);
        expect(() => parseLock('{"version":2}')).toThrow();
    });
});
