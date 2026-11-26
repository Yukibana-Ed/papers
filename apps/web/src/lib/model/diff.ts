/** Lines added and deleted between `a` and `b`, as `git diff --stat` counts them: from a longest common subsequence of
 *  lines. Quadratic in the line counts; for files much longer than a paper's section it trims the common prefix and
 *  suffix first, which is where edits usually leave most of a file. */
export function changedLines(a: string, b: string): { add: number; del: number } {
    let x = a.split('\n');
    let y = b.split('\n');
    let start = 0;
    while (start < x.length && start < y.length && x[start] === y[start]) start++;
    let endX = x.length;
    let endY = y.length;
    while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
        endX--;
        endY--;
    }
    x = x.slice(start, endX);
    y = y.slice(start, endY);
    if (x.length === 0 || y.length === 0) return { add: y.length, del: x.length };
    // One row of the LCS table at a time.
    let next = new Uint32Array(y.length + 1);
    let cur = new Uint32Array(y.length + 1);
    for (let i = x.length - 1; i >= 0; i--) {
        for (let j = y.length - 1; j >= 0; j--) cur[j] = x[i] === y[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, cur[j + 1] ?? 0);
        [next, cur] = [cur, next];
    }
    const common = next[0] ?? 0;
    return { add: y.length - common, del: x.length - common };
}
