// Bundles the CLI and the workspace libraries it uses into lib/index.js, and puts the sandbox's native files and the
// incremental engine's modules next to it (each is found relative to the bundle: ../native from lib/).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

rmSync('lib', { recursive: true, force: true });
rmSync('native', { recursive: true, force: true });
await build({
    entryPoints: ['src/index.ts'],
    outfile: 'lib/index.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // ws's optional native speed-ups; it works without them.
    external: ['bufferutil', 'utf-8-validate'],
    // A bundled CommonJS dependency may call require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __papersRequire } from 'node:module'; const require = __papersRequire(import.meta.url);" },
    logLevel: 'warning',
});
cpSync('../sandbox/native', 'native', { recursive: true });
const engine = dirname(createRequire(import.meta.url).resolve('@yukibana/pdftex-wasm/package.json'));
mkdirSync('native/pdftex', { recursive: true });
for (const f of ['pdftex.wasm', 'bibtex8.wasm', 'LICENSE', 'LICENSE.bibtex8', 'MODIFICATIONS.md']) cpSync(join(engine, f), join('native/pdftex', f));
