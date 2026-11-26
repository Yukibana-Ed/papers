import { describe, expect, it } from 'vitest';
import { parseTexLog } from '#lib/texlog.ts';

const project = new Set(['paper.tex', 'sections/intro.tex', 'sections/method.tex']);
const isProject = (p: string): boolean => project.has(p);

describe('parseTexLog', () => {
    it('finds an error and its line in the file being read', () => {
        const log = [
            'This is pdfTeX, Version 3.141592653',
            '(./paper.tex (/texmf-dist/tex/latex/base/article.cls (/texmf-dist/tex/latex/base/size11.clo))',
            '(./sections/intro.tex',
            '! Undefined control sequence.',
            'l.7 Feedback \\foo',
            '                 bar',
            ')',
        ].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)).toEqual([
            { file: 'sections/intro.tex', line: 7, severity: 'error', message: 'Undefined control sequence.', excerpt: 'l.7 Feedback \\foo\n                 bar' },
        ]);
    });

    it('attributes an error inside a package to the project file that loaded it', () => {
        const log = ['(./paper.tex (/texmf-dist/tex/latex/amsmath/amsmath.sty', '! LaTeX Error: Something.', 'l.12 \\usepackage{amsmath}', '))'].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)[0]).toMatchObject({ file: 'paper.tex', line: 12 });
    });

    it('is not misled by parentheses in messages', () => {
        const log = ['(./paper.tex (./sections/method.tex', 'Overfull \\hbox (2.0pt too wide) in paragraph', '! Missing $ inserted.', 'l.3 x_', '))'].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)[0]).toMatchObject({ file: 'sections/method.tex', line: 3 });
    });

    it('reads warnings with an input line, joined across continuation lines', () => {
        const log = [
            '(./paper.tex',
            "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 20.",
            'Package natbib Warning: Citation `knuth` on page 1 undefined',
            '(natbib)                on input line 22.',
            ')',
        ].join('\n');
        const d = parseTexLog(log, 'paper.tex', isProject);
        expect(d).toEqual([
            { file: 'paper.tex', line: 20, severity: 'warning', message: "Reference `fig:x' on page 1 undefined" },
            { file: 'paper.tex', line: 22, severity: 'warning', message: 'Citation `knuth` on page 1 undefined' },
        ]);
    });

    it('reads file:line:error messages and joins wrapped lines', () => {
        const long = './sections/intro.tex:4: Undefined control sequence and a long message that TeX wraps at s';
        const log = [long.slice(0, 79), long.slice(79)].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)).toEqual([{ file: 'sections/intro.tex', line: 4, severity: 'error', message: long.slice(long.indexOf(': ') + 2) }]);
    });

    it("drops TeX's fatal-error sign-off after a real error", () => {
        const log = ['(./paper.tex', '! Undefined control sequence.', 'l.3 \\foo', '! ==> Fatal error occurred, no output PDF file produced!', ')'].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)).toHaveLength(1);
    });

    it('reports a repeated message once', () => {
        const log = ['(./paper.tex', '! Oops.', 'l.2 a', '! Oops.', 'l.2 a', ')'].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)).toHaveLength(1);
    });

    it('reports over- and underfull boxes as notes, with the paragraph they span', () => {
        const log = ['(./paper.tex (./sections/method.tex', 'Overfull \\hbox (12.5pt too wide) in paragraph at lines 5--9', '[]\\T1/lmr/m/n/10.95 Some text', '))'].join('\n');
        expect(parseTexLog(log, 'paper.tex', isProject)).toEqual([
            { file: 'sections/method.tex', line: 5, endLine: 9, severity: 'info', message: 'Overfull \\hbox (12.5pt too wide)' },
        ]);
    });
});
