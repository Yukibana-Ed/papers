// Bundles the CLI and the workspace libraries it uses into lib/index.js, and puts the sandbox's native files next to
// it (the sandbox finds them relative to its own module: ../native from lib/).
import { cpSync, rmSync } from 'node:fs';
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
