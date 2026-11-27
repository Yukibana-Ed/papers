/** Word-level alignment between a source file's text and the words a PDF shows, for both directions of the preview's
 *  sync: the source is reduced to the words that can show in the document (each with its line and columns), the PDF's
 *  text to words with boxes, and the two sequences are aligned in order. Only words that match, in an order both sides
 *  agree on, are paired; everything else stays unpaired, so a caller falls back to the line instead of guessing. */

/** A word of the source that can show in the document: its comparison key and where it is, 1-based line, 0-based
 *  columns [`start`, `end`) in that line. `exact` when the source spells the word character for character as it shows
 *  (no accent macros or braces inside it), so a character offset in one maps to the same offset in the other. */
export interface SourceToken {
    readonly key: string;
    readonly line: number;
    readonly start: number;
    readonly end: number;
    readonly exact: boolean;
}

/** A word as both sides compare it: letters and digits only, lower case, accents' combining marks removed, and
 *  ligature characters spelled out (NFKD makes "ﬁ" "fi"). */
export function keyOf(w: string): string {
    return w
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toLowerCase();
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z@]/.test(c);

/** LaTeX commands whose arguments never show as text, with how many brace arguments to skip. */
const HIDDEN_ARGS: ReadonlyMap<string, number> = new Map([
    ['begin', 1],
    ['end', 1],
    ['cite', 1],
    ['citep', 1],
    ['citet', 1],
    ['citeauthor', 1],
    ['citeyear', 1],
    ['nocite', 1],
    ['ref', 1],
    ['eqref', 1],
    ['autoref', 1],
    ['cref', 1],
    ['Cref', 1],
    ['pageref', 1],
    ['label', 1],
    ['input', 1],
    ['include', 1],
    ['includegraphics', 1],
    ['usepackage', 1],
    ['RequirePackage', 1],
    ['documentclass', 1],
    ['bibliography', 1],
    ['bibliographystyle', 1],
    ['addbibresource', 1],
    ['href', 1],
    ['hspace', 1],
    ['vspace', 1],
    ['setlength', 2],
    ['addtolength', 2],
    ['newcommand', 1],
    ['renewcommand', 1],
    ['providecommand', 1],
    ['newenvironment', 1],
    ['color', 1],
    ['textcolor', 1],
    ['pagestyle', 1],
    ['thispagestyle', 1],
    ['setcounter', 2],
    ['newcounter', 1],
    ['hypersetup', 1],
    ['graphicspath', 1],
    ['geometry', 1],
]);

/** Accent macros: `\'e`, `\"{o}`, `\H{o}`… The letter they take continues the word around them. */
const ACCENTS = new Set(["'", '`', '^', '"', '~', '=', '.', 'H', 'c', 'k', 'u', 'v', 'r', 'd', 'b', 't']);

/** The words of a LaTeX source that can show in the document, line by line. Leaves out comments, command names, and
 *  the arguments of commands that never show as text (labels, references, citations, environment names, file names,
 *  lengths); keeps text in braces and in maths. An accent macro inside a word is part of that word (`Erd\H{o}s` is one
 *  token, not `exact`). Not a TeX parser: a macro that expands to text simply has no tokens, and the aligner leaves
 *  what it typesets unpaired. */
