import { describe, expect, it } from 'vitest';
import { contentOrigin } from '#lib/server/content-origin.ts';

const platform = (env: Record<string, unknown>): App.Platform => ({ env: env as never });

describe('contentOrigin', () => {
    it('is the Worker var outside development', () => {
        expect(contentOrigin(platform({ CONTENT_ORIGIN: 'https://user-content-papers.yukibana.run' }), false)).toBe('https://user-content-papers.yukibana.run');
    });

    it('fails, never falls back to a local address, when the var is missing outside development', () => {
        expect(() => contentOrigin(platform({}), false)).toThrow(/CONTENT_ORIGIN/);
        expect(() => contentOrigin(undefined, false)).toThrow(/CONTENT_ORIGIN/);
    });

    it('is the local content app in development, whatever wrangler.jsonc says', () => {
        expect(contentOrigin(platform({ CONTENT_ORIGIN: 'https://user-content-papers.yukibana.run' }), true)).toMatch(/^http:\/\/localhost:/);
    });
});
