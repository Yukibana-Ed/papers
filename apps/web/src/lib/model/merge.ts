/** A three-way merge of text by lines, as `git merge-file` does it. */

export interface Merged {
    readonly text: string;
    /** How many places both sides changed differently: each is kept as both versions between git's conflict markers. */
    readonly conflicts: number;
}

/** For each line of `a`, the index of the line of `b` it is matched with in a longest common subsequence, or -1. */
function matches(a: readonly string[], b: readonly string[]): Int32Array {
    const out = new Int32Array(a.length).fill(-1);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        out[start] = start;
        start++;
    }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
        out[endA] = endB;
    }
    const n = endA - start;
    const m = endB - start;
    if (n === 0 || m === 0) return out;
    // The table of LCS lengths of the suffixes, then one walk through it.
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * (m + 1) + j] =
                a[start + i] === b[start + j] ? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[start + i] === b[start + j]) {
            out[start + i] = start + j;
            i++;
            j++;
        } else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + j + 1] ?? 0)) i++;
        else j++;
    }
    return out;
}

/** `ours` and `theirs`, both edited from `base`, as one text: a change only one side made is taken; a place both
 *  changed the same way is taken once; a place both changed differently is a conflict, kept as
 *  `<<<<<<< oursName`, ours, `=======`, theirs, `>>>>>>> theirsName`, as git writes it. Where both sides only
 *  changed lines in place, neighbouring lines changed by one side each are not a conflict (git would call them one).
 *
 *  Promises: `ours === base` gives `theirs`, `theirs === base` gives `ours`, and equal sides give that text, each
 *  with no conflicts. Lines are split at `\n`. Quadratic in the lines that differ from `base`. */
export function merge3(base: string, ours: string, theirs: string, oursName = 'ours', theirsName = 'theirs'): Merged {
    if (ours === theirs || theirs === base) return { text: ours, conflicts: 0 };
    if (ours === base) return { text: theirs, conflicts: 0 };
    const o = base.split('\n');
    const a = ours.split('\n');
    const b = theirs.split('\n');
    const toA = matches(o, a);
    const toB = matches(o, b);
    const out: string[] = [];
    let conflicts = 0;
    let io = 0;
    let ia = 0;
    let ib = 0;
    const same = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((line, k) => line === y[k]);
    const conflict = (x: readonly string[], y: readonly string[]): void => {
        conflicts++;
        out.push(`<<<<<<< ${oursName}`, ...x, '=======', ...y, `>>>>>>> ${theirsName}`);
    };
    while (io <= o.length) {
        // The next line of the base that both sides kept, or the end: everything before it is one region.
        let next = io;
        while (next < o.length && (toA[next] === -1 || toB[next] === -1)) next++;
        const endA = next < o.length ? (toA[next] ?? a.length) : a.length;
        const endB = next < o.length ? (toB[next] ?? b.length) : b.length;
        const baseRegion = o.slice(io, next);
        const aRegion = a.slice(ia, endA);
        const bRegion = b.slice(ib, endB);
        if (same(aRegion, bRegion) || same(bRegion, baseRegion)) out.push(...aRegion);
        else if (same(aRegion, baseRegion)) out.push(...bRegion);
        else if (aRegion.length === baseRegion.length && bRegion.length === baseRegion.length) {
            // Both sides changed lines here without adding or removing any (neighbouring lines of a paragraph, each
            // edited by someone): line by line, with a run of lines both changed differently as one conflict.
            let k = 0;
            while (k < baseRegion.length) {
                const differ = (n: number): boolean => aRegion[n] !== bRegion[n] && aRegion[n] !== baseRegion[n] && bRegion[n] !== baseRegion[n];
                if (!differ(k)) {
                    out.push((aRegion[k] === baseRegion[k] ? bRegion[k] : aRegion[k]) ?? '');
                    k++;
                    continue;
                }
                let end = k;
                while (end < baseRegion.length && differ(end)) end++;
                conflict(aRegion.slice(k, end), bRegion.slice(k, end));
                k = end;
            }
        } else conflict(aRegion, bRegion);
        if (next >= o.length) break;
        out.push(o[next] ?? '');
        io = next + 1;
        ia = endA + 1;
        ib = endB + 1;
    }
    return { text: out.join('\n'), conflicts };
}
