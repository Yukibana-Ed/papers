import { CLASSES, COMMANDS, ENVIRONMENTS, PACKAGES } from './catalog.ts';

/** LaTeX completion without a language server: what a project's files define (labels, bibliography entries, commands,
 *  environments) kept per file and parsed again only when that file changes, and what to offer at a position. */

export interface BibEntry {
    readonly key: string;
    readonly author: string;
    readonly year: string;
    readonly title: string;
}

/** What one file contributes. */
interface FileFacts {
    readonly labels: readonly string[];
    readonly bib: readonly BibEntry[];
    readonly commands: readonly { name: string; args: number }[];
    readonly environments: readonly string[];
}

const NO_FACTS: FileFacts = { labels: [], bib: [], commands: [], environments: [] };

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
            const author = field(body, 'author').split(/\s+and\s+/i)[0] ?? '';
            bib.push({ key: m[2] ?? '', author: author.split(',')[0]?.trim() ?? '', year: field(body, 'year'), title: field(body, 'title') });
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
    return { labels, bib: [], commands, environments };
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
}

/** One thing to offer. `insert` is a Monaco snippet. */
export interface Offer {
    readonly label: string;
    readonly insert: string;
    readonly kind: 'command' | 'environment' | 'label' | 'citation' | 'file' | 'package' | 'class';
    readonly detail: string;
}

/** What to offer where the cursor is, `before` being its line up to the cursor and `after` the rest of the line;
 *  `start` is the column (0-based) from which the offers replace. Null when nothing applies (the editor then shows
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
            const names = [...new Set([...index.environments(), ...ENVIRONMENTS])];
            return {
                start,
                offers: names.map(n => ({
                    label: n,
                    // With its \end, unless the brace is closed already (editing an existing \begin).
                    insert: closes ? n : `${n}}\n\t$0\n\\end{${n}}`,
                    kind: 'environment',
                    detail: '',
                })),
            };
        }
        if (cmd === 'end') {
            const open = openEnvironment(before);
            const names = [...new Set([...(open ? [open] : []), ...index.environments(), ...ENVIRONMENTS])];
            return { start, offers: names.map(n => ({ label: n, insert: closes ? n : `${n}}`, kind: 'environment', detail: '' })) };
        }
        if (/^(ref|eqref|pageref|autoref|cref|Cref|nameref|vref)$/.test(cmd)) {
            return { start, offers: index.labels().map(l => ({ label: l, insert: l, kind: 'label', detail: '' })) };
        }
        if (/^(cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|nocite|footcite)\*?$/.test(cmd)) {
            return {
                start,
                offers: index.bib().map(b => ({ label: b.key, insert: b.key, kind: 'citation', detail: [b.author, b.year, b.title].filter(Boolean).join(' · ') })),
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
        for (const c of [...own, ...COMMANDS]) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            offers.push({ label: `\\${c.name}`, insert: `${c.name}${c.args}`, kind: 'command', detail: c.from });
        }
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
