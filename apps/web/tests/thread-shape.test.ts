import { describe, expect, it } from 'vitest';
import { parseRoomThread } from '#lib/room/thread-shape.ts';

const comment = { id: 'c1', author: 'ada', when: '2026-11-01T10:00:00Z', resolved: false, body: 'Why?', replies: [] };
const thread = { id: 't1', source: 'team', file: 'paper.tex', quote: 'important', range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 9 }, root: comment };

describe('threads from the room', () => {
    it('keeps threads', () => {
        expect(parseRoomThread('t1', JSON.stringify(thread))).toEqual(thread);
        const nested = { ...thread, root: { ...comment, replacement: 'central', replies: [{ ...comment, id: 'c2', resolved: true }] } };
        expect(parseRoomThread('t1', JSON.stringify(nested))).toEqual(nested);
        const { range: _, ...anywhere } = thread;
        expect(parseRoomThread('t1', JSON.stringify(anywhere))).toEqual(anywhere);
    });

    it('drops what is not one', () => {
        for (const bad of [
            'not json',
            'null',
            '[]',
            JSON.stringify({ ...thread, id: 't2' }),
            JSON.stringify({ ...thread, source: 'evil' }),
            JSON.stringify({ ...thread, file: 3 }),
            JSON.stringify({ ...thread, draft: true }),
            JSON.stringify({ ...thread, range: { startLineNumber: 0 } }),
            JSON.stringify({ ...thread, root: null }),
            JSON.stringify({ ...thread, root: { ...comment, body: { html: '<img onerror=x>' } } }),
            JSON.stringify({ ...thread, root: { ...comment, replies: [{ id: 'c2' }] } }),
            JSON.stringify({ ...thread, root: { ...comment, replies: 'none' } }),
        ])
            expect(parseRoomThread('t1', bad), bad).toBeNull();
    });

    it('drops replies nested without end', () => {
        let c: Record<string, unknown> = { ...comment };
        for (let i = 0; i < 100; i++) c = { ...comment, replies: [c] };
        expect(parseRoomThread('t1', JSON.stringify({ ...thread, root: c }))).toBeNull();
    });
});
