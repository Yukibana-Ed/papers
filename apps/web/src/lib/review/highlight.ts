/** A piece of a diff line: its text, its token class (`cmd`, `arg`, `math`, `cmt`, `kw`, `key`, or '' for plain text)
 *  and whether it is in the line's changed part. */
export interface Segment {
    readonly text: string;
    readonly cls: string;
    readonly marked: boolean;
}

const ARGS = /^\\(begin|end|cite|ref|label|input|include|usepackage|documentclass|includegraphics|bibliography|bibliographystyle)$/;

/** Light highlighting of one line of a TeX, Typst, BibTeX or Markdown file, as tokens: enough to read a diff by, not
 *  the editor's grammar. */
function tokens(line: string, path: string): { text: string; cls: string }[] {
    if (path.endsWith('.bib')) {
        const m = /^(@\w+)(.*)$/.exec(line);
        if (m)
            return [
                { text: m[1] ?? '', cls: 'kw' },
                { text: m[2] ?? '', cls: '' },
            ];
        const k = /^(\s+)(\w+)(\s*=.*)$/.exec(line);
        if (k)
            return [
                { text: k[1] ?? '', cls: '' },
                { text: k[2] ?? '', cls: 'key' },
                { text: k[3] ?? '', cls: '' },
            ];
        return [{ text: line, cls: '' }];
    }
    if (path.endsWith('.md') || path.endsWith('.typ')) {
        if (/^\s*(#|=)/.test(line) && !/^\s*#(set|show|let|import|include)\b/.test(line)) return [{ text: line, cls: 'kw' }];
        if (path.endsWith('.typ')) {
            const out: { text: string; cls: string }[] = [];
            const re = /(\/\/.*$)|(#[a-zA-Z][\w-]*)|(\$[^$]*\$?)|(@[\w:-]+)/g;
            let at = 0;
            for (const m of line.matchAll(re)) {
                if ((m.index ?? 0) > at) out.push({ text: line.slice(at, m.index), cls: '' });
                out.push({ text: m[0], cls: m[1] ? 'cmt' : m[2] ? 'cmd' : m[3] ? 'math' : 'arg' });
                at = (m.index ?? 0) + m[0].length;
            }
            if (at < line.length) out.push({ text: line.slice(at), cls: '' });
            return out;
        }
        return [{ text: line, cls: '' }];
    }
    const out: { text: string; cls: string }[] = [];
    let i = 0;
    let plain = '';
    const flush = (): void => {
        if (plain) out.push({ text: plain, cls: '' });
        plain = '';
    };
    while (i < line.length) {
        const c = line[i] ?? '';
        if (c === '%' && line[i - 1] !== '\\') {
            flush();
            out.push({ text: line.slice(i), cls: 'cmt' });
            return out;
        }
        if (c === '$') {
            flush();
            const j = line.indexOf('$', i + 1);
            const e = j < 0 ? line.length : j + 1;
            out.push({ text: line.slice(i, e), cls: 'math' });
            i = e;
            continue;
        }
        if (c === '\\') {
            flush();
            const cmd = /^\\([a-zA-Z@]+|.)/.exec(line.slice(i))?.[0] ?? '\\';
            out.push({ text: cmd, cls: 'cmd' });
            i += cmd.length;
            if (ARGS.test(cmd)) {
                const opt = /^\[[^\]]*\]/.exec(line.slice(i));
                if (opt) {
                    out.push({ text: opt[0], cls: '' });
                    i += opt[0].length;
                }
                const arg = /^\{([^}]*)\}/.exec(line.slice(i));
                if (arg) {
                    out.push({ text: '{', cls: 'cmd' }, { text: arg[1] ?? '', cls: 'arg' }, { text: '}', cls: 'cmd' });
                    i += arg[0].length;
                }
            }
            continue;
        }
        plain += c;
        i++;
    }
    flush();
    return out;
}

/** `line` of `path` as highlighted segments, with `mark` (offsets of the changed part) cut out as marked ones. */
export function segments(line: string, path: string, mark?: readonly [number, number]): Segment[] {
    const out: Segment[] = [];
    let at = 0;
    const [from, to] = mark && mark[1] > mark[0] && mark[1] - mark[0] < line.length ? mark : [-1, -1];
    for (const t of tokens(line, path)) {
        const end = at + t.text.length;
        for (const [a, b, marked] of [
            [at, Math.min(end, Math.max(at, from)), false],
            [Math.max(at, from), Math.min(end, to), true],
            [Math.max(at, to), end, false],
        ] as const) {
            if (b > a) out.push({ text: line.slice(a, b), cls: t.cls, marked: marked && from >= 0 });
        }
        at = end;
    }
    return out;
}
