import { describe, expect, it } from 'vitest';
import { appOrigin } from '#lib/origin.ts';

const platform = (env: Record<string, unknown>): App.Platform => ({ env }) as unknown as App.Platform;

describe('appOrigin', () => {
    it('is the Worker var outside development', () => {
        expect(appOrigin(platform({ APP_ORIGIN: 'https://papers.yukibana.dev' }), false)).toBe('https://papers.yukibana.dev');
    });

    it('fails, never falls back to a local address, when the var is missing outside development', () => {
        expect(() => appOrigin(platform({}), false)).toThrow(/APP_ORIGIN/);
    });
});
