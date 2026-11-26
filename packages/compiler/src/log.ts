/** A problem a build reported, at a project file's line when the log says where. */
export interface Diagnostic {
    /** Project-relative path with `/`; null when the log names no file of the project. */
    readonly file: string | null;
    /** 1-based; null when the log names no line. */
    readonly line: number | null;
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
}

/** What one engine run's log says. */
export interface LogSummary {
    readonly diagnostics: readonly Diagnostic[];
    /** Pages written, from "Output written on … (N pages"; 0 when no output was written. */
    readonly pages: number;
    /** Whether LaTeX or a package asked for another run (labels or citations changed, rerun requested). */
    readonly rerun: boolean;
    /** Whether citations or references are still undefined. */
    readonly undefinedReferences: boolean;
}

/** Turns a path as the log writes it (`./sections/intro.tex`, or absolute) into a project path, or null for a file
 *  outside `projectDir` (a package, a class). `projectDir` is the folder the engine ran in, with `/`. */
function projectPath(raw: string, projectDir: string): string | null {
    const p = raw.replace(/\\/g, '/').replace(/^"|"$/g, '');
    if (p.startsWith('./')) return p.slice(2);
    const base = projectDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (base && p.toLowerCase().startsWith(`${base}/`)) return p.slice(base.length + 1);
    if (/^([a-zA-Z]:)?\//.test(p)) return null;
    return p;
}

/** TeX wraps log lines at 79 characters; a file name or message may continue on the next line. */
const WRAP = 79;

/** The lines of `log` with TeX's hard wrapping at 79 characters undone, as far as it can be told apart from real
 *  line breaks: a line of exactly 79 characters continues on the next. */
export function unwrap(log: string): string[] {
    const out: string[] = [];
    let carry = '';
    for (const line of log.replace(/\r\n?/g, '\n').split('\n')) {
        if (line.length === WRAP) carry += line;
        else {
            out.push(carry + line);
            carry = '';
        }
    }
    if (carry) out.push(carry);
    return out;
}

/** The diagnostics, page count and rerun requests of a TeX engine's log (pdfTeX, XeTeX, LuaTeX), run with
 *  `-file-line-error`. `projectDir` is the folder the engine ran in, so absolute paths into the project are
 *  recognised.
 *
 *  Errors come from `file:line: message` lines (and `! message` lines, with the line from `l.N`). Warnings come from
 *  `LaTeX Warning:`/`Package … Warning:`/`Class … Warning:` and over- and underfull boxes; their file is the one TeX
 *  was reading, tracked from the parentheses TeX writes when it opens and closes a file. That tracking is a heuristic,
 *  as in every editor, and a parenthesis in a message can throw it; the line numbers TeX gives are exact. */
export function parseLog(log: string, projectDir = ''): LogSummary {
    const lines = unwrap(log);
    const diagnostics: Diagnostic[] = [];
    const stack: (string | null | undefined)[] = [];
    const current = (): string | null => {
        for (let i = stack.length - 1; i >= 0; i--) {
            const f = stack[i];
            if (f !== undefined) return f;
        }
        return null;
    };
    let pages = 0;
    let rerun = false;
    let undefinedReferences = false;
    const push = (d: Diagnostic): void => {
        if (!diagnostics.some(x => x.file === d.file && x.line === d.line && x.message === d.message)) diagnostics.push(d);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        // file:line: message (from -file-line-error)
        const fle = /^((?:[a-zA-Z]:)?[^:]+?\.\w+):(\d+): (.*)$/.exec(line);
        if (fle) {
            let message = fle[3] ?? '';
            // "LaTeX Error: …" continues until an empty line or the help text; keep the first sentence or two.
            const next = lines[i + 1] ?? '';
            if (/Error:/.test(message) && next && !next.startsWith('See the') && !next.startsWith('l.') && !next.startsWith('Type')) message += ` ${next.trim()}`;
            push({ file: projectPath(fle[1] ?? '', projectDir), line: Number(fle[2]), severity: 'error', message: message.replace(/^LaTeX Error: /, '').trim() });
            continue;
        }
        // ! message ... l.N (without -file-line-error, or engine errors such as "! Emergency stop.")
        if (line.startsWith('! ')) {
            let at: number | null = null;
            for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
                const l = /^l\.(\d+)/.exec(lines[j] ?? '');
                if (l) {
                    at = Number(l[1]);
                    break;
                }
            }
            const message = line.slice(2).trim();
            if (message !== 'Emergency stop.' || diagnostics.every(d => d.severity !== 'error')) push({ file: current(), line: at, severity: 'error', message });
            continue;
        }
        const warn = /^(?:LaTeX|Package (\S+)|Class (\S+)|pdfTeX|LuaTeX|XeTeX)\s+Warning:\s*(.*)$/.exec(line);
        if (warn) {
            // A warning continues on lines indented to line up with its text ("(pkg)        more").
            let message = warn[3] ?? '';
            let j = i + 1;
            while (j < lines.length && /^\(\S+\)\s+/.test(lines[j] ?? '')) {
                message += ` ${(lines[j] ?? '').replace(/^\(\S+\)\s+/, '')}`;
                j++;
            }
            while (j < lines.length && (lines[j] ?? '').trim() !== '' && !/^[(\\[]|Warning|Overfull|Underfull/.test(lines[j] ?? '') && !message.endsWith('.')) {
                message += ` ${(lines[j] ?? '').trim()}`;
                j++;
            }
            const pkg = warn[1] ?? warn[2];
            const lineNo = /on input line (\d+)\.?/.exec(message);
            if (/Rerun to get|Label\(s\) may have changed|Please rerun|rerun LaTeX|Citation\(s\) may have changed/i.test(message)) rerun = true;
            if (/There were undefined (references|citations)|Citation .* undefined|Reference .* undefined/.test(message)) undefinedReferences = true;
            push({
                file: current(),
                line: lineNo ? Number(lineNo[1]) : null,
                severity: 'warning',
                message: `${pkg ? `${pkg}: ` : ''}${message.replace(/\s*on input line \d+\.?/, '').trim()}`,
            });
            continue;
        }
        const box = /^(Overfull|Underfull) \\[hv]box \((.*?)\) (?:in paragraph at lines (\d+)--\d+|detected at line (\d+)|has occurred while \\output is active)/.exec(line);
        if (box) {
            push({
                file: current(),
                line: box[3] ? Number(box[3]) : box[4] ? Number(box[4]) : null,
                severity: 'info',
                message: `${box[1]} \\${line.includes('vbox') ? 'v' : 'h'}box (${box[2]})`,
            });
            continue;
        }
        const out = /^Output written on .*\((\d+) pages?/.exec(line);
        if (out) {
            pages = Number(out[1]);
            continue;
        }
        if (line.startsWith('No pages of output.')) pages = 0;
        if (/^Package rerunfilecheck Warning|Rerun to get outlines right/.test(line)) rerun = true;

        // The file stack: "(name" opens a file, ")" closes the innermost one.
        trackFiles(line, stack, projectDir);
    }
    return { diagnostics, pages, rerun, undefinedReferences };
}

/** Updates `stack` for the file openings and closings on `line`. An opening that is not a file (a parenthesis in
 *  text) pushes `undefined`, so that its closing pops the right entry. */
function trackFiles(line: string, stack: (string | null | undefined)[], projectDir: string): void {
    const re = /\(((?:[a-zA-Z]:)?[^\s()[\]{}"]*\.[a-zA-Z0-9]+)|\(|\)/g;
    for (const m of line.matchAll(re)) {
        if (m[0] === ')') stack.pop();
        else if (m[1]) stack.push(projectPath(m[1], projectDir));
        else stack.push(undefined);
    }
}
