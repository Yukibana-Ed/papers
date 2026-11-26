import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryFiles, readProject } from '@yukibana/papers-project';
import { buildDocument, forwardSearch, inverseSearch, nativeRunner, parseSynctex } from '../src/index.ts';
import { findTexBin } from './tex.ts';

const texBin = findTexBin();

const FILES: Record<string, string> = {
    // One string per line: a multi-line template literal would take the checkout's line endings into the source.
    'paper/main.tex': [
        String.raw`\documentclass{article}`,
        String.raw`\begin{document}`,
        String.raw`\section{Intro}\label{s}`,
        String.raw`See Section~\ref{s} and \cite{knuth}.`,
        String.raw`\input{body}`,
        String.raw`\bibliographystyle{plain}`,
        String.raw`\bibliography{refs}`,
        String.raw`\end{document}`,
        '',
    ].join('\n'),
    'paper/body.tex': 'Body text on its own line.\n',
    'paper/refs.bib': '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}\n',
};

function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'papers-build-'));
    for (const [p, text] of Object.entries(files)) {
        mkdirSync(join(dir, p, '..'), { recursive: true });
        writeFileSync(join(dir, p), text);
    }
    return dir;
}

describe.skipIf(texBin === null)('buildDocument with the local TeX', () => {
    it('runs pdfLaTeX, BibTeX and the reruns, and maps lines both ways', async () => {
        const dir = workspace(FILES);
        const doc = readProject(memoryFiles(FILES)).documents[0];
        if (!doc) throw new Error('no document');
        expect(doc.bibliography).toBe('bibtex');
        const r = await buildDocument({ workDir: dir, document: doc, runner: nativeRunner(texBin) });
        expect(r.steps.map(s => s.program)).toEqual(['pdflatex', 'bibtex', 'pdflatex', 'pdflatex']);
        expect(r.ok).toBe(true);
        expect(r.pages).toBe(1);
        expect(r.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
        expect(readFileSync(join(dir, 'paper/main.bbl'), 'utf8')).toContain('TeXbook');
        if (!r.synctex) throw new Error('no synctex');
        const sync = parseSynctex(readFileSync(r.synctex));
        const boxes = forwardSearch(sync, 'body.tex', 1);
        expect(boxes.length).toBeGreaterThan(0);
        const b = boxes[0];
        if (!b) throw new Error('no box');
        const back = inverseSearch(sync, b.page, b.x + 5, b.y + b.height - 1);
        expect(back?.file).toMatch(/body\.tex$/);
        expect(back?.line).toBe(1);
    }, 60_000);

    it('reports an error at its file and line and stops', async () => {
        const files = { ...FILES, 'paper/body.tex': 'Fine.\n\\undefinedthing\n' };
        const dir = workspace(files);
        const doc = readProject(memoryFiles(files)).documents[0];
        if (!doc) throw new Error('no document');
        const r = await buildDocument({ workDir: dir, document: doc, runner: nativeRunner(texBin) });
        expect(r.ok).toBe(false);
        expect(r.steps.map(s => s.program)).toEqual(['pdflatex']);
        expect(r.diagnostics[0]).toMatchObject({ file: 'paper/body.tex', line: 2, severity: 'error', message: 'Undefined control sequence.' });
    }, 60_000);
});
