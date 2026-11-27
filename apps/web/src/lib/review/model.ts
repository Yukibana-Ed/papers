import { IdSet } from '@yukibana/papers-room-protocol';

/** A run of a file's characters, in the order the text's CRDT keeps them: in the committed state (`base`), in the
 *  session's text (`now`), or both. A run in neither is never made. */
export interface Run {
    readonly text: string;
    readonly base: boolean;
    readonly now: boolean;
    /** The first character's Yjs id (`client`, `clock`); the rest follow it clock by clock. Null when the run has no
     *  ids (texts compared without the CRDT): such a file's commit cannot say which characters it committed. */
    readonly id: readonly [client: number, clock: number] | null;
    /** Who made the change, when the run is one: the writer of an insertion (`now` only), the deleter of a deletion
     *  (`base` only). Null when not known, and for unchanged text. */
    readonly by: string | null;
    /** For an insertion that was an accepted suggestion: who accepted it (`by` is who suggested it). */
    readonly acceptedBy?: string;
}

/** One row of a file's diff. */
export interface Row {
    readonly kind: 'ctx' | 'del' | 'add';
    /** The line, without its line break. */
    readonly text: string;
    /** 1-based line numbers in the committed text and in the session's; null on the side the row is not in. */
    readonly old: number | null;
    readonly new: number | null;
    /** The change the row belongs to (an index into `FileReview.changes`), or -1 for context. */
    readonly change: number;
    /** Who changed this line, most characters first: empty for context. */
    readonly authors: readonly string[];
    /** When the line's insertion was a suggestion someone accepted: who suggested it and who accepted it. */
    readonly suggested?: { readonly by: string; readonly acceptedBy: string };
    /** The changed part of the line (offsets into `text`), for highlighting within it. */
    readonly mark?: readonly [number, number];
}

/** One change: the smallest group of changed lines that can be committed or left out on its own. Lines whose
 *  characters are shared (a line edited in place, split or joined) or interleaved in the CRDT's order are one change,
 *  because the committed state is a set of characters: an old line kept beside its own edit cannot be one. */
export interface Change {
    readonly index: number;
    /** Ids of its changed characters (or of its lines, without ids): what the commit selection remembers it by. */
    readonly keys: readonly string[];
    /** Everyone who took part, most characters first. */
    readonly authors: readonly string[];
    /** Its rows (indices into `FileReview.rows`), deletions and insertions alike. */
    readonly rows: readonly number[];
    readonly add: number;
    readonly del: number;
}

/** A diff hunk: rows `start` to `end` (exclusive) of `FileReview.rows`, with up to three lines of context. */
export interface Hunk {
    readonly start: number;
    readonly end: number;
    readonly oldStart: number;
    readonly newStart: number;
    /** The heading the hunk is under (a section, a Typst or Markdown heading), as git's function context. */
    readonly header: string;
    /** The changes in it, in order. */
    readonly changes: readonly number[];
}

/** What changed in one file since its committed state. */
export interface FileReview {
    readonly rows: readonly Row[];
    readonly changes: readonly Change[];
    readonly hunks: readonly Hunk[];
    readonly add: number;
    readonly del: number;
    /** Everyone who changed something, most characters first. */
    readonly authors: readonly string[];
    /** The file cut into pieces (runs split after each line break) and, per piece, the change it belongs to: -1 for
     *  unchanged lines, -2 for a group whose old and new text are the same (no change to show; taken as it is now). */
    readonly pieces: readonly Run[];
    readonly pieceChange: Int32Array;
}

const CONTEXT = 3;

interface Line {
    first: number;
    last: number;
    text: string;
    /** Ends in a line break. */
    nl: boolean;
}

function splitPieces(runs: readonly Run[]): Run[] {
    const out: Run[] = [];
    for (const r of runs) {
        if (r.text === '') continue;
        let at = 0;
        while (at < r.text.length) {
            const nl = r.text.indexOf('\n', at);
            const end = nl === -1 ? r.text.length : nl + 1;
            out.push({ ...r, text: r.text.slice(at, end), id: r.id ? [r.id[0], r.id[1] + at] : null });
            at = end;
        }
    }
    return out;
}

