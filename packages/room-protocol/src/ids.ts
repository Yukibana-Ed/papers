/** A set of Yjs character ids: per client, the clocks it holds, as sorted, disjoint, non-adjacent ranges.
 *
 *  A file's committed state names its characters this way (`BaseFile.items`): every character of a Y.Text has an id
 *  (the client that wrote it and that client's clock), and ids never change or get reused, so a set of them keeps
 *  meaning the same characters whatever else happens to the text, concurrent and offline edits included. */
export class IdSet {
    /** client → [clock, length] ranges, sorted by clock, disjoint, with a gap between neighbours. */
    private readonly byClient = new Map<number, [number, number][]>();

    /** Adds `len` clocks of `client` from `clock`. Precondition: all three are non-negative integers. Does nothing
     *  when `len` is 0. */
    add(client: number, clock: number, len: number): void {
        if (len <= 0) return;
        const list = this.byClient.get(client) ?? [];
        this.byClient.set(client, list);
        let start = clock;
        let end = clock + len;
        // The first range that ends at or after `start` (touching counts, so neighbours merge).
        let i = 0;
        while (i < list.length && (list[i]?.[0] ?? 0) + (list[i]?.[1] ?? 0) < start) i++;
        let j = i;
        while (j < list.length && (list[j]?.[0] ?? 0) <= end) {
            const r = list[j];
            if (r) {
                start = Math.min(start, r[0]);
                end = Math.max(end, r[0] + r[1]);
            }
            j++;
        }
        list.splice(i, j - i, [start, end - start]);
    }

    /** Whether `client`'s `clock` is in the set. Logarithmic in the client's ranges. */
    has(client: number, clock: number): boolean {
        const list = this.byClient.get(client);
        if (!list) return false;
        let lo = 0;
        let hi = list.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const r = list[mid];
            if (!r) return false;
            if (clock < r[0]) hi = mid - 1;
            else if (clock >= r[0] + r[1]) lo = mid + 1;
            else return true;
        }
        return false;
    }

    /** How many clocks from `clock` on (at most `len`) are in the set, or not, alike: the length of the run starting at
     *  `clock` whose members all answer `has` the same. Lets a caller walk a long item in runs instead of per character. */
    run(client: number, clock: number, len: number): { readonly inSet: boolean; readonly len: number } {
        const list = this.byClient.get(client) ?? [];
        for (const [c, n] of list) {
            if (clock < c) return { inSet: false, len: Math.min(len, c - clock) };
            if (clock < c + n) return { inSet: true, len: Math.min(len, c + n - clock) };
        }
        return { inSet: false, len };
    }

    /** Every range, by client, then by clock. */
    *ranges(): Generator<readonly [client: number, clock: number, len: number]> {
        for (const client of [...this.byClient.keys()].toSorted((a, b) => a - b)) for (const [clock, len] of this.byClient.get(client) ?? []) yield [client, clock, len];
    }

    /** How many ids the set holds. */
    get size(): number {
        let n = 0;
        for (const list of this.byClient.values()) for (const r of list) n += r[1];
        return n;
    }

    /** The set as text: `client:clock+len,clock+len;client:…`, clients and clocks ascending. `decode` reads it back. */
    encode(): string {
        const parts: string[] = [];
        for (const client of [...this.byClient.keys()].toSorted((a, b) => a - b)) {
            const list = this.byClient.get(client) ?? [];
            if (list.length) parts.push(`${client}:${list.map(([c, n]) => `${c}+${n}`).join(',')}`);
        }
        return parts.join(';');
    }

    /** The set `text` encodes, or null when it is not `encode`'s output shape. Others' words: every number is checked. */
    static decode(text: string): IdSet | null {
        const set = new IdSet();
        if (text === '') return set;
        const int = (s: string): number | null => (/^\d{1,15}$/.test(s) ? Number(s) : null);
        for (const part of text.split(';')) {
            const [head, body, ...rest] = part.split(':');
            const client = int(head ?? '');
            if (client === null || body === undefined || rest.length) return null;
            for (const r of body.split(',')) {
                const [c, n, ...more] = r.split('+');
                const clock = int(c ?? '');
                const len = int(n ?? '');
                if (clock === null || len === null || more.length) return null;
                set.add(client, clock, len);
            }
        }
        return set;
    }
}
