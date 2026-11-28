// Our pdfTeX's side of the content origin's assets: the modules of the engine (packages/pdftex-wasm, the
// `@yukibana/pdftex-wasm` dependency) and the LaTeX format the engine dumps from a TeX Live installation.
//
//   node scripts/pdftex.ts format <texlive root> <file>      dumps pdflatex.fmt from the installation, as its own
//                                                            fmtutil would, with our engine, into <file>
//   node scripts/pdftex.ts stage <out> [<format> <snapshot>] the modules, and the format of the snapshot when given,
//                                                            brotli-compressed, laid out as the bucket's keys under <out>
//   node scripts/pdftex.ts dev <texlive root> [dir]          the modules and a format for the dev server, which
//                                                            serves <dir>/pdftex (default .engine) at /engine/pdftex
//
// .github/workflows/assets.yml runs `stage` and uploads <out>. `PDFTEX_WASM` names a pdftex.wasm (with bibtex8.wasm
// beside it) to use in place of the dependency's, for a build of the engine that is not released yet.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { dumpFormat } from '@yukibana/papers-tex-engine';
import { DiskTree } from '@yukibana/papers-tex-engine/node';
import { FORMAT_FILE, PDFTEX_MODULES, pdftexAssetKey } from '../src/lib/pdftex-assets.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The folder with the engine's modules. */
function modules(): string {
    const named = process.env['PDFTEX_WASM'];
    return named !== undefined && named !== '' ? dirname(resolve(named)) : dirname(fileURLToPath(import.meta.resolve('@yukibana/pdftex-wasm/package.json')));
}

/** The format of the installation at `root` (the folder with texmf-dist), dumped by our engine. The engine sees the
 *  installation as its own pdftex does: from its place among the installation's programs. */
function format(root: string): Uint8Array {
    const bin = join(resolve(root), 'bin');
    const program = join(bin, 'x86_64-linux', 'pdftex');
    if (!existsSync(join(resolve(root), 'texmf-dist', 'ls-R'))) throw new Error(`${root} is not a TeX Live installation: it has no texmf-dist/ls-R`);
    const t0 = Date.now();
    const made = dumpFormat(
        new WebAssembly.Module(readFileSync(join(modules(), 'pdftex.wasm'))),
        new DiskTree(new Map([[program, new Uint8Array(0)]])),
        program,
        Math.floor(t0 / 1000),
    );
    console.log(`${FORMAT_FILE}: ${made.length} bytes, dumped in ${Date.now() - t0} ms`);
    return made;
}

function brotli(bytes: Uint8Array): Buffer {
    return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
}

function stage(out: string, formatFile: string | undefined, snapshot: string | undefined): void {
    const put = (key: string | null, bytes: Uint8Array): void => {
        if (key === null) throw new Error('not a file of the engine');
        const file = join(out, key);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, brotli(bytes));
        console.log(`${key}: ${bytes.length} bytes, ${readFileSync(file).length} compressed`);
    };
    for (const f of PDFTEX_MODULES) put(pdftexAssetKey(f, ''), readFileSync(join(modules(), f)));
    if (formatFile !== undefined && snapshot !== undefined) put(pdftexAssetKey(FORMAT_FILE, snapshot), readFileSync(formatFile));
}

function dev(root: string, dir: string): void {
    const target = join(dir, 'pdftex');
    mkdirSync(target, { recursive: true });
    for (const f of PDFTEX_MODULES) copyFileSync(join(modules(), f), join(target, f));
    writeFileSync(join(target, FORMAT_FILE), format(root));
    console.log(`the engine and its format are in ${target}`);
}

const [command, a, b, c] = process.argv.slice(2);
if (command === 'format' && a !== undefined && b !== undefined) writeFileSync(b, format(a));
else if (command === 'stage' && a !== undefined) stage(a, b, c);
else if (command === 'dev' && a !== undefined) dev(a, b ?? join(here, '..', '.engine'));
else {
    console.error('usage: node scripts/pdftex.ts format <texlive root> <file> | stage <out> [<format> <snapshot>] | dev <texlive root> [dir]');
    process.exit(2);
}