export function latexTokens(source: string): SourceToken[] {
    const out: SourceToken[] = [];
    const lines = source.split('\n');
    lines.forEach((text, li) => {
        const line = li + 1;
        let i = 0;
        let word: { start: number; key: string; exact: boolean } | null = null;
        let lastEnd = 0;
        const close = (): void => {
            if (word !== null && word.key !== '') out.push({ key: keyOf(word.key), line, start: word.start, end: lastEnd, exact: word.exact });
            word = null;
        };
        /** Skips `[…]` and `{…}` groups (balanced) from `j`, up to `count` brace groups. Returns the index after them. */
        const skipArgs = (j: number, count: number): number => {
            let k = j;
            let taken = 0;
            while (k < text.length) {
                while (text[k] === ' ') k++;
                const open = text[k];
                if (open === '*') {
                    k++;
                    continue;
                }
                if (open !== '[' && open !== '{') break;
                if (open === '{' && taken >= count) break;
                const shut = open === '[' ? ']' : '}';
                let depth = 0;
                for (; k < text.length; k++) {
                    if (text[k] === '\\') {
                        k++;
                        continue;
                    }
                    if (text[k] === open) depth++;
                    else if (text[k] === shut && --depth === 0) {
                        k++;
                        break;
                    }
                }
                if (open === '{') taken++;
            }
            return k;
        };
        while (i < text.length) {
            const c = text[i];
            if (c === '%') break;
            if (c === '\\') {
                const n = text[i + 1];
                if (n !== undefined && ACCENTS.has(n) && (n.length === 1 && !isLetter(n) ? true : !isLetter(text[i + 2]))) {
                    // An accent: the letter after it (bare or in braces) continues the word.
                    let j = i + 2;
                    if (text[j] === ' ' && isLetter(n)) j++;
                    const braced = text[j] === '{';
                    if (braced) j++;
                    const letter = text[j];
                    if (isWordChar(letter) && letter !== undefined) {
                        word ??= { start: i, key: '', exact: false };
                        word.key += letter;
                        word.exact = false;
                        j++;
                        if (braced && text[j] === '}') j++;
                        lastEnd = j;
                        i = j;
                        continue;
                    }
                }
                if (isLetter(n)) {
                    close();
                    let j = i + 1;
                    while (isLetter(text[j])) j++;
                    const name = text.slice(i + 1, j);
                    const hidden = HIDDEN_ARGS.get(name);
                    i = hidden === undefined ? j : skipArgs(j, hidden);
                    continue;
                }
                // \%, \&, \_, \\ and the like: one character that is not part of a word.
                close();
                i += 2;
                continue;
            }
            if (c === '{' || c === '}') {
                // Braces inside a word ({\"o}, T{\o}rn) do not end it; elsewhere they are only grouping.
                if (word !== null && (isWordChar(text[i + 1]) || text[i + 1] === '\\')) {
                    word.exact = false;
                    i++;
                    continue;
                }
                close();
                i++;
                continue;
            }
            if (isWordChar(c) && c !== undefined) {
                word ??= { start: i, key: '', exact: true };
                word.key += c;
                lastEnd = i + 1;
                i++;
                continue;
            }
            close();
            i++;
        }
        close();
    });
    return out;
}

const TYPST_KEYWORDS = /^(?:let|set|show|import|include|if|else|for|in|while|return|context)\b/;

/** The words of a Typst source that can show in the document, line by line. Markup text, headings, lists, emphasis and
 *  maths are kept; comments, labels, references, and code are left out, except the content blocks (`[…]`) inside code,
 *  which are markup again (`#emph[this]`, `#align(center)[this]`). */