/** The lines `pieces` make on one side: the pieces where `on` holds, cut after each line break. */
function linesOf(pieces: readonly Run[], on: (p: Run) => boolean): { lines: Line[]; of: Int32Array } {
    const lines: Line[] = [];
    const of = new Int32Array(pieces.length).fill(-1);
    let cur: Line | null = null;
    pieces.forEach((p, i) => {
        if (!on(p)) return;
        if (!cur) {
            cur = { first: i, last: i, text: '', nl: false };
            lines.push(cur);
        }
        cur.last = i;
        cur.text += p.text;
        of[i] = lines.length - 1;
        if (p.text.endsWith('\n')) {
            cur.nl = true;
            cur.text = cur.text.slice(0, -1);
            cur = null;
        }
    });
    return { lines, of };
}

/** Pairs of equal lines of `a` and `b` in a longest common subsequence, in order. */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
    const n = a.length;
    const m = b.length;
    const t = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            t[i * (m + 1) + j] = a[i] === b[j] ? (t[(i + 1) * (m + 1) + j + 1] ?? 0) + 1 : Math.max(t[(i + 1) * (m + 1) + j] ?? 0, t[i * (m + 1) + j + 1] ?? 0);
    const out: [number, number][] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push([i, j]);
            i++;
            j++;
        } else if ((t[(i + 1) * (m + 1) + j] ?? 0) >= (t[i * (m + 1) + j + 1] ?? 0)) i++;
        else j++;
    }
    return out;
}

/** Logins by how many characters each changed, most first. */
function ranked(counts: Map<string, number>): string[] {
    return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([u]) => u);
}

const HEADING = /^\s*(\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]|\\begin\{frame\}|=+\s|#+\s|@\w+\s*\{)/;

/** The diff of one file, from its runs in the CRDT's order (`yRuns`, or `textRuns` without the CRDT).
 *
 *  Promises: a line whose characters are all unchanged and still make exactly that line is context; every other line
 *  is in exactly one change; within a change, old and new lines that read the same are shown as context. A change's
 *  authors are the people whose characters were inserted or deleted inside its lines; a line nobody is known to have
 *  changed takes its change's authors, and a change nobody is known to have made is `fallback`'s. */
