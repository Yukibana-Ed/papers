import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLog, unwrap } from '../src/log.ts';

const fixture = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('parseLog', () => {
    it('reads a real pdfTeX log: errors with their files, warnings in the file being read, pages', () => {
        const s = parseLog(fixture('errors.log'), 'c:/tex/work/logs/a');
        const brief = s.diagnostics.map(d => `${d.severity} ${d.file}:${d.line} ${d.message}`);
        expect(brief).toEqual([
            'error sec.tex:2 Undefined control sequence.',
            "warning main.tex:4 Citation `x' on page 1 undefined",
            "warning main.tex:4 Reference `nolabel' on page 1 undefined",
            'error main.tex:5 Undefined control sequence.',
            'info main.tex:6 Overfull \\hbox (221.11133pt too wide)',
            'warning main.tex:null There were undefined references.',
        ]);
        expect(s.pages).toBe(1);
        expect(s.undefinedReferences).toBe(true);
        expect(s.rerun).toBe(false);
    });

    it('reads a missing package, a rerun request and a package warning that continues', () => {
        const log = [
            '(./paper.tex',
            "./paper.tex:3: LaTeX Error: File `nopkg.sty' not found.",
            '',
            '(/texmf/tex/latex/hyperref/hyperref.sty',
            'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
            "(hyperref)                removing `math shift' on input line 12.",
            ')',
            'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
            ')',
            'Output written on paper.pdf (12 pages, 1234 bytes).',
        ].join('\n');
        const s = parseLog(log);
        expect(s.diagnostics[0]).toEqual({ file: 'paper.tex', line: 3, severity: 'error', message: "File `nopkg.sty' not found." });
        expect(s.diagnostics[1]).toEqual({ file: null, line: 12, severity: 'warning', message: "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift'" });
        expect(s.diagnostics[2]?.file).toBe('paper.tex');
        expect(s.rerun).toBe(true);
        expect(s.pages).toBe(12);
    });

    it('takes the line of a "!" error from l.N', () => {
        const s = parseLog('(./a.tex\n! Missing $ inserted.\n<inserted text>\n                $\nl.7 x^\n');
        expect(s.diagnostics).toEqual([{ file: 'a.tex', line: 7, severity: 'error', message: 'Missing $ inserted.' }]);
    });

    it('joins lines TeX wrapped at 79 characters', () => {
        const long = 'x'.repeat(79);
        expect(unwrap(`${long}\nyz\nnext`)).toEqual([`${long}yz`, 'next']);
    });
});
