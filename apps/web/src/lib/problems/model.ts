/** The app's one model of problems in the document: what builds report (BusyTeX and Typst in the content frame, or
 *  "Build on this computer") and what language servers report, merged, de-duplicated and ordered for the Problems
 *  panel, the preview's error list and the editor's marks. */

export type Severity = 'error' | 'warning' | 'info';
export type ProblemSource = 'build' | 'tinymist' | 'texlab';

export interface Problem {
    /** Stable within one list: severity, file, line and message. */
    readonly id: string;
    readonly severity: Severity;
    readonly file: string;
    /** 1-based. */
    readonly line: number;
    /** 1-based, when the reporter knows the column. */
    readonly column?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
    /** What to show first: a readable sentence when the raw message is one of TeX's terse ones, else the raw message. */
    readonly message: string;
    /** The reporter's own message, when `message` is a rewording of it. */
    readonly raw?: string;
    /** Every reporter that found this problem. */
    readonly sources: readonly ProblemSource[];
    /** For a TeX error: the log's lines showing where TeX stopped. */
    readonly excerpt?: string;
}

/** A diagnostic as a reporter gives it (the frame protocol's `Diagnostic`, or a language server's, converted). */
export interface Reported {
    readonly file: string;
    readonly line: number;
    readonly column?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
    readonly severity: Severity;
    readonly message: string;
    readonly excerpt?: string;
}

/** The command TeX stopped at, from an error's excerpt: the last control sequence on the `l.<n>` line. */
function lastCommand(excerpt: string | undefined): string | null {
    const at = excerpt?.split('\n').find(l => /^l\.\d+/.test(l));
    const all = at?.match(/\\[A-Za-z@]+\*?/g);
    return all?.at(-1) ?? null;
}

/** A readable sentence for the TeX messages people meet most, and the severity it should have; null for the rest.
 *  Undefined references and citations are warnings: the document builds, with "??" where they go. Over- and underfull
 *  boxes are notes. `unread` names the project's files that were not loaded and why (`SessionSeed.unread`). */