export function reviewFile(runs: readonly Run[], fallback: string): FileReview {
    const pieces = splitPieces(runs);
    const base = linesOf(pieces, p => p.base);
    const now = linesOf(pieces, p => p.now);
    const pieceChange = new Int32Array(pieces.length).fill(-1);

    const unchanged = (l: Line): boolean => {
        const m = now.lines[now.of[l.first] ?? -1];
        if (!m || m.first !== l.first || m.last !== l.last || m.nl !== l.nl) return false;
        for (let i = l.first; i <= l.last; i++) if (!pieces[i]?.base || !pieces[i]?.now) return false;
        return true;
    };

    // Changed lines of both sides, grouped where their spans in the CRDT's order overlap.
    const keep = base.lines.map(unchanged);
    type Side = { side: 'base' | 'now'; index: number; line: Line };
    const changed: Side[] = [];
    base.lines.forEach((line, index) => keep[index] || changed.push({ side: 'base', index, line }));
    now.lines.forEach((line, index) => {
        const b = base.of[line.first] ?? -1;
        if (!(b >= 0 && keep[b] && base.lines[b]?.first === line.first)) changed.push({ side: 'now', index, line });
    });
    changed.sort((a, b) => a.line.first - b.line.first || (a.side === 'base' ? -1 : 1));
    const groups: Side[][] = [];
    let reach = -1;
    for (const c of changed) {
        if (c.line.first > reach || groups.length === 0) groups.push([c]);
        else groups.at(-1)?.push(c);
        reach = Math.max(reach, c.line.last);
    }

    const rows: Row[] = [];
    const changes: Change[] = [];
    const fileAuthors = new Map<string, number>();
    let add = 0;
    let del = 0;

    /** Who changed the pieces of `line`'s span, by characters. */
    const whoIn = (line: Line): { counts: Map<string, number>; suggested?: { by: string; acceptedBy: string } } => {
        const counts = new Map<string, number>();
        let suggested: { by: string; acceptedBy: string } | undefined;
        for (let i = line.first; i <= line.last; i++) {
            const p = pieces[i];
            if (!p || p.base === p.now || p.by === null) continue;
            counts.set(p.by, (counts.get(p.by) ?? 0) + p.text.length);
            if (p.acceptedBy !== undefined && p.now) suggested = { by: p.by, acceptedBy: p.acceptedBy };
        }
        return suggested ? { counts, suggested } : { counts };
    };

    // Blocks in the CRDT's order: an unchanged line, or a run of groups with no unchanged line between them.
    type Block = { at: number; line?: number; groups?: Side[][] };
    const blocks: Block[] = [];
    base.lines.forEach((l, i) => keep[i] && blocks.push({ at: l.first, line: i }));
    for (const g of groups) blocks.push({ at: Math.min(...g.map(s => s.line.first)), groups: [g] });
    blocks.sort((a, b) => a.at - b.at);
    const merged: Block[] = [];
    for (const b of blocks) {
        const last = merged.at(-1);
        if (b.groups && last?.groups) last.groups.push(...b.groups);
        else merged.push(b);
    }

    const textKeys = new Map<string, number>();
    for (const b of merged) {
        if (b.line !== undefined) {
            const l = base.lines[b.line];
            if (!l) continue;
            const m = now.of[l.first] ?? -1;
            rows.push({ kind: 'ctx', text: l.text, old: b.line + 1, new: m + 1, change: -1, authors: [] });
            continue;
        }
        const gs = b.groups ?? [];
        const groupOf = new Map<Side, number>();
        gs.forEach((g, k) => g.forEach(s => groupOf.set(s, k)));
        const all = gs.flat();
        const olds = all.filter(s => s.side === 'base').toSorted((x, y) => x.index - y.index);
        const news = all.filter(s => s.side === 'now').toSorted((x, y) => x.index - y.index);
        const key = (s: Side): string => s.line.text + (s.line.nl ? '\n' : '');
        const pairs = lcsPairs(olds.map(key), news.map(key));
        // Groups that cancel each other (text deleted in one and the same text typed again in another) are one: left
        // apart, one could be committed without the other and the line would be lost or doubled.
        const parent = gs.map((_, k) => k);
        const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k] ?? k)));
        for (const [pi, pj] of pairs) {
            const o = olds[pi];
            const n = news[pj];
            if (o && n) parent[find(groupOf.get(o) ?? 0)] = find(groupOf.get(n) ?? 0);
        }
        const unitOf = (s: Side): number => find(groupOf.get(s) ?? 0);
        // Rows in order, each with its unit.
        type Draft = { row: Omit<Row, 'change'>; unit: number };
        const drafts: Draft[] = [];
        let i = 0;
        let j = 0;
        const emit = (s: Side, kind: 'del' | 'add'): void => {
            const w = whoIn(s.line);
            drafts.push({
                unit: unitOf(s),
                row: {
                    kind,
                    text: s.line.text,
                    old: kind === 'del' ? s.index + 1 : null,
                    new: kind === 'add' ? s.index + 1 : null,
                    authors: ranked(w.counts),
                    ...(w.suggested ? { suggested: w.suggested } : {}),
                },
            });
        };
        for (const [pi, pj] of [...pairs, [olds.length, news.length] as [number, number]]) {
            for (const s of olds.slice(i, pi)) emit(s, 'del');
            for (const s of news.slice(j, pj)) emit(s, 'add');
            const o = olds[pi];
            const n = news[pj];
            if (o && n) drafts.push({ unit: -1, row: { kind: 'ctx', text: n.line.text, old: o.index + 1, new: n.index + 1, authors: [] } });
            i = pi + 1;
            j = pj + 1;
        }
        // Each unit with rows to show is a change; the others are taken as they are now.
        const units = [...new Set(gs.map((_, k) => find(k)))];
        const indexOf = new Map<number, number>();
        const blockCounts = new Map<string, number>();
        const unitInfo = new Map<number, { counts: Map<string, number>; keys: string[] }>();
        for (const u of units) {
            const spans = gs.flatMap((g, k) => (find(k) === u ? g.map(s => s.line) : []));
            const lo = Math.min(...spans.map(l => l.first));
            const hi = Math.max(...spans.map(l => l.last));
            const showsRows = drafts.some(d => d.unit === u);
            const index = showsRows ? changes.length + indexOf.size : -2;
            if (showsRows) indexOf.set(u, index);
            const counts = new Map<string, number>();
            const keys: string[] = [];
            for (let k = lo; k <= hi; k++) {
                pieceChange[k] = index;
                const p = pieces[k];
                if (!p || p.base === p.now) continue;
                if (p.by !== null) {
                    counts.set(p.by, (counts.get(p.by) ?? 0) + p.text.length);
                    if (showsRows) blockCounts.set(p.by, (blockCounts.get(p.by) ?? 0) + p.text.length);
                }
                if (p.id) keys.push(`${p.id[0]}:${p.id[1]}`);
            }
            unitInfo.set(u, { counts, keys });
        }
        const base0 = changes.length;
        const made: { rows: number[]; add: number; del: number; keys: string[]; authors: string[] }[] = [];
        for (const u of units) {
            const index = indexOf.get(u);
            if (index === undefined) continue;
            const info = unitInfo.get(u);
            // A change nobody is known to have made (a deletion, compared by text) takes its neighbours' people.
            const counts = info && info.counts.size ? info.counts : blockCounts.size ? blockCounts : new Map([[fallback, 1]]);
            made[index - base0] = { rows: [], add: 0, del: 0, keys: info?.keys ?? [], authors: ranked(counts) };
            for (const [p, n] of counts) fileAuthors.set(p, (fileAuthors.get(p) ?? 0) + n);
        }
        const firstRow = rows.length;
        for (const d of drafts) {
            const index = d.unit === -1 ? -1 : (indexOf.get(d.unit) ?? -1);
            const m = index >= 0 ? made[index - base0] : undefined;
            if (m && d.row.kind !== 'ctx') {
                m.rows.push(rows.length);
                if (d.row.kind === 'add') m.add++;
                else m.del++;
                if (m.keys.length === 0 || m.keys.every(k => /^[-+]/.test(k))) {
                    // No ids: the change is known by its lines' text, each with its occurrence in the file.
                    const k = `${d.row.kind === 'del' ? '-' : '+'}${d.row.text}`;
                    const n = textKeys.get(k) ?? 0;
                    textKeys.set(k, n + 1);
                    m.keys.push(`${k}#${n}`);
                }
            }
            rows.push({ ...d.row, change: m ? index : -1, authors: m && d.row.authors.length === 0 ? m.authors : d.row.authors });
        }
        markPairs(
            rows,
            Array.from({ length: rows.length - firstRow }, (_, k) => firstRow + k).filter(k => rows[k]?.kind !== 'ctx'),
        );
        made.forEach((m, k) => {
            add += m.add;
            del += m.del;
            changes.push({ index: base0 + k, keys: m.keys, authors: m.authors, rows: m.rows, add: m.add, del: m.del });
        });
    }

    return { rows, changes, hunks: hunksOf(rows, changes), add, del, authors: ranked(fileAuthors), pieces, pieceChange };
}

