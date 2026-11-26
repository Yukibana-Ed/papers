// Sync accuracy probe: opens each corpus document in the dev app, waits for its build, and measures in the frame the
// word- and character-level hit rates of source⇄preview sync: before (the line-level map, plus the app's first-occurrence
// word search) and after (the aligner, src/lib/precise.ts in apps/content), on the words that occur exactly once on
// each side, which gives an unambiguous ground truth. Also counts fallbacks (no precise answer) and wrong answers.
//
// Needs both dev servers with the TeX engine (apps/web :5180, apps/content :5185) and a clone of
// Yukibana-Ed/papers-templates at TEMPLATES (default ../papers-templates beside this repository).
//   node apps/web/scripts/sync-probe.mjs [document]
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TPL = process.env.TEMPLATES ?? join(import.meta.dirname, '../../../../papers-templates');
const only = process.argv[2];

function folder(dir) {
    const out = [];
    const walk = d => {
        for (const n of readdirSync(d)) {
            const p = join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(tex|typ|bib|sty|cls|toml|bst)$/.test(n)) out.push({ path: relative(dir, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') });
        }
    };
    walk(dir);
    return out;
}

const STRESS = {
    'main.tex': String.raw`\documentclass[twocolumn]{article}
\usepackage[T1]{fontenc}
\usepackage{amsmath,booktabs}
\newcommand{\tool}{Quickcheck}
\begin{document}
\title{Stress Test for Synchronisation}
\author{Zo\"e Erd\H{o}s \and Ren\'e Fran\c{c}ois}
\maketitle
\section{Prose with Hyphenation}
Incomprehensibilities notwithstanding, internationalization and
characteristically uncharacteristic counterrevolutionaries
demonstrate~\cite{x} that \emph{emphasised words}, \textbf{bold claims}
and \texttt{monospaced identifiers} survive alignment. The \tool{} framework
reports figures\footnote{A footnote with distinctive vocabulary: marmalade.} quickly.
\input{part}
\section{Mathematics}
Inline maths $e^{i\pi} + 1 = 0$ sits beside prose, and displayed:
\begin{equation}
  \int_0^1 x^2 \, dx = \frac{1}{3}
\end{equation}
\begin{table}[h]
  \centering
  \begin{tabular}{lr}
    \toprule
    Treatment & Seconds \\
    \midrule
    Instantaneous & 41 \\
    Delayed & 97 \\
    \bottomrule
  \end{tabular}
  \caption{Turnaround by treatment, unmistakably tabulated.}
\end{table}
\begin{itemize}
  \item Kaleidoscopic enumerations
  \item Zephyr-like bullets with \emph{nested} emphasis
\end{itemize}
\end{document}
`,
    'part.tex': String.raw`\subsection{Included Part}
This paragraph lives in a separate file, brought in through input, and
mentions xylophones, quinoa and jackdaws to be unmistakable.
`,
};

const corpus = [
    { name: 'demo-latex', demo: true },
    { name: 'demo-typst', demo: true, typst: true },
    { name: 'stress-latex', files: Object.entries(STRESS).map(([path, text]) => ({ path, text })), root: 'main.tex' },
    ...['latex-article', 'latex-conference', 'latex-thesis', 'latex-slides', 'latex-cv', 'typst-article', 'typst-slides'].map(id => {
        const files = folder(join(TPL, id)).filter(f => !f.path.startsWith('thumbnail'));
        const index = JSON.parse(readFileSync(join(TPL, 'index.json'), 'utf8')).templates.find(t => t.id === id);
        return { name: id, files, root: index.root };
    }),
].filter(c => !only || c.name === only);

const measure = async typst => {
    const s = window.papersSync;
    const { latexTokens, typstTokens } = await import('/src/lib/align.ts');
    const tokensOf = new Map();
    for (const [file, text] of s.sources) {
        const t = typst ? (file.endsWith('.typ') ? typstTokens(text) : null) : file.endsWith('.tex') ? latexTokens(text) : null;
        if (t) tokensOf.set(file, t);
    }
    const count = new Map();
    for (const ts of tokensOf.values()) for (const t of ts) count.set(t.key, (count.get(t.key) ?? 0) + 1);
    const docCount = new Map();
    for (const w of s.words) docCount.set(w.key, (docCount.get(w.key) ?? 0) + 1);
    const truth = [];
    for (const [file, ts] of tokensOf)
        for (const t of ts) {
            if (t.key.length < 3 || /^\d+$/.test(t.key) || count.get(t.key) !== 1 || docCount.get(t.key) !== 1) continue;
            const word = s.words.find(w => w.key === t.key);
            if (word && word.parts.length === 1) truth.push({ file, t, word });
        }
    const r = {
        truth: truth.length,
        ps: { before: 0, after: 0, fallback: 0 },
        psChar: { n: 0, before: 0, after: 0 },
        sp: { lineBefore: 0, after: 0, fallback: 0 },
        spChar: { n: 0, after: 0 },
    };
    const lineText = (file, line) => (s.sources.get(file) ?? '').split('\n')[line - 1] ?? '';
    for (const { file, t, word } of truth) {
        const b = word.parts[0];
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        // Preview → source, before: the line from the coarse map, then the first place the word appears on it.
        const near = s.coarse.backward(b.page, cx, cy);
        if (near && near.file === file && near.line === t.line) {
            const i = lineText(file, t.line).indexOf(word.text);
            if (i === t.start) r.ps.before++;
        }
        const hit = s.precise.pointToSource(b.page, cx, cy);
        if (hit === null) {
            r.ps.fallback++;
            (r.psMiss ??= []).push(t.key + '@' + file + ':' + t.line);
        } else if (hit.file === file && hit.line === t.line && hit.column >= t.start && hit.column < t.end) r.ps.after++;
        else {
            r.ps.wrong = (r.ps.wrong ?? 0) + 1;
            (r.psWrong ??= []).push(t.key + '@' + t.line + '->' + hit.line + ':' + hit.column);
        }
        // Character level, both ways: the middle character of a word the source spells as shown.
        if (t.exact && t.end - t.start === word.text.length && word.text.length >= 3) {
            const k = Math.floor(word.text.length / 2);
            const per = b.width / word.text.length;
            const px = b.x + per * (k + 0.5);
            r.psChar.n++;
            const near2 = s.coarse.backward(b.page, px, cy);
            if (near2 && near2.file === file && near2.line === t.line && lineText(file, t.line).indexOf(word.text) === t.start + k) r.psChar.before++;
            const h2 = s.precise.pointToSource(b.page, px, cy);
            if (h2 && h2.file === file && h2.line === t.line && h2.column === t.start + k) r.psChar.after++;
            r.spChar.n++;
            const c = s.precise.locate({ file, line: t.line, column: t.start + k });
            if (c && c.page === b.page && Math.abs(c.x + c.width / 2 - px) <= per * 0.6) r.spChar.after++;
        }
        // Source → preview, before: the line's boxes (never one word); counted when one holds the word.
        const segs = s.coarse.segments(file, t.line, false);
        if (segs.some(g => g.page === b.page && cx >= g.x && cx <= g.x + g.width && cy >= g.y - 2 && cy <= g.y + g.height + 2)) r.sp.lineBefore++;
        const box = s.precise.locate({ file, line: t.line, column: t.start });
        if (box === null) {
            r.sp.fallback++;
            (r.miss ??= []).push(t.key + '@' + t.line + (segs.length ? '' : '(noseg)'));
        } else if (box.page === b.page && Math.abs(box.x - b.x) < 1 && Math.abs(box.y - b.y) < 1) r.sp.after++;
        else r.sp.wrong = (r.sp.wrong ?? 0) + 1;
    }
    return r;
};

const browser = await chromium.launch();
const results = [];
for (const c of corpus) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    if (c.demo) {
        await page.goto('http://localhost:5180/demo');
    } else {
        await page.goto('http://localhost:5180/demo');
        await page.waitForFunction(() => typeof window.papersOpen === 'function');
        await page.evaluate(({ name, files, root }) => window.papersOpen({ name, root, files: files.map(f => ({ path: f.path, bytes: new TextEncoder().encode(f.text) })) }), {
            name: c.name,
            files: c.files,
            root: c.root,
        });
        await page.waitForURL(/\/try/);
    }
    const frameEl = await page.waitForSelector('iframe.pv-frame', { timeout: 120000 });
    const frame = await frameEl.contentFrame();
    try {
        await frame.waitForFunction(() => window.papersSync?.precise, null, { timeout: 240000 });
        if (c.typst) {
            await frame.evaluate(() => {
                window.papersSync = undefined;
            });
            await page.locator('button.pv-doc').click();
            await page.locator('.pop-doc button', { hasText: 'brief/brief.typ' }).click();
            await frame.waitForFunction(() => window.papersSync?.precise && window.papersSync.words.some(w => w.key === 'brief'), null, { timeout: 240000 });
        }
        await page.waitForTimeout(500);
        const r = await frame.evaluate(measure, Boolean(c.typst || c.name.startsWith('typst')));
        results.push({ name: c.name, ...r });
        console.log(c.name, JSON.stringify(r));
    } catch (e) {
        console.log(c.name, 'FAILED', String(e).slice(0, 200));
    }
    await page.close();
}
await browser.close();
const pct = (a, n) => (n ? ((100 * a) / n).toFixed(1) + '%' : '-');
console.log(
    '\n| Document | Truth words | P→S word before | P→S word after | P→S char before | P→S char after | S→P word before (line holds it) | S→P word after | S→P char after | Fallback P→S | Fallback S→P |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results)
    console.log(
        `| ${r.name} | ${r.truth} | ${pct(r.ps.before, r.truth)} | ${pct(r.ps.after, r.truth)} | ${pct(r.psChar.before, r.psChar.n)} | ${pct(r.psChar.after, r.psChar.n)} | 0% (${pct(r.sp.lineBefore, r.truth)}) | ${pct(r.sp.after, r.truth)} | ${pct(r.spChar.after, r.spChar.n)} | ${pct(r.ps.fallback, r.truth)} | ${pct(r.sp.fallback, r.truth)} |`,
    );
