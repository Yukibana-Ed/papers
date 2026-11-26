import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RELEASE_SHA256, checkRelease } from '../scripts/engine-release.ts';

describe('the busytex release check', () => {
    it('pins the installed version', () => {
        const require = createRequire(import.meta.url);
        const pkg = JSON.parse(readFileSync(require.resolve('texlyre-busytex/package.json'), 'utf8')) as { version: string };
        expect(RELEASE_SHA256[pkg.version]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('takes the pinned bytes and refuses any others', () => {
        const data = new TextEncoder().encode('release');
        const hash = createHash('sha256').update(data).digest('hex');
        const pins = { '1.0.0': hash };
        expect(() => checkRelease('1.0.0', data, pins)).not.toThrow();
        expect(() => checkRelease('1.0.0', new TextEncoder().encode('replaced'), pins)).toThrow(/not the pinned/);
        expect(() => checkRelease('9.9.9', data, pins)).toThrow(/no SHA-256 pinned/);
    });
});