/** Marks the changed part of deleted and added lines that pair up (the n-th deletion of a run with its n-th insertion),
 *  from their common prefix and suffix, widened to word boundaries. */
function markPairs(rows: Row[], at: readonly number[]): void {
    let k = 0;
    while (k < at.length) {
        const dels: number[] = [];
        const adds: number[] = [];
        while (k < at.length && rows[at[k] ?? -1]?.kind === 'del') dels.push(at[k++] ?? -1);
        while (k < at.length && rows[at[k] ?? -1]?.kind === 'add') adds.push(at[k++] ?? -1);
        if (dels.length === 0 && adds.length === 0) k++;
        for (let n = 0; n < Math.min(dels.length, adds.length); n++) {
            const d = rows[dels[n] ?? -1];
            const a = rows[adds[n] ?? -1];
            if (!d || !a) continue;
            let p = 0;
            while (p < d.text.length && p < a.text.length && d.text[p] === a.text[p]) p++;
            let s = 0;
            while (s < d.text.length - p && s < a.text.length - p && d.text[d.text.length - 1 - s] === a.text[a.text.length - 1 - s]) s++;
            const word = /\w/;
            // Widened where the cut splits a word, so that a changed word is marked whole.
            const w = (c: string | undefined): boolean => c !== undefined && word.test(c);
            while (p > 0 && w(d.text[p - 1]) && (w(d.text[p]) || w(a.text[p]))) p--;
            while (s > 0 && w(d.text[d.text.length - s]) && (w(d.text[d.text.length - s - 1]) || w(a.text[a.text.length - s - 1]))) s--;
            if (p === 0 && s === 0) continue;
            rows[dels[n] ?? -1] = { ...d, mark: [p, d.text.length - s] };
            rows[adds[n] ?? -1] = { ...a, mark: [p, a.text.length - s] };
        }
    }
}

