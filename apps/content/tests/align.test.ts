import { describe, expect, it } from 'vitest';
import { align, keyOf, latexTokens, typstTokens } from '#lib/align.ts';

const words = (tokens: readonly { key: string }[]): string[] => tokens.map(t => t.key);
/** The source text a token covers. */
const spans = (source: string, tokens: readonly { line: number; start: number; end: number }[]): string[] =>
    tokens.map(t => (source.split('\n')[t.line - 1] ?? '').slice(t.start, t.end));

describe('keyOf', () => {
    it('ignores case, accents and ligature characters', () => {
        expect(keyOf('Éléve')).toBe('eleve');
        expect(keyOf('ﬁnd')).toBe('find');
        expect(keyOf("don't")).toBe('dont');
    });
});

describe('latexTokens', () => {
    it('keeps prose with its columns and drops commands, comments and hidden arguments', () => {
        const src = 'Learning to \\emph{program} is hard~\\cite{knuth84}. % not this\n\\section{Intro}\\label{sec:intro}';
        const t = latexTokens(src);
        expect(words(t)).toEqual(['learning', 'to', 'program', 'is', 'hard', 'intro']);
        expect(spans(src, t)).toEqual(['Learning', 'to', 'program', 'is', 'hard', 'Intro']);
        expect(t.at(-1)?.line).toBe(2);
    });

    it('keeps an accent macro inside its word, as one inexact token', () => {
        const src = 'Erd\\H{o}s and G\\"odel met Pal\\\'{e}';
        const t = latexTokens(src);
        expect(words(t)).toEqual(['erdos', 'and', 'godel', 'met', 'pale']);
        expect(t[0]).toMatchObject({ start: 0, end: 9, exact: false });
        expect(t[1]?.exact).toBe(true);
    });

    it('drops environment names, references, file names and lengths but keeps maths', () => {
        const src = '\\begin{itemize}\\item see Fig.~\\ref{f} and \\includegraphics[width=3cm]{plot.pdf} $t_{pass}$\\vspace{2em}';
        expect(words(latexTokens(src))).toEqual(['see', 'fig', 'and', 't', 'pass']);
    });

    it('keeps the text argument of \\href but not its address', () => {
        expect(words(latexTokens('\\href{https://example.org}{our site}'))).toEqual(['our', 'site']);
    });
});

describe('typstTokens', () => {
    it('keeps markup and content blocks, drops code, labels, references and comments', () => {
        const src = '#set text(font: "Libertinus Serif")\n= Summary <sum>\n#align(center)[*Instant Feedback*] see @fig // note\n#emph[quick] text';
        const t = typstTokens(src);
        expect(words(t)).toEqual(['summary', 'instant', 'feedback', 'see', 'quick', 'text']);
        expect(spans(src, t)).toEqual(['Summary', 'Instant', 'Feedback', 'see', 'quick', 'text']);
    });

    it('drops a code call whose arguments hold no content block', () => {
        expect(words(typstTokens('#image("plot.png", width: 50%) after'))).toEqual(['after']);
    });
});

describe('align', () => {
    const k = (s: string): { key: string }[] => s.split(' ').map(key => ({ key }));

    it('pairs the common subsequence in order', () => {
        expect(align(k('a b c d'), k('a b x c d'))).toEqual([
            [0, 0],
            [1, 1],
            [2, 3],
            [3, 4],
        ]);
    });

    it('drops a lone match of a common word that no neighbour confirms', () => {
        // "the" twice on the document side, and nothing around it agrees.
        expect(align(k('x the y'), k('p the q the r'))).toEqual([]);
    });

    it('keeps a lone match of a word that appears once on each side', () => {
        expect(align(k('x feedback y'), k('p feedback q'))).toEqual([[1, 1]]);
    });

    it('is empty when either side is', () => {
        expect(align([], k('a'))).toEqual([]);
        expect(align(k('a'), [])).toEqual([]);
    });
});
