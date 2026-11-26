import { CLASSES, COMMANDS, ENVIRONMENTS, environmentSnippet, PACKAGES, withLoaded } from './catalog.ts';

/** LaTeX completion without a language server: what a project's files define (labels, bibliography entries, commands,
 *  environments) kept per file and parsed again only when that file changes, and what to offer at a position. */

export interface BibEntry {
    readonly key: string;
    /** The first author's family name. */
    readonly author: string;
    /** Every named author's family name, in order. */
    readonly authors: readonly string[];
    /** Whether the entry ends its authors with "and others". */
    readonly others: boolean;
    readonly year: string;
    readonly title: string;
}

/** What one file contributes. */
interface FileFacts {
    readonly labels: readonly string[];
    readonly bib: readonly BibEntry[];
    readonly commands: readonly { name: string; args: number }[];
    readonly environments: readonly string[];
    /** The packages and the class it loads by name (\usepackage, \RequirePackage, \documentclass). */
    readonly packages: readonly string[];
}

const NO_FACTS: FileFacts = { labels: [], bib: [], commands: [], environments: [], packages: [] };

/** A .bib field's value: braces and quotes stripped, white space collapsed. */
function field(entry: string, name: string): string {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\d+))`, 'i').exec(entry);
    return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** The facts of one file, by its path's extension. Comments (`%` to the line's end) are skipped in TeX files. */
export function factsOf(path: string, text: string): FileFacts {
    if (path.endsWith('.bib')) {
        const bib: BibEntry[] = [];
        const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
        const starts = [...text.matchAll(re)];
        starts.forEach((m, i) => {
            if (/^(string|comment|preamble)$/i.test(m[1] ?? '')) return;
            const body = text.slice(m.index ?? 0, starts[i + 1]?.index ?? text.length);
            // "Family, Given" or "Given Family": the family name is before the comma, or the last word.
            const named = field(body, 'author').split(/\s+and\s+/i);
            const others = named.at(-1)?.toLowerCase() === 'others';
            const authors = named
                .slice(0, others ? -1 : undefined)
                .map(a => (a.includes(',') ? (a.split(',')[0] ?? '') : (a.split(' ').at(-1) ?? '')).trim())
                .filter(Boolean);
            bib.push({ key: m[2] ?? '', author: authors[0] ?? '', authors, others, year: field(body, 'year'), title: field(body, 'title') });
        });
        return { ...NO_FACTS, bib };
    }
    if (!/\.(tex|sty|cls|ltx)$/.test(path)) return NO_FACTS;
    const code = text.replace(/(^|[^\\])%.*$/gm, '$1');
    const labels = [...code.matchAll(/\\label\s*\{([^}]+)\}/g)].map(m => m[1] ?? '');
    const commands = [...code.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([A-Za-z@]+)\}?(?:\s*\[(\d)\])?/g)].map(m => ({
        name: m[1] ?? '',
        args: Number(m[2] ?? 0),
    }));
    const environments = [...code.matchAll(/\\(?:newenvironment|renewenvironment|newtheorem)\*?\s*\{([^}]+)\}/g)].map(m => m[1] ?? '');
    const packages = [...code.matchAll(/\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap(m =>
        (m[1] ?? '')
            .split(',')
            .map(p => p.trim())
            .filter(Boolean),
    );
    return { labels, bib: [], commands, environments, packages };
}

/** The project's facts, file by file; `update` parses only what changed. */
export class LatexIndex {
    readonly #files = new Map<string, { text: string; facts: FileFacts }>();
    #paths: readonly string[] = [];

    /** Records `path`'s text; parses it again only when the text differs. */
    update(path: string, text: string): void {
        const known = this.#files.get(path);
        if (known?.text === text) return;
        this.#files.set(path, { text, facts: factsOf(path, text) });
    }

    remove(path: string): void {
        this.#files.delete(path);
    }

    /** Every path of the project, assets included (for \includegraphics). */
    setPaths(paths: readonly string[]): void {
        this.#paths = paths;
    }

    get paths(): readonly string[] {
        return this.#paths.length > 0 ? this.#paths : [...this.#files.keys()];
    }

    *#all(): Iterable<FileFacts> {
        for (const f of this.#files.values()) yield f.facts;
    }

    labels(): string[] {
        return [...new Set([...this.#all()].flatMap(f => f.labels))];
    }

    bib(): BibEntry[] {
        return [...this.#all()].flatMap(f => f.bib);
    }

    commands(): { name: string; args: number }[] {
        return [...this.#all()].flatMap(f => f.commands);
    }

    environments(): string[] {
        return [...this.#all()].flatMap(f => f.environments);
    }

    /** The packages and classes the project loads, with those they load themselves. */
    loaded(): Set<string> {
        return withLoaded([...this.#all()].flatMap(f => f.packages));
    }
}

/** One thing to offer. `insert` is a Monaco snippet. */
export interface Offer {
    readonly label: string;
    readonly insert: string;
    readonly kind: 'command' | 'snippet' | 'environment' | 'label' | 'citation' | 'file' | 'package' | 'class';
    readonly detail: string;
    /** What typed text is matched against, when more than the label: a citation is found by its authors, year and
     *  title too. */
    readonly filter?: string;
}

/** `items` with the kernel's first, then those of the packages in `loaded`, then the others: each group in its order. */
function ranked<T extends { readonly from: string }>(items: readonly T[], loaded: ReadonlySet<string>): T[] {
    const rank = (i: T): number => (i.from === '' ? 0 : loaded.has(i.from) ? 1 : 2);
    return [0, 1, 2].flatMap(r => items.filter(i => rank(i) === r));
}

/** The environments to offer, the project's own first, each name once with the package it comes from. */
function environmentsOf(index: LatexIndex, first: readonly string[] = []): { name: string; from: string }[] {
    const seen = new Set<string>();
    const all = [...[...first, ...index.environments()].map(name => ({ name, from: '' })), ...ranked(ENVIRONMENTS, index.loaded())];
    return all.filter(e => {
        if (seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
    });
}

/** What to offer where the cursor is, `before` being its line up to the cursor and `after` the rest of the line;
 *  `start` is the column (0-based) from which the offers replace. After a backslash the offers are the commands and
 *  then whole environments (`\begin{itemize}` with its `\item` and `\end`); those of the kernel and of the packages the
 *  project loads come before those of other packages, which carry their package's name as `detail`. Null when nothing applies (the editor then shows
 *  nothing, rather than words of the file). `file` is the file being edited, for paths relative to its folder. */
export function complete(before: string, after: string, index: LatexIndex, file: string): { start: number; offers: Offer[] } | null {
    const arg = /\\([A-Za-z]+\*?)(?:\[[^\]]*\])?\{([^{}]*)$/.exec(before);
    if (arg !== null) {
        const cmd = arg[1] ?? '';
        const inside = arg[2] ?? '';
        // Lists (\cite{a,b}, \usepackage{x,y}) complete the item after the last comma.
        const item = inside.slice(inside.lastIndexOf(',') + 1).replace(/^\s+/, '');
        const start = before.length - item.length;
        const closes = after.startsWith('}');
        if (cmd === 'begin') {
            return {
                start,
                offers: environmentsOf(index).map(e => ({
                    label: e.name,
                    // The whole environment, unless the brace is closed already (editing an existing \begin).
                    insert: closes ? e.name : environmentSnippet(e.name),
                    kind: 'environment',
                    detail: e.from,
                })),
            };
        }
        if (cmd === 'end') {
            const open = openEnvironment(before);
            const names = environmentsOf(index, open === null ? [] : [open]);
            return { start, offers: names.map(e => ({ label: e.name, insert: closes ? e.name : `${e.name}}`, kind: 'environment', detail: e.from })) };
        }
        if (/^(ref|eqref|pageref|autoref|cref|Cref|nameref|vref)$/.test(cmd)) {
            return { start, offers: index.labels().map(l => ({ label: l, insert: l, kind: 'label', detail: '' })) };
        }
        if (/^(cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|nocite|footcite)\*?$/.test(cmd)) {
            return {
                start,
                offers: index.bib().map(b => ({
                    label: b.key,
                    insert: b.key,
                    kind: 'citation',
                    detail: [b.others || b.authors.length > 2 ? `${b.author} et al.` : b.authors.join(' and '), b.year, b.title].filter(Boolean).join(' · '),
                    filter: [b.key, ...b.authors, b.year, b.title].filter(Boolean).join(' '),
                })),
            };
        }
        if (cmd === 'usepackage' || cmd === 'RequirePackage') return { start, offers: PACKAGES.map(p => ({ label: p, insert: p, kind: 'package', detail: '' })) };
        if (cmd === 'documentclass') return { start, offers: CLASSES.map(p => ({ label: p, insert: p, kind: 'class', detail: '' })) };
        if (cmd === 'input' || cmd === 'include' || cmd === 'includegraphics' || cmd === 'bibliography' || cmd === 'addbibresource') {
            const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
            const ext = cmd === 'includegraphics' ? /\.(pdf|png|jpe?g|eps|svg)$/i : cmd === 'bibliography' || cmd === 'addbibresource' ? /\.bib$/ : /\.tex$/;
            const offers = index.paths
                .filter(p => ext.test(p) && p !== file)
                .map(p => {
                    // TeX resolves paths from the root's folder; offering them relative to this file's folder is right
                    // for the usual layout (root at the top), and the full path otherwise.
                    const rel = dir !== '' && p.startsWith(dir) ? p.slice(dir.length) : p;
                    const shown = cmd === 'include' || cmd === 'bibliography' ? rel.replace(/\.(tex|bib)$/, '') : rel;
                    return { label: shown, insert: shown, kind: 'file' as const, detail: '' };
                });
            return { start, offers };
        }
        return null;
    }
    const name = /\\([A-Za-z]*)$/.exec(before);
    if (name !== null) {
        const start = before.length - (name[1] ?? '').length;
        const own = index.commands().map(c => ({ name: c.name, args: Array.from({ length: c.args }, (_, i) => `{$${i + 1}}`).join(''), from: 'project' }));
        const seen = new Set<string>();
        const offers: Offer[] = [];
        for (const c of [...own, ...ranked(COMMANDS, index.loaded())]) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            offers.push({ label: `\\${c.name}`, insert: `${c.name}${c.args}`, kind: 'command', detail: c.from });
        }
        // Whole environments, found by `\beg…` and by their own name (`\item…` finds itemize): after the commands.
        for (const e of environmentsOf(index)) offers.push({ label: `\\begin{${e.name}}`, insert: `begin{${environmentSnippet(e.name)}`, kind: 'snippet', detail: e.from });
        return { start, offers };
    }
    return null;
}

/** The innermost environment open before the cursor on this line, if \begin appears there without its \end. */
function openEnvironment(before: string): string | null {
    const stack: string[] = [];
    for (const m of before.matchAll(/\\(begin|end)\{([^}]*)\}/g)) {
        if (m[1] === 'begin') stack.push(m[2] ?? '');
        else stack.pop();
    }
    return stack.at(-1) ?? null;
}
