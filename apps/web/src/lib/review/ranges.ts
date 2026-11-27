/** Values over ranges of Yjs character ids: per client, `[clock, len, value]` entries. Later entries win where they
 *  overlap earlier ones (a deletion recorded twice, by the deleter's window and then by the room, names one person). */
export class RangeMap<T> {
    private readonly byClient = new Map<number, [number, number, T][]>();

    set(client: number, clock: number, len: number, value: T): void {
        if (len <= 0) return;
        const list = this.byClient.get(client) ?? [];
        list.push([clock, len, value]);
        this.byClient.set(client, list);
    }

    /** The value at `client`'s `clock`, and for how many clocks from there (at most `len`) the answer stays the same. */
    at(client: number, clock: number, len: number): { readonly value: T | null; readonly len: number } {
        const list = this.byClient.get(client);
        if (!list) return { value: null, len };
        let value: T | null = null;
        let end = clock + len;
        // Any entry's start or end inside the run may change the answer, so the run stops there.
        for (const [c, n, v] of list) {
            if (c <= clock && clock < c + n) value = v;
            if (c > clock && c < end) end = c;
            if (c + n > clock && c + n < end) end = c + n;
        }
        return { value, len: end - clock };
    }
}
