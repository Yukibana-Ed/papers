import { describe, expect, it } from 'vitest';
import { checkTicket, mintTicket, roomName } from '#lib/server/room-ticket.ts';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 11)));

describe('room tickets', () => {
    const room = roomName('Yukibana-Ed', 'Papers', 'main');
    const t = { login: 'ada', name: 'Ada', access: 'write' as const, room, expires: 2_000 };

    it('name rooms case-insensitively by repository, not by branch', () => {
        expect(room).toBe('yukibana-ed/papers#main');
        expect(roomName('a', 'b', 'Main')).not.toBe(roomName('a', 'b', 'main'));
    });

    it('open for their room until they expire', async () => {
        const raw = await mintTicket(KEY, t);
        expect(await checkTicket(KEY, raw, room, 1_000)).toEqual(t);
        expect(await checkTicket(KEY, raw, room, 3_000)).toBeNull();
        expect(await checkTicket(KEY, raw, roomName('yukibana-ed', 'papers', 'other'), 1_000)).toBeNull();
    });

    it('do not open with another key, or when tampered with', async () => {
        const raw = await mintTicket(KEY, t);
        expect(await checkTicket(OTHER, raw, room, 1_000)).toBeNull();
        const flipped = raw.slice(0, -2) + (raw.endsWith('A') ? 'B' : 'A') + raw.slice(-1);
        expect(await checkTicket(KEY, flipped, room, 1_000)).toBeNull();
        expect(await checkTicket(KEY, '', room, 1_000)).toBeNull();
    });
});