function hunksOf(rows: readonly Row[], changes: readonly Change[]): Hunk[] {
    const hunks: { start: number; end: number; changes: number[] }[] = [];
    let cur: { start: number; end: number; changes: number[] } | null = null;
    for (const c of changes) {
        const first = c.rows[0] ?? 0;
        const last = c.rows.at(-1) ?? 0;
        const start = Math.max(0, first - CONTEXT);
        const end = Math.min(rows.length, last + 1 + CONTEXT);
        if (cur && start <= cur.end) {
            cur.end = end;
            cur.changes.push(c.index);
        } else {
            cur = { start, end, changes: [c.index] };
            hunks.push(cur);
        }
    }
    return hunks.map(h => {
        let header = '';
        for (let i = h.start - 1; i >= 0; i--) {
            const r = rows[i];
            if (r && r.kind !== 'del' && HEADING.test(r.text)) {
                header = r.text.trim();
                break;
            }
        }
        let oldStart = 1;
        let newStart = 1;
        for (let i = h.start; i < h.end; i++) {
            const r = rows[i];
            if (r?.old != null) {
                oldStart = r.old;
                break;
            }
        }
        for (let i = h.start; i < h.end; i++) {
            const r = rows[i];
            if (r?.new != null) {
                newStart = r.new;
                break;
            }
        }
        return { start: h.start, end: h.end, changes: h.changes, header, oldStart, newStart };
    });
}

/** The file's text with the changes `included` says yes to taken and the others left as committed, and the ids of
 *  its characters (null when the review has no ids to give). Groups with nothing to show are taken as they are now. */
export function committedText(r: FileReview, included: (change: number) => boolean): { text: string; items: IdSet | null } {
    let text = '';
    let items: IdSet | null = new IdSet();
    r.pieces.forEach((p, i) => {
        const c = r.pieceChange[i] ?? -1;
        const take = c === -1 ? p.base && p.now : c === -2 ? p.now : included(c) ? p.now : p.base;
        if (!take) return;
        text += p.text;
        if (p.id) items?.add(p.id[0], p.id[1], p.text.length);
        else items = null;
    });
    return { text, items };
}

/** The session's text with the changes `revert` says yes to put back as committed, and everything else as it is. */
export function revertedText(r: FileReview, revert: (change: number) => boolean): string {
    let text = '';
    r.pieces.forEach((p, i) => {
        const c = r.pieceChange[i] ?? -1;
        if (c >= 0 && revert(c) ? p.base : p.now) text += p.text;
    });
    return text;
}

/** Runs for two texts compared by lines, without the CRDT: unchanged lines, then each block of deleted lines before its
 *  inserted ones. Insertions are `by`'s; deletions have no known author. */
export function textRuns(base: string, now: string, by: (line: string) => string | null): Run[] {
    const a = base === '' ? [] : base.split(/(?<=\n)/);
    const b = now === '' ? [] : now.split(/(?<=\n)/);
    const runs: Run[] = [];
    let i = 0;
    let j = 0;
    for (const [pi, pj] of [...lcsPairs(a, b), [a.length, b.length] as [number, number]]) {
        for (; i < pi; i++) runs.push({ text: a[i] ?? '', base: true, now: false, id: null, by: null });
        for (; j < pj; j++) runs.push({ text: b[j] ?? '', base: false, now: true, id: null, by: by(b[j] ?? '') });
        if (pi < a.length) runs.push({ text: a[pi] ?? '', base: true, now: true, id: null, by: null });
        i = pi + 1;
        j = pj + 1;
    }
    return runs;
}
