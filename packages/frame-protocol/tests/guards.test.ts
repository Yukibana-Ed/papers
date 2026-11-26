import { describe, expect, it } from 'vitest';
import { HELLO, isAppMessage, isFrameMessage, isHello } from '../src/index.ts';

describe('guards', () => {
    it('accept known types only', () => {
        expect(isAppMessage({ type: 'zoom', zoom: 1 })).toBe(true);
        expect(isAppMessage({ type: 'built' })).toBe(false);
        expect(isFrameMessage({ type: 'built', ok: true })).toBe(true);
        expect(isFrameMessage(null)).toBe(false);
    });

    it('recognise the handshake', () => {
        expect(isHello({ kind: HELLO, version: 1 })).toBe(true);
        expect(isHello({ kind: HELLO })).toBe(false);
    });
});
