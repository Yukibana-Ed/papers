import type { BibliographyTool, Engine, IndexTool } from './config.ts';

/** What the project's sources say, read without compiling: a quick, forgiving reading of LaTeX as typed. The compiler
 *  is the authority; this decides what to run and which files a document needs. */

/** `source` without comments (`%` to the end of a line, unless escaped); line numbers are kept. */
export function stripComments(source: string): string {
    return source.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** Whether `source` is a document of its own: it has a `\documentclass` outside comments. */
export function isRoot(source: string): boolean {
    return /^\s*\\documentclass\b/m.test(stripComments(source));
}

/** A file a document reads, as named in the source, and what kind of reference named it. */
export interface Reference {
    readonly kind: 'tex' | 'bib' | 'graphic';
    /** The argument as written, e.g. `sections/intro` or `figures/plot`. */
    readonly name: string;
    readonly line: number;
}

/** The references in one file: `\input`, `\include`, `\subfile`, `\bibliography`, `\addbibresource`,
 *  `\includegraphics`. Arguments with macros in them are skipped. */
export function references(source: string): Reference[] {
    const out: Reference[] = [];
    stripComments(source)
        .split('\n')
        .forEach((text, i) => {
            for (const m of text.matchAll(/\\(input|include|subfile|bibliography|addbibresource|includegraphics)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
                const cmd = m[1] ?? '';
                for (const raw of (m[2] ?? '').split(',')) {
                    const name = raw.trim();
                    if (!name || name.includes('\\')) continue;
                    const kind = cmd === 'includegraphics' ? 'graphic' : cmd === 'bibliography' || cmd === 'addbibresource' ? 'bib' : 'tex';
                    out.push({ kind, name, line: i + 1 });
                }
            }
        });
    return out;
}

/** The `\graphicspath` folders of `source`, with `/`, without trailing slashes. */
export function graphicsPaths(source: string): string[] {
    const m = /\\graphicspath\{((?:\{[^}]*\})+)\}/.exec(stripComments(source));
    if (!m) return [];
    return [...(m[1] ?? '').matchAll(/\{([^}]*)\}/g)].map(x => (x[1] ?? '').replace(/\/+$/, '').replace(/^\.\//, '')).filter(x => x !== '');
}

/** The engine a TeX editor's magic comment asks for (`% !TEX program = xelatex`), if any. */
export function magicEngine(source: string): Engine | null {
    const m = /^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(source);
    const p = m?.[1]?.toLowerCase();
    return p === 'pdflatex' || p === 'xelatex' || p === 'lualatex' ? p : null;
}

/** The engine `sources` (a root and what it includes) need: the magic comment, else XeLaTeX for fontspec and other
 *  packages that need a Unicode engine, LuaLaTeX for Lua-only packages, else pdfLaTeX, the fastest. */
export function guessEngine(sources: readonly string[]): Engine {
    for (const s of sources) {
        const m = magicEngine(s);
        if (m) return m;
    }
    const all = sources.map(stripComments).join('\n');
    if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(luacode|luatexbase|lua-visual-debug|luamplib)\b/.test(all) || /\\directlua\b/.test(all)) return 'lualatex';
    if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math|polyglossia|xeCJK)\b/.test(all)) return 'xelatex';
    return 'pdflatex';
}

/** The bibliography tool `sources` need: Biber for biblatex (unless `backend=bibtex`), BibTeX for `\bibliography`,
 *  else none. */
export function guessBibliography(sources: readonly string[]): BibliographyTool {
    const all = sources.map(stripComments).join('\n');
    const biblatex = /\\usepackage(\[[^\]]*\])?\{biblatex\}/.exec(all);
    if (biblatex) return /backend\s*=\s*bibtex/.test(biblatex[1] ?? '') ? 'bibtex' : 'biber';
    return /\\bibliography\{/.test(all) ? 'bibtex' : 'none';
}

/** The index tool `sources` need: `\makeindex` or imakeidx means makeindex (xindy when asked for), else none. */
export function guessIndex(sources: readonly string[]): IndexTool {
    const all = sources.map(stripComments).join('\n');
    if (/\\usepackage(\[[^\]]*xindy[^\]]*\])?\{(imakeidx|makeidx)\}/.test(all) && /xindy/.test(all)) return 'xindy';
    return /\\makeindex\b|\\usepackage(\[[^\]]*\])?\{imakeidx\}/.test(all) ? 'makeindex' : 'none';
}
