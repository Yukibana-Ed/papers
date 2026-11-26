import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TYPST_ASSETS, TYPST_COMPILER_BUILD, typstAssetKey } from '#lib/typst-assets.ts';

describe('the Typst compiler', () => {
    it('is served under the name of the build its loading script is from', () => {
        const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@myriaddreamin/typst-ts-web-compiler/package.json')), 'utf8'));
        expect(pkg).toMatchObject({ version: TYPST_COMPILER_BUILD });
        expect(TYPST_ASSETS.compiler.key).toBe(`typst/${TYPST_COMPILER_BUILD}/`);
        expect(typstAssetKey('typst', 'typst_ts_web_compiler_bg.wasm')).toBe(`typst/${TYPST_COMPILER_BUILD}/typst_ts_web_compiler_bg.wasm`);
    });
});
