/** Go to definition, find references and rename for LaTeX projects, on scans of the text (no parser): labels, citation
 *  keys, the project's own commands and environments, and included files. Comments and verbatim material are not
 *  code. Names are looked for in the documents the file belongs to, not in other documents of the repository. */

export type Kind = 'label' | 'citation' | 'command' | 'environment' | 'file';

export interface Place {
    readonly file: string;
    /** Offsets (UTF-16) of the name itself: what a rename replaces. */
    readonly start: number;
    readonly end: number;
}

interface Occurrence extends Place {
    readonly kind: Kind;
    readonly name: string;
    readonly role: 'definition' | 'use';
}

const REF = /\\(?:ref|eqref|pageref|autoref|nameref|vref|cref|Cref|cpageref|labelcref|namecref|nameCref|crefrange|Crefrange|autopageref|subref)\*?\s*\{([^{}]*)\}/g;
const CITE = /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;
const HYPERREF = /\\hyperref\s*\[([^\]]*)\]/g;
const LABEL = /\\label\s*\{([^{}]*)\}/g;
const COMMAND_DEFINITION =
    /\\(?:(?:re)?newcommand|providecommand|DeclareMathOperator|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand|def|let)\*?\s*\{?\\([A-Za-z@]+)/g;
const ENVIRONMENT_DEFINITION = /\\(?:(?:re)?newenvironment|newtheorem|(?:New|Renew|Provide|Declare)DocumentEnvironment|newfloat|lstnewenvironment)\*?\s*\{([^{}]*)\}/g;
const ENVIRONMENT_USE = /\\(?:begin|end)\s*\{([^{}]*)\}/g;
const COMMAND_USE = /\\([A-Za-z@]+)/g;
const INCLUDE = /\\(?:input|include|subfile|addbibresource|bibliography|includegraphics)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
const ENTRY = /@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g;

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

/** `text` with comments and verbatim material blanked (same length and lines), so offsets stay those of the file. */
function code(text: string): string {
    return text
        .replace(/(\\begin\{(verbatim\*?|lstlisting|minted|Verbatim|comment)\})([\s\S]*?)(?=\\end\{\2\})/g, (_, open: string, __, body: string) => open + blank(body))
        .replace(/\\(?:verb|lstinline)\*?([^A-Za-z\s])(.*?)\1/g, m => blank(m))
        .replace(/(?<!\\)%.*$/gm, blank);
}

/** The comma-separated items of a brace group whose content starts at `from`, each trimmed, with its offsets. */
function* items(content: string, from: number): Iterable<{ name: string; start: number; end: number }> {
    let at = 0;
    for (const part of content.split(',')) {
        const name = part.trim();
        const start = from + at + (part.length - part.trimStart().length);
        if (name !== '') yield { name, start, end: start + name.length };
        at += part.length + 1;
    }
}

const cache = new Map<string, { text: string; found: Occurrence[] }>();

/** Everything `file` defines or uses; scanned again only when its text changes. */
function occurrences(file: string, text: string): readonly Occurrence[] {
    const known = cache.get(file);
    if (known?.text === text) return known.found;
    const found: Occurrence[] = [];
    if (file.endsWith('.bib')) {
        for (const m of text.matchAll(ENTRY)) {
            if (/^(string|comment|preamble)$/i.test(m[1] ?? '')) continue;
            const name = m[2] ?? '';
            const start = m.index + m[0].indexOf(name, (m[1] ?? '').length + 1);
            found.push({ file, start, end: start + name.length, kind: 'citation', name, role: 'definition' });
        }
    } else {
        const source = code(text);
        const group = (re: RegExp, kind: Kind, role: Occurrence['role']): void => {
            for (const m of source.matchAll(re)) {
                const from = m.index + m[0].length - 1 - (m[1] ?? '').length;
                for (const i of items(m[1] ?? '', from)) found.push({ file, ...i, kind, role });
            }
        };
        group(LABEL, 'label', 'definition');
        group(REF, 'label', 'use');
        group(HYPERREF, 'label', 'use');
        group(CITE, 'citation', 'use');
        group(ENVIRONMENT_DEFINITION, 'environment', 'definition');
        group(ENVIRONMENT_USE, 'environment', 'use');
        group(INCLUDE, 'file', 'use');
        const defined = new Set<number>();
        for (const m of source.matchAll(COMMAND_DEFINITION)) {
            const name = m[1] ?? '';
            const start = m.index + m[0].length - name.length;
            defined.add(start);
            found.push({ file, start, end: start + name.length, kind: 'command', name, role: 'definition' });
        }
        for (const m of source.matchAll(COMMAND_USE)) {
            const start = m.index + 1;
            if (!defined.has(start)) found.push({ file, start, end: start + (m[1] ?? '').length, kind: 'command', name: m[1] ?? '', role: 'use' });
        }
    }
    cache.set(file, { text, found });
    return found;
}

/** The project's text files: path to text. */
export type Files = ReadonlyMap<string, string>;

/** What is at a position: its kind and name, and where the name is written there. */
export interface Named extends Place {
    readonly kind: Kind;
    readonly name: string;
}

/** The label, citation key, command, environment or file name at `offset` of `file`, or null. A label or key inside
 *  a command's argument wins over the command. Precondition: `file` is a key of `files`. */
export function nameAt(files: Files, file: string, offset: number): Named | null {
    return under(files, file, offset);
}

/** Whether `name` can be written where a `kind` is named. */
export function validName(kind: Kind, name: string): boolean {
    return kind === 'command' ? /^[A-Za-z@]+$/.test(name) : kind === 'environment' ? /^[A-Za-z@*]+$/.test(name) : /^[^\s{}%\\,#~][^{}%\\,#~]*$/.test(name) && name === name.trim();
}

/** The files of the documents `file` belongs to: every root (a file with \documentclass) that reaches it through
 *  \input-like commands, with all that root reaches. A file no root reaches is alone with what it includes. */
function scope(files: Files, file: string): Set<string> {
    const reach = (from: string, seen = new Set<string>()): Set<string> => {
        if (seen.has(from)) return seen;
        seen.add(from);
        for (const o of occurrences(from, files.get(from) ?? '')) {
            if (o.kind !== 'file') continue;
            const target = resolve(files, from, o.name);
            if (target !== null && /\.(tex|bib|sty|cls)$/.test(target)) reach(target, seen);
        }
        return seen;
    };
    const roots = [...files].filter(([f, text]) => f.endsWith('.tex') && /^\s*\\documentclass\b/m.test(code(text))).map(([f]) => reach(f));
    const mine = roots.filter(r => r.has(file));
    if (mine.length === 0) return reach(file);
    const union = new Set<string>();
    for (const r of mine) for (const f of r) union.add(f);
    return union;
}

function all(files: Files, file: string): Occurrence[] {
    return [...scope(files, file)].flatMap(f => occurrences(f, files.get(f) ?? ''));
}

/** What is under the cursor: a label or key inside a command's argument wins over the command. */
function under(files: Files, file: string, offset: number): Occurrence | null {
    const here = occurrences(file, files.get(file) ?? '').filter(o => o.start <= offset && offset <= o.end);
    return here.toSorted((a, b) => (a.kind === 'command' ? 1 : 0) - (b.kind === 'command' ? 1 : 0))[0] ?? null;
}

/** The project file an \input-like argument names, from the including file's folder or the project's top. */
function resolve(files: Files, from: string, name: string): string | null {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    for (const base of [name, dir + name]) for (const ext of ['', '.tex', '.bib', '.pdf', '.png', '.jpg']) if (files.has(base + ext)) return base + ext;
    return null;
}

/** Where the thing at `offset` of `file` is defined: a label's \label, a key's .bib entry, a command's or
 *  environment's definition, an included file's start. Empty when the project does not define it.
 *  Precondition: `file` is a key of `files`. */
export function definition(files: Files, file: string, offset: number): Place[] {
    const o = under(files, file, offset);
    if (o === null) return [];
    if (o.kind === 'file') {
        const target = resolve(files, file, o.name);
        return target === null ? [] : [{ file: target, start: 0, end: 0 }];
    }
    return all(files, file).filter(x => x.kind === o.kind && x.name === o.name && x.role === 'definition');
}

/** The matching \begin or \end of the environment use at `o`, in its file. */
function pair(files: Files, o: Occurrence): Occurrence[] {
    const uses = occurrences(o.file, files.get(o.file) ?? '')
        .filter(x => x.kind === 'environment' && x.role === 'use')
        .toSorted((a, b) => a.start - b.start);
    const text = files.get(o.file) ?? '';
    const begins = (x: Occurrence): boolean => text.lastIndexOf('\\begin', x.start) > text.lastIndexOf('\\end', x.start);
    const stack: Occurrence[] = [];
    for (const u of uses) {
        if (begins(u)) stack.push(u);
        else {
            const open = stack.pop();
            if (open !== undefined && (open === o || u === o)) return [open, u];
        }
    }
    return [o];
}

/** Every place that names the thing at `offset` of `file`, its definition included. A command the project does not
 *  define gives nothing; an environment it does not define gives its own \begin and \end.
 *  Precondition: `file` is a key of `files`. */
export function references(files: Files, file: string, offset: number): Place[] {
    const o = under(files, file, offset);
    if (o === null || o.kind === 'file') return [];
    const same = all(files, file).filter(x => x.kind === o.kind && x.name === o.name);
    if (o.kind === 'label' || o.kind === 'citation') return same;
    if (same.some(x => x.role === 'definition')) return same;
    return o.kind === 'environment' ? pair(files, o) : [];
}

/** The ranges to replace with a new name to rename the thing at `offset` of `file`; empty when it cannot be renamed
 *  (a file name, or a command the project does not define). Precondition: `file` is a key of `files`. */
export function rename(files: Files, file: string, offset: number): Place[] {
    return references(files, file, offset);
}