export function readable(message: string, excerpt?: string, unread: Readonly<Record<string, string>> = {}): { message: string; severity?: Severity } | null {
    const m = message.trim();
    if (/^Undefined control sequence\.?$/.test(m)) {
        const cmd = lastCommand(excerpt);
        return { message: cmd ? `Unknown command ${cmd}` : 'Unknown command' };
    }
    const file = /^(?:LaTeX Error: )?File `([^']+)' not found\.?$/.exec(m);
    if (file) {
        const name = file[1] ?? '';
        // A file of the repository that was not loaded is another matter than one that is nowhere.
        const kept = Object.keys(unread).find(p => p === name || p.endsWith(`/${name}`) || p.replace(/\.tex$/, '') === name);
        if (kept !== undefined) return { message: `${kept} was not loaded: ${unread[kept] ?? ''}` };
        return { message: `${name || 'A file'} is not in TeX Live or the project` };
    }
    if (/^Missing \$ inserted\.?$/.test(m)) return { message: 'Math outside $…$: a math-only command or ^ or _ in text' };
    if (/^Runaway argument\??$/.test(m) || m.startsWith('File ended while scanning use of') || /^Paragraph ended before .* was complete\.?$/.test(m))
        return { message: 'An argument is not closed: a } is missing' };
    if (/^Missing } inserted\.?$/.test(m)) return { message: 'A } is missing' };
    if (/^Extra }, or forgotten \$\.?$/.test(m) || /^Too many }'s\.?$/.test(m)) return { message: 'An extra }' };
    if (/^LaTeX Error: Environment (\S+) undefined\.?$/.test(m)) return { message: m.replace(/^LaTeX Error: Environment (\S+) undefined\.?$/, 'Unknown environment $1') };
    if (/^LaTeX Error: \\begin\{(\S+)\} on input line \d+ ended by \\end\{(\S+)\}\.?$/.test(m))
        return { message: m.replace(/^LaTeX Error: \\begin\{(\S+)\} on input line \d+ ended by \\end\{(\S+)\}\.?$/, '\\begin{$1} is closed by \\end{$2}') };
    const ref = /^Reference `([^']+)' on page \d+ undefined$/.exec(m);
    if (ref) return { message: `Undefined reference ${ref[1] ?? ''}`, severity: 'warning' };
    const cite = /^Citation `([^']+)' on page \d+ undefined$/.exec(m);
    if (cite) return { message: `Undefined citation ${cite[1] ?? ''}`, severity: 'warning' };
    if (/^(Overfull|Underfull) \\[hv]box/.test(m)) return { message: m, severity: 'info' };
    return null;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** A message reduced for comparing what two reporters said: case, punctuation and spacing ignored. */
function key(message: string): string {
    return message
        .toLowerCase()
        .replace(/[^a-z0-9\\]+/g, ' ')
        .trim();
}

/** One problem per (file, line, message): a build and a language server that report the same thing are shown once,
 *  with both as sources and the more precise range. Two reports also count as the same when they are errors on the same
 *  line and one message contains the other (a language server often words TeX's message slightly differently).
 *  Promises: ordered errors first, then warnings, then notes; within a severity by `order` of files, then line. */
export function mergeProblems(
    reports: readonly { readonly source: ProblemSource; readonly items: readonly Reported[] }[],
    order: readonly string[] = [],
    unread: Readonly<Record<string, string>> = {},
): Problem[] {
    const out: Problem[] = [];
    for (const { source, items } of reports) {
        for (const d of items) {
            const nice = readable(d.message, d.excerpt, unread);
            const severity = nice?.severity ?? d.severity;
            const message = nice?.message ?? d.message;
            const raw = nice && nice.message !== d.message ? d.message : undefined;
            const k = key(raw ?? d.message);
            const same = out.find(p => {
                if (p.file !== d.file || p.line !== d.line || p.severity !== severity) return false;
                const pk = key(p.raw ?? p.message);
                return pk === k || (severity === 'error' && (pk.includes(k) || k.includes(pk)));
            });
            if (same) {
                const i = out.indexOf(same);
                out[i] = {
                    ...same,
                    sources: same.sources.includes(source) ? same.sources : [...same.sources, source],
                    ...(same.column === undefined && d.column !== undefined ? { column: d.column } : {}),
                    ...(same.endColumn === undefined && d.endColumn !== undefined ? { endColumn: d.endColumn } : {}),
                    ...(same.excerpt === undefined && d.excerpt !== undefined ? { excerpt: d.excerpt } : {}),
                };
                continue;
            }
            out.push({
                id: `${severity}:${d.file}:${d.line}:${k}`,
                severity,
                file: d.file,
                line: Math.max(1, d.line),
                message,
                sources: [source],
                ...(raw !== undefined ? { raw } : {}),
                ...(d.column !== undefined ? { column: d.column } : {}),
                ...(d.endLine !== undefined ? { endLine: d.endLine } : {}),
                ...(d.endColumn !== undefined ? { endColumn: d.endColumn } : {}),
                ...(d.excerpt !== undefined ? { excerpt: d.excerpt } : {}),
            });
        }
    }
    const fileRank = (f: string): number => {
        const i = order.indexOf(f);
        return i < 0 ? order.length : i;
    };
    return out.toSorted((a, b) => RANK[a.severity] - RANK[b.severity] || fileRank(a.file) - fileRank(b.file) || a.file.localeCompare(b.file) || a.line - b.line);
}

export interface Counts {
    readonly error: number;
    readonly warning: number;
    readonly info: number;
}

export function countProblems(list: readonly Problem[]): Counts {
    const c = { error: 0, warning: 0, info: 0 };
    for (const p of list) c[p.severity]++;
    return c;
}

/** The problems of `list` grouped by file, files in the order their first problem appears. */
export function byFile(list: readonly Problem[]): { file: string; problems: Problem[] }[] {
    const groups = new Map<string, Problem[]>();
    for (const p of list) {
        const g = groups.get(p.file) ?? [];
        g.push(p);
        groups.set(p.file, g);
    }
    return [...groups].map(([file, problems]) => ({ file, problems }));
}

/** The problem F8 (`dir` 1) or Shift+F8 (`dir` -1) goes to from (`file`, `line`): the next one in document order
 *  (`order` of files, then line), wrapping around; null when `list` is empty. Notes are skipped. */
export function nextProblem(list: readonly Problem[], order: readonly string[], file: string, line: number, dir: 1 | -1): Problem | null {
    const rank = (f: string, l: number): number => {
        const i = order.indexOf(f);
        return (i < 0 ? order.length : i) * 1e6 + l;
    };
    const items = list.filter(p => p.severity !== 'info').toSorted((a, b) => rank(a.file, a.line) - rank(b.file, b.line));
    if (!items.length) return null;
    const here = rank(file, line);
    if (dir === 1) return items.find(p => rank(p.file, p.line) > here) ?? items[0] ?? null;
    return items.toReversed().find(p => rank(p.file, p.line) < here) ?? items.at(-1) ?? null;
}

/** A problem as text for the clipboard. Without `location`: its message, then the reporter's own message when that
 *  differs. With it: `file:line[:column]: severity: message` (a note's severity is "note"), then the reporter's own
 *  message and the log's excerpt, each on lines of their own. */
export function problemText(p: Problem, location: boolean): string {
    const where = `${p.file}:${p.line}${p.column === undefined ? '' : `:${p.column}`}`;
    const lines = [location ? `${where}: ${p.severity === 'info' ? 'note' : p.severity}: ${p.message}` : p.message];
    if (p.raw !== undefined && p.raw !== p.message) lines.push(p.raw);
    if (location && p.excerpt) lines.push(p.excerpt);
    return lines.join('\n');
}
