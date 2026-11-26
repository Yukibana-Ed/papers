// The engine's release files: texlyre-busytex's assets, which its npm package does not contain.
//
//   node scripts/engine.ts fetch [dir]          download and unpack the release of the installed version (default .engine)
//   node scripts/engine.ts stage <dir> <out>    brotli-compress the files the content origin serves into <out>
//
// `fetch` fills what the dev server serves at /engine; `stage` prepares what .github/workflows/assets.yml uploads to
// `engine/<version>/` in the bucket. The release is unmodified.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { ENGINE_FILES } from '../src/lib/engine-files.ts';
import { checkRelease } from './engine-release.ts';

function version(): string {
    const require = createRequire(import.meta.url);
    const pkg: unknown = JSON.parse(readFileSync(require.resolve('texlyre-busytex/package.json'), 'utf8'));
    if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('texlyre-busytex has no version');
    return pkg.version;
}

async function fetchRelease(dir: string): Promise<void> {
    const v = version();
    const target = join(dir, 'busytex');
    if (ENGINE_FILES.every(f => existsSync(join(target, f)))) {
        console.log(`engine ${v} already in ${target}`);
        return;
    }
    const url = `https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v${v}/busytex-assets.tar.gz`;
    console.log(`downloading ${url} (about 500 MB)`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    checkRelease(v, data);
    mkdirSync(dir, { recursive: true });
    const archive = join(dir, 'busytex-assets.tar.gz');
    writeFileSync(archive, data);
    execFileSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'inherit' });
    rmSync(archive);
    const missing = ENGINE_FILES.filter(f => !existsSync(join(target, f)));
    if (missing.length > 0) throw new Error(`the release lacks ${missing.join(', ')}`);
    console.log(`engine ${v} in ${target}`);
}

function stage(dir: string, out: string): void {
    mkdirSync(out, { recursive: true });
    for (const f of ENGINE_FILES) {
        const buf = readFileSync(join(dir, f));
        writeFileSync(
            join(out, f),
            brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
        );
    }
    console.log(`staged ${ENGINE_FILES.length} files of engine ${version()} in ${out}`);
}

const [command, a, b] = process.argv.slice(2);
if (command === 'fetch') await fetchRelease(a ?? join(import.meta.dirname, '..', '.engine'));
else if (command === 'stage' && a !== undefined && b !== undefined) stage(a, b);
else if (command === 'version') console.log(version());
else {
    console.error('usage: node scripts/engine.ts fetch [dir] | stage <dir> <out> | version');
    process.exit(2);
}
