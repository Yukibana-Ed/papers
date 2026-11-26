import type { Diagnostic } from '@yukibana/papers-frame-protocol';

/** TeX wraps log lines at this many characters (TeX Live's default `max_print_line`). */
const WRAP = 79;

/** Joins the lines TeX wrapped: a line exactly `WRAP` characters long continues on the next one. */
function unwrap(log: string): string[] {
    const out: string[] = [];
    let carry = '';
    for (const line of log.split(/\r?\n/)) {
        if (line.length === WRAP) {
            carry += line;
            continue;
        }
        out.push(carry + line);
        carry = '';
    }
    if (carry !== '') out.push(carry);
    return out;
}

/** `./sections/intro.tex` → `sections/intro.tex`. */
function normalise(path: string): string {
    let p = path.replace(/\\/g, '/');
    while (p.startsWith('./')) p = p.slice(2);
    return p;
}

/** The errors and warnings of a TeX run, from its log.
 *
 *  Tracks the file TeX is reading from the log's parentheses (`(./sections/intro.tex` opens a file, `)` closes the
 *  innermost), so a message is reported against the innermost file on that stack that `isProjectFile` accepts, and
 *  against `root` when none is (an error inside a package is shown where the project's text called it). Reads:
 *  - errors, `! Message` with the line from the `l.<n>` line that follows it;
 *  - `file:line: message` errors, as `-file-line-error` writes them;
 *  - LaTeX and package warnings that name an input line (`... on input line 12.`);
 *  - over- and underfull boxes, as `info` (with the paragraph's last line as `endLine`).
 *  An error's `excerpt` is the log's context after it, through the `l.<n>` lines that show where TeX stopped.
 *
 *  Promises: every diagnostic's `file` is accepted by `isProjectFile` or is `root`; `line` is at least 1. Duplicates
 *  (same file, line and message) are reported once. */
export function parseTexLog(log: string, root: string, isProjectFile: (path: string) => boolean): Diagnostic[] {
    const lines = unwrap(log);
    const stack: string[] = [];
    const out: Diagnostic[] = [];
    const seen = new Set<string>();

    const current = (): string => {
        for (let i = stack.length - 1; i >= 0; i--) {
            const f = stack[i];
            if (f !== undefined && isProjectFile(f)) return f;
        }
        return root;
    };
    const push = (d: Diagnostic): void => {
        const key = `${d.file}:${d.line}:${d.message}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(d);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        const fle = /^(\.?\/?[^:\s][^:]*\.(?:tex|sty|cls|bib|ltx|def)):(\d+): (.*)$/.exec(line);
        if (fle !== null) {
            const file = normalise(fle[1] ?? '');
            push({ file: isProjectFile(file) ? file : current(), line: Math.max(1, Number(fle[2])), severity: 'error', message: (fle[3] ?? '').trim() });
            continue;
        }

        if (line.startsWith('! ')) {
            const message = line.slice(2).trim();
            // TeX's sign-off after the real error, which is already reported.
            if (message.startsWith('==> Fatal error') && out.some(d => d.severity === 'error')) continue;
            const file = current();
            let at = 1;
            let end = i;
            for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
                const l = /^l\.(\d+)/.exec(lines[j] ?? '');
                if (l !== null) {
                    at = Number(l[1]);
                    // TeX prints where it stopped as two lines: the text read so far, then what was left.
                    end = j + 1 < lines.length && (lines[j + 1] ?? '').trim() !== '' ? j + 1 : j;
                    break;
                }
            }
            const excerpt =
                end > i
                    ? lines
                          .slice(i + 1, end + 1)
                          .join('\n')
                          .trim()
                    : '';
            push({ file, line: Math.max(1, at), severity: 'error', message, ...(excerpt ? { excerpt } : {}) });
            continue;
        }

        // Boxes TeX could not fill or fit: notes, not problems (shown only when asked for).
        const box = /^(Overfull|Underfull) \\([hv])box (\([^)]*\) )?.*?(?:in paragraph at lines (\d+)--(\d+)|detected at line (\d+)|has occurred while \\output is active)/.exec(
            line,
        );
        if (box !== null) {
            const start = Number(box[4] ?? box[6] ?? 1);
            const endLine = Number(box[5] ?? start);
            const message = `${box[1] ?? ''} \\${box[2] ?? 'h'}box ${(box[3] ?? '').trim()}`.trim();
            push({ file: current(), line: Math.max(1, start), severity: 'info', message, ...(endLine > start ? { endLine } : {}) });
            continue;
        }

        const warn = /^(?:LaTeX|Package [\w-]+|Class [\w-]+) Warning: (.*)$/.exec(line);
        if (warn !== null) {
            // A warning may continue on lines that start with `(package)` padding; the input line ends it.
            let text = warn[1] ?? '';
            let j = i;
            while (!/on input line \d+\.?$/.test(text) && j + 1 < lines.length && /^\(\S+\)\s/.test(lines[j + 1] ?? '')) {
                j++;
                text += ' ' + (lines[j] ?? '').replace(/^\(\S+\)\s+/, '');
            }
            const m = /^(.*?)\s*on input line (\d+)\.?$/.exec(text);
            if (m !== null) push({ file: current(), line: Math.max(1, Number(m[2])), severity: 'warning', message: (m[1] ?? '').replace(/\.$/, '').trim() });
            i = j;
            continue;
        }

        // The file stack: `(path` opens, `)` closes. Paths end at whitespace, a parenthesis or the end of the line. A
        // parenthesis that opens no file (in a message) is pushed as '' so that its `)` does not close a file.
        const re = /\((\.{0,2}\/?[^\s()]+\.[A-Za-z0-9]+)?|\)/g;
        for (let m = re.exec(line); m !== null; m = re.exec(line)) {
            if (m[0] === ')') stack.pop();
            else stack.push(m[1] === undefined ? '' : normalise(m[1]));
        }
    }
    return out;
}
