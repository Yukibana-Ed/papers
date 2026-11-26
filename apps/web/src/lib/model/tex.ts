/** What the app reads from LaTeX sources itself, without compiling: which files are documents, which files a document
 *  pulls in, and its sectioning for the outline. The compiler (in the content frame) is the authority on everything
 *  else; this is a quick, forgiving reading of the source as typed. */

/** A heading of the outline. */
export interface Heading {
    readonly kind: 'section' | 'subsection';
    /** `2` or `2.1`; empty for a starred heading. */
    readonly num: string;
    /** The heading's text, with simple markup removed. */
    readonly title: string;
    readonly file: string;
    readonly line: number;
}

/** The source without its comments: `%` to the end of a line, unless escaped. Line numbers are kept. */
export function stripComments(source: string): string {
    return source.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** The files of `files` that compile by themselves, in `order`'s order: `.tex` files with a `\documentclass`, and `.typ`
 *  files that no other Typst file includes or imports (a Typst document has no preamble to tell it by). */
export function findRoots(files: Readonly<Record<string, string>>, order: readonly string[] = Object.keys(files)): string[] {
    const typ = Object.keys(files).filter(f => f.endsWith('.typ'));
    const reached = new Set(typ.flatMap(f => typstReferences(f, files[f] ?? '', files).filter(r => r !== f)));
    return order.filter(f => (f.endsWith('.tex') && /^\s*\\documentclass\b/m.test(stripComments(files[f] ?? ''))) || (f.endsWith('.typ') && !reached.has(f)));
}

/** The project files a Typst source names in `#include "…"`, `#import "…"`, `bibliography("…")` and `image("…")`,
 *  resolved against its folder (or the project root for a path starting with `/`), that exist in `files`. */
export function typstReferences(file: string, source: string, files: Readonly<Record<string, string>>): string[] {
    const dir = file.split('/').slice(0, -1);
    const out: string[] = [];
    for (const m of source.replace(/\/\/.*$/gm, '').matchAll(/(?:#include|#import|bibliography\(|image\()\s*"([^"]+)"/g)) {
        const ref = m[1] ?? '';
        const norm: string[] = [];
        for (const p of ref.startsWith('/') ? ref.slice(1).split('/') : [...dir, ...ref.split('/')]) {
            if (p === '..') norm.pop();
            else if (p !== '.' && p !== '') norm.push(p);
        }
        const path = norm.join('/');
        if (files[path] !== undefined && !out.includes(path)) out.push(path);
    }
    return out;
}

/** The project file a `\input`/`\include` argument names, relative to the project's root folder as TeX resolves it,
 *  or null if no such file exists. */
function resolveTex(name: string, files: Readonly<Record<string, string>>): string | null {
    const n = name.trim().replace(/^\.\//, '');
    if (files[n] !== undefined) return n;
    if (files[`${n}.tex`] !== undefined) return `${n}.tex`;
    return null;
}

/** The files `root` reads, `root` first, then in the order they are first read: `\input`, `\include`, `\subfile`, and
 *  `\bibliography`/`\addbibresource` bibliographies. Each file once; a missing file is skipped. */
export function includedFiles(root: string, files: Readonly<Record<string, string>>): string[] {
    const seen = new Set<string>();
    const visit = (file: string): void => {
        if (seen.has(file)) return;
        const src = files[file];
        if (src === undefined) return;
        seen.add(file);
        if (file.endsWith('.typ')) {
            for (const r of typstReferences(file, src, files)) visit(r);
            return;
        }
        if (!file.endsWith('.tex')) return;
        for (const m of stripComments(src).matchAll(/\\(input|include|subfile|bibliography|addbibresource)\{([^}]*)\}/g)) {
            const command = m[1] ?? '';
            for (const arg of (m[2] ?? '').split(',')) {
                if (command === 'bibliography') {
                    const bib = arg.trim().endsWith('.bib') ? arg.trim() : `${arg.trim()}.bib`;
                    if (files[bib] !== undefined) visit(bib);
                } else if (command === 'addbibresource') {
                    if (files[arg.trim()] !== undefined) visit(arg.trim());
                } else {
                    const target = resolveTex(arg, files);
                    if (target !== null) visit(target);
                }
            }
        }
    };
    visit(root);
    return [...seen];
}

/** Text of a heading's argument: braces, `\emph{x}`-like wrappers and `~` reduced to plain text. */
export function plainTitle(arg: string): string {
    return arg
        .replace(/\$([^$]*)\$/g, '$1')
        .replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, '$1')
        .replace(/\\([%&#_$])/g, '$1')
        .replace(/\\[a-zA-Z]+\*?/g, '')
        .replace(/[{}]/g, '')
        .replace(/~/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The sections and subsections of `root` and the files it includes, in reading order, numbered as `article` numbers
 *  them. A heading's argument must close on its line (as it nearly always does). */
export function outline(root: string, files: Readonly<Record<string, string>>): Heading[] {
    const out: Heading[] = [];
    let sec = 0;
    let sub = 0;
    const seen = new Set<string>();
    const walk = (file: string): void => {
        const src = files[file];
        if (src === undefined || seen.has(file)) return;
        seen.add(file);
        if (file.endsWith('.typ')) {
            src.split('\n').forEach((text, i) => {
                if (/^\s*#include\s+"/.test(text)) {
                    for (const r of typstReferences(file, text, files)) walk(r);
                    return;
                }
                const h = /^(={1,2})\s+(.+?)\s*(?:<[\w.:-]+>)?\s*$/.exec(text);
                if (!h) return;
                const kind = h[1] === '=' ? 'section' : 'subsection';
                if (kind === 'section') {
                    sec++;
                    sub = 0;
                } else sub++;
                const num = kind === 'section' ? `${sec}` : `${sec}.${sub}`;
                out.push({ kind, num, title: (h[2] ?? '').replace(/[*_`$]/g, '').trim(), file, line: i + 1 });
            });
            return;
        }
        const lines = stripComments(src).split('\n');
        lines.forEach((text, i) => {
            const include = text.match(/\\(?:input|include|subfile)\{([^}]*)\}/);
            if (include) {
                const target = resolveTex(include[1] ?? '', files);
                if (target !== null) walk(target);
                return;
            }
            const m = text.match(/\\(section|subsection)(\*?)(?:\[[^\]]*\])?\{(.*)\}/);
            if (!m) return;
            const kind = m[1] === 'section' ? 'section' : 'subsection';
            const starred = m[2] === '*';
            let num = '';
            if (!starred) {
                if (kind === 'section') {
                    sec++;
                    sub = 0;
                    num = `${sec}`;
                } else {
                    sub++;
                    num = `${sec}.${sub}`;
                }
            }
            out.push({ kind, num, title: plainTitle(m[3] ?? ''), file, line: i + 1 });
        });
    };
    walk(root);
    return out;
}

/** The heading the position (`file`, `line`) is under, reading `root` in order; null before the first one. */
export function headingAt(headings: readonly Heading[], root: string, files: Readonly<Record<string, string>>, file: string, line: number): Heading | null {
    const order = includedFiles(root, files);
    const rank = (f: string, l: number): number => order.indexOf(f) * 1e6 + l;
    // Headings come in reading order; the files are read in `order`'s order only up to nesting, so rank by the file's
    // first appearance and the line, which is right for documents that include each file once.
    const at = rank(file, line);
    let best: Heading | null = null;
    for (const h of headings) if (rank(h.file, h.line) <= at) best = h;
    return best;
}
