import { describe, expect, it } from 'vitest';
import { FILES, FILE_ORDER } from '#lib/demo/project.ts';
import { findRoots, includedFiles, outline, plainTitle, stripComments } from '#lib/model/tex.ts';

describe('tex', () => {
    it('finds the documents', () => {
        expect(findRoots(FILES, FILE_ORDER)).toEqual(['paper.tex', 'slides.tex']);
        expect(findRoots({ 'a.tex': '% \\documentclass{article}' })).toEqual([]);
    });

    it('follows includes and the bibliography', () => {
        expect(includedFiles('paper.tex', FILES)).toEqual(['paper.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'refs.bib']);
    });

    it('numbers the outline across files', () => {
        const h = outline('paper.tex', FILES);
        expect(h.map(x => `${x.num} ${x.title}`)).toEqual(['1 Introduction', '1.1 Contributions', '2 Method', '2.1 Measures', '3 Results', '3.1 Threats to validity']);
        expect(h[2]).toMatchObject({ file: 'sections/method.tex', line: 1 });
    });

    it('keeps escaped percent signs', () => {
        expect(stripComments('18\\% of % a comment')).toBe('18\\% of ');
    });

    it('reduces markup in titles', () => {
        expect(plainTitle('The \\emph{power} of~feedback')).toBe('The power of feedback');
    });
});
