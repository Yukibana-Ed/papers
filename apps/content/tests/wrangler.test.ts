import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('wrangler.jsonc', () => {
    it('never sets the browser tests’ asset fallback, so production serves its own bucket only', () => {
        const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
        expect(config).not.toContain('ASSETS_FALLBACK');
    });
});
