// The Typst side of the content origin's assets: our build of the typst.ts compiler (packages/typst-wasm), tinymist's
// web build, and Typst's default fonts.
//
//   node scripts/typst.ts fetch [dir]          tinymist's web build into <dir>/tinymist (default .engine), checked against
//                                              its pinned SHA-256; what the dev server serves at /engine/tinymist
//   node scripts/typst.ts stage <out>          everything the content origin serves, brotli-compressed, laid out as the
//                                              bucket's keys (typst/<v>/, tinymist/<v>/, typst-fonts/<v>/) under <out>
//   node scripts/typst.ts seed                 our compiler build into the local bucket of `wrangler dev`, for the browser
//                                              tests: they run this checkout's build, which the deployed origin (their
//                                              source for every other asset) may not have yet
//
// .github/workflows/assets.yml uploads <out> to the bucket. tinymist and the fonts are upstream's, unmodified.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { TINYMIST_VERSION, TINYMIST_WEB_SHA256, TYPST_ASSETS, TYPST_FONTS_VERSION } from '../src/lib/typst-assets.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function download(url: string): Promise<Buffer> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/** tinymist's web build, checked, unpacked into `<dir>/tinymist`. */
async function fetchTinymist(dir: string): Promise<string> {
    const target = join(dir, 'tinymist');
    if (existsSync(join(target, 'tinymist_bg.wasm'))) return target;
    const url = `https://github.com/Myriad-Dreamin/tinymist/releases/download/v${TINYMIST_VERSION}/tinymist-web.tar.gz`;
    console.log(`downloading ${url}`);
    const bytes = await download(url);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== TINYMIST_WEB_SHA256) throw new Error(`tinymist-web.tar.gz has SHA-256 ${digest}, not the pinned ${TINYMIST_WEB_SHA256}`);
    const tmp = join(dir, '.tinymist-unpack');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'web.tar.gz'), bytes);
    // On Windows the in-box bsdtar: a GNU tar earlier on the PATH (Git for Windows) reads C: as a remote host.
    const tar = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', join(tmp, 'web.tar.gz'), '-C', tmp], { stdio: 'inherit' });
    mkdirSync(target, { recursive: true });
    copyFileSync(join(tmp, 'package', 'pkg', 'tinymist_bg.wasm'), join(target, 'tinymist_bg.wasm'));
    rmSync(tmp, { recursive: true, force: true });
    console.log(`tinymist ${TINYMIST_VERSION} in ${target}`);
    return target;
}

function brotli(bytes: Buffer): Buffer {
    return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
}

async function stage(out: string): Promise<void> {
    const put = (key: string, bytes: Buffer): void => {
        const file = join(out, key);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, brotli(bytes));
        console.log(`${key}: ${bytes.length} bytes, ${readFileSync(file).length} compressed`);
    };
    for (const f of TYPST_ASSETS.compiler.files) put(`${TYPST_ASSETS.compiler.key}${f}`, readFileSync(join(compilerDir(), f)));
    const tinymist = await fetchTinymist(join(out, '..', 'typst-fetch'));
    for (const f of TYPST_ASSETS.tinymist.files) put(`${TYPST_ASSETS.tinymist.key}${f}`, readFileSync(join(tinymist, f)));
    for (const f of TYPST_ASSETS.fonts.files)
        put(`${TYPST_ASSETS.fonts.key}${f}`, await download(`https://cdn.jsdelivr.net/gh/typst/typst-assets@${TYPST_FONTS_VERSION}/files/fonts/${f}`));
}

const compilerDir = (): string => join(dirname(fileURLToPath(import.meta.resolve('@myriaddreamin/typst-ts-web-compiler/package.json'))), 'pkg');

function seed(): void {
    for (const f of TYPST_ASSETS.compiler.files)
        execFileSync('pnpm', ['exec', 'wrangler', 'r2', 'object', 'put', `yukibana-papers-assets/${TYPST_ASSETS.compiler.key}${f}`, '--local', '--file', join(compilerDir(), f)], {
            cwd: join(here, '..'),
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
}

const [command, arg] = process.argv.slice(2);
if (command === 'fetch') await fetchTinymist(arg ?? join(here, '..', '.engine'));
else if (command === 'stage' && arg) await stage(arg);
else if (command === 'seed') seed();
else {
    console.error('usage: node scripts/typst.ts fetch [dir] | stage <out> | seed');
    process.exit(2);
}
