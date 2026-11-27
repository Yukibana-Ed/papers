import { describe, expect, it } from 'vitest';
import { IdSet, parseClientMessage } from '../src/index.ts';

describe('character id sets', () => {
    it('merges touching and overlapping ranges and answers membership', () => {
        const s = new IdSet();
        s.add(7, 10, 5);
        s.add(7, 0, 3);
        s.add(7, 15, 2);
        s.add(7, 2, 9);
        expect([...s.ranges()]).toEqual([[7, 0, 17]]);
        s.add(3, 4, 1);
        expect(s.has(3, 4)).toBe(true);
        expect(s.has(3, 5)).toBe(false);
        expect(s.has(7, 16)).toBe(true);
        expect(s.has(7, 17)).toBe(false);
        expect(s.size).toBe(18);
    });

    it('walks an item in runs of members and non-members', () => {
        const s = IdSet.decode('1:2+3,8+2');
        expect(s?.run(1, 0, 20)).toEqual({ inSet: false, len: 2 });
        expect(s?.run(1, 3, 20)).toEqual({ inSet: true, len: 2 });
        expect(s?.run(1, 5, 20)).toEqual({ inSet: false, len: 3 });
        expect(s?.run(1, 10, 20)).toEqual({ inSet: false, len: 20 });
    });

    it('reads back what it writes, and refuses anything else', () => {
        const s = new IdSet();
        s.add(42, 0, 10);
        s.add(5, 3, 1);
        s.add(5, 9, 2);
        expect(s.encode()).toBe('5:3+1,9+2;42:0+10');
        expect(IdSet.decode(s.encode())?.encode()).toBe(s.encode());
        expect(IdSet.decode('')?.size).toBe(0);
        for (const bad of ['x', '1:', '1:2', '1:2+', '-1:2+3', '1:2+3:4', '1:2+3+4']) expect(IdSet.decode(bad)).toBeNull();
    });

    it('lets a commit through only with a well-formed id set per file', () => {
        expect(parseClientMessage({ type: 'committed', commit: 'c', files: [{ path: 'a', blob: '', text: 'x', items: '1:0+1' }] })).not.toBeNull();
        expect(parseClientMessage({ type: 'committed', commit: 'c', files: [{ path: 'a', blob: '', text: 'x', items: 'nope' }] })).toBeNull();
        expect(parseClientMessage({ type: 'committed', commit: 'c', files: [{ path: 'a', blob: '', text: 'x' }] })).toBeNull();
    });
});
