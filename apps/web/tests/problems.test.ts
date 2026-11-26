import { describe, expect, it } from 'vitest';
import { byFile, countProblems, mergeProblems, nextProblem, readable } from '#lib/problems/model.ts';
import { SETTLE_MS, settleDelay } from '#lib/session.svelte.ts';

const order = ['paper.tex', 'sections/intro.tex', 'sections/method.tex'];

describe('readable', () => {
    it('names the unknown command from where TeX stopped', () => {
        expect(readable('Undefined control sequence.', 'l.7 Feedback \\foo\n bar')).toEqual({ message: 'Unknown command \\foo' });
    });

    it('rewords the common TeX errors and leaves others alone', () => {
        expect(readable("LaTeX Error: File `tikzz.sty' not found.")?.message).toBe('tikzz.sty is not in TeX Live or the project');
        expect(readable('Missing $ inserted.')?.message).toMatch(/^Math outside/);
        expect(readable('Runaway argument?')?.message).toMatch(/not closed/);
        expect(readable('File ended while scanning use of \\textbf.')?.message).toMatch(/not closed/);
        expect(readable('Something else entirely.')).toBeNull();
    });

    it('makes undefined references and citations warnings and boxes notes', () => {
        expect(readable("Reference `fig:x' on page 1 undefined")).toEqual({ message: 'Undefined reference fig:x', severity: 'warning' });
        expect(readable("Citation `knuth' on page 2 undefined")).toEqual({ message: 'Undefined citation knuth', severity: 'warning' });
        expect(readable('Overfull \\hbox (12.5pt too wide)')?.severity).toBe('info');
    });
});

describe('mergeProblems', () => {
    it('orders errors, then warnings, then notes, by file order and line', () => {
        const list = mergeProblems(
            [
                {
                    source: 'build',
                    items: [
                        { file: 'sections/method.tex', line: 3, severity: 'warning', message: "Citation `x' on page 1 undefined" },
                        { file: 'sections/method.tex', line: 9, severity: 'error', message: 'Missing $ inserted.' },
                        { file: 'sections/intro.tex', line: 20, severity: 'error', message: 'Undefined control sequence.', excerpt: 'l.20 \\foo' },
                        { file: 'paper.tex', line: 1, severity: 'info', message: 'Overfull \\hbox (1pt too wide)' },
                    ],
                },
            ],
            order,
        );
        expect(list.map(p => `${p.severity} ${p.file}:${p.line}`)).toEqual([
            'error sections/intro.tex:20',
            'error sections/method.tex:9',
            'warning sections/method.tex:3',
            'info paper.tex:1',
        ]);
        expect(list[0]).toMatchObject({ message: 'Unknown command \\foo', raw: 'Undefined control sequence.', excerpt: 'l.20 \\foo', sources: ['build'] });
        expect(countProblems(list)).toEqual({ error: 2, warning: 1, info: 1 });
        expect(byFile(list).map(g => g.file)).toEqual(['sections/intro.tex', 'sections/method.tex', 'paper.tex']);
    });

    it('shows a problem the build and a language server both found once, with both sources and the column', () => {
        const list = mergeProblems([
            { source: 'build', items: [{ file: 'a.typ', line: 4, severity: 'error', message: 'unknown variable: foo' }] },
            { source: 'tinymist', items: [{ file: 'a.typ', line: 4, column: 7, severity: 'error', message: 'Unknown variable: foo.' }] },
        ]);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ sources: ['build', 'tinymist'], column: 7 });
    });

    it('keeps different problems on one line apart', () => {
        const list = mergeProblems([
            { source: 'build', items: [{ file: 'a.tex', line: 4, severity: 'error', message: 'Missing $ inserted.' }] },
            { source: 'texlab', items: [{ file: 'a.tex', line: 4, severity: 'warning', message: 'Unused label' }] },
        ]);
        expect(list).toHaveLength(2);
    });
});

describe('nextProblem', () => {
    const list = mergeProblems(
        [
            {
                source: 'build',
                items: [
                    { file: 'sections/intro.tex', line: 5, severity: 'error', message: 'A.' },
                    { file: 'sections/method.tex', line: 2, severity: 'warning', message: 'B on input line 2' },
                    { file: 'paper.tex', line: 30, severity: 'info', message: 'Overfull \\hbox (1pt too wide)' },
                ],
            },
        ],
        order,
    );

    it('goes to the next and previous problem in document order, wrapping and skipping notes', () => {
        expect(nextProblem(list, order, 'paper.tex', 1, 1)?.file).toBe('sections/intro.tex');
        expect(nextProblem(list, order, 'sections/intro.tex', 5, 1)?.file).toBe('sections/method.tex');
        expect(nextProblem(list, order, 'sections/method.tex', 2, 1)?.file).toBe('sections/intro.tex');
        expect(nextProblem(list, order, 'sections/intro.tex', 5, -1)?.file).toBe('sections/method.tex');
        expect(nextProblem([], order, 'paper.tex', 1, 1)).toBeNull();
    });
});

describe('settleDelay', () => {
    it('waits until typing has paused for a while, and not at all after a pause', () => {
        expect(settleDelay(1000, 1100)).toBe(SETTLE_MS - 100);
        expect(settleDelay(1000, 1000 + SETTLE_MS + 5)).toBe(0);
    });
});