export function typstTokens(source: string): SourceToken[] {
    const out: SourceToken[] = [];
    const lines = source.split('\n');
    // Content-block depth carried across lines: a `[` opened in code may close lines later.
    lines.forEach((text, li) => {
        const line = li + 1;
        const keep = Array.from({ length: text.length }, () => true);
        const blank = (a: number, b: number): void => {
            for (let k = a; k < b && k < text.length; k++) keep[k] = false;
        };
        let i = 0;
        while (i < text.length) {
            const c = text[i];
            if (c === '/' && text[i + 1] === '/') {
                blank(i, text.length);
                break;
            }
            if (c === '\\') {
                blank(i, i + 2);
                i += 2;
                continue;
            }
            if (c === '<' && /^<[\w.:-]+>/.test(text.slice(i))) {
                const m = /^<[\w.:-]+>/.exec(text.slice(i));
                const n = m?.[0].length ?? 1;
                blank(i, i + n);
                i += n;
                continue;
            }
            if (c === '@' && /^@[\w.:-]+/.test(text.slice(i))) {
                const m = /^@[\w.:-]+/.exec(text.slice(i));
                const n = m?.[0].length ?? 1;
                blank(i, i + n);
                i += n;
                continue;
            }
            if (c === '#') {
                // Code: a keyword statement takes the rest of the line; an expression its name, then any argument
                // lists (code), and content blocks stay markup.
                const rest = text.slice(i + 1);
                if (TYPST_KEYWORDS.test(rest)) {
                    blank(i, text.length);
                    break;
                }
                let j = i + 1;
                while (j < text.length && /[\w.-]/.test(text[j] ?? '')) j++;
                blank(i, j);
                while (text[j] === '(') {
                    let depth = 0;
                    const from = j;
                    for (; j < text.length; j++) {
                        if (text[j] === '(') depth++;
                        else if (text[j] === ')' && --depth === 0) {
                            j++;
                            break;
                        } else if (text[j] === '[' && depth > 0) {
                            // A content block inside the arguments: markup up to its end.
                            blank(from, j + 1);
                            let d = 0;
                            for (; j < text.length; j++) {
                                if (text[j] === '[') d++;
                                else if (text[j] === ']' && --d === 0) break;
                            }
                        }
                    }
                    // Blank what was code (strings, names, numbers), sparing content blocks already handled.
                    let k = from;
                    let d = 0;
                    for (; k < j; k++) {
                        if (text[k] === '[') d++;
                        else if (text[k] === ']') {
                            d--;
                            keep[k] = false;
                            continue;
                        }
                        if (d === 0) keep[k] = false;
                    }
                }
                i = j;
                continue;
            }
            i++;
        }
        let word: { start: number; key: string } | null = null;
        for (let k = 0; k <= text.length; k++) {
            const ch = text[k];
            if (k < text.length && keep[k] && isWordChar(ch) && ch !== undefined) {
                word ??= { start: k, key: '' };
                word.key += ch;
            } else if (word !== null) {
                out.push({ key: keyOf(word.key), line, start: word.start, end: k, exact: true });
                word = null;
            }
        }
    });
    return out;
}

/** Pairs of indices (source token, document word) where the two sequences agree: a longest common subsequence of
 *  their keys, keeping only pairs a neighbour confirms (the token before or after is paired with the word just before
 *  or after) or whose key appears once on each side, or once on each side between the nearest such pairs around it. Promises: both indices strictly increase along the result. */
export function align(source: readonly { key: string }[], doc: readonly { key: string }[]): [number, number][] {
    const n = source.length;
    const m = doc.length;
    if (n === 0 || m === 0) return [];
    // LCS table, row-major, (n + 1) × (m + 1).
    const w = m + 1;
    const t = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            const here = i * w + j;
            t[here] = source[i]?.key === doc[j]?.key ? (t[here + w + 1] ?? 0) + 1 : Math.max(t[here + w] ?? 0, t[here + 1] ?? 0);
        }
    }
    const pairs: [number, number][] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (source[i]?.key === doc[j]?.key && t[i * w + j] === (t[(i + 1) * w + j + 1] ?? 0) + 1) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) i++;
        else j++;
    }
    const count = (list: readonly { key: string }[], key: string, from = 0, to = list.length): number => {
        let c = 0;
        for (let k = from; k < to; k++) if (list[k]?.key === key) c++;
        return c;
    };
    const sure = pairs.map(([a, b], k) => {
        const prev = pairs[k - 1];
        const next = pairs[k + 1];
        const confirmed = (prev !== undefined && prev[0] === a - 1 && prev[1] === b - 1) || (next !== undefined && next[0] === a + 1 && next[1] === b + 1);
        if (confirmed) return true;
        const key = source[a]?.key ?? '';
        return count(source, key) === 1 && count(doc, key) === 1;
    });
    // Between two pairs that are sure, a key that either side has once there can only be that pair.
    return pairs.filter(([a], k) => {
        if (sure[k]) return true;
        const before = pairs[sure.lastIndexOf(true, k)];
        const afterAt = sure.indexOf(true, k);
        const after = afterAt < 0 ? undefined : pairs[afterAt];
        const key = source[a]?.key ?? '';
        return (
            (before !== undefined || after !== undefined) &&
            count(source, key, before === undefined ? 0 : before[0] + 1, after === undefined ? n : after[0]) === 1 &&
            count(doc, key, before === undefined ? 0 : before[1] + 1, after === undefined ? m : after[1]) === 1
        );
    });
}
