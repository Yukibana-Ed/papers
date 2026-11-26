// The TeX Live store: builds it from a TeX Live installation, and serves it locally for the content frame's dev server.
//
//   node scripts/tlstore.ts build <texlive root> <out dir>   objects/<xx>/<sha256> (brotli) and index/<xx>.json
//   node scripts/tlstore.ts serve <out dir> [port]           GET /<format>/<name>, as /tl/* in production (port 5191)
//
// The output directory is what .github/workflows/assets.yml uploads to `tl/<snapshot>/` in the bucket. A build into an
// existing directory writes only the objects it does not have, so a later snapshot adds only what changed.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { buildShards, cleanName, parseShard, resolve, shardOf, type IndexedFile, type Shard } from '../src/lib/tl-index.ts';

function build(root: string, out: string): void {
    const tree = join(root, 'texmf-dist');
    if (!existsSync(tree)) throw new Error(`${tree} does not exist: give the TeX Live root (the folder with texmf-dist)`);
    const t0 = Date.now();
    const files: IndexedFile[] = [];
    let bytes = 0;
    let written = 0;
    const walk = (dir: string): void => {
        // Sorted, so that which of two files of the same name wins does not depend on the file system.
        for (const e of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                // Documentation and sources are never read by a build.
                if (dir === tree && (e.name === 'doc' || e.name === 'source')) continue;
                walk(p);
                continue;
            }
            if (!e.isFile()) continue;
            const buf = readFileSync(p);
            const sha = createHash('sha256').update(buf).digest('hex');
            files.push([sha, buf.length, e.name]);
            bytes += buf.length;
            const dirOut = join(out, 'objects', sha.slice(0, 2));
            const obj = join(dirOut, sha);
            if (!existsSync(obj)) {
                mkdirSync(dirOut, { recursive: true });
                writeFileSync(obj, brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
                written++;
            }
        }
    };
    walk(tree);
    mkdirSync(join(out, 'index'), { recursive: true });
    const shards = buildShards(files);
    for (const [id, shard] of shards) writeFileSync(join(out, 'index', `${id}.json`), JSON.stringify(shard));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), files: files.length, bytes, shards: shards.size }));
    console.log(
        JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), files: files.length, GB: +(bytes / 1e9).toFixed(2), objectsWritten: written, shards: shards.size }),
    );
}

function serve(out: string, port: number): void {
    const cache = new Map<string, Shard | null>();
    const shard = (id: string): Shard | null => {
        if (!cache.has(id)) {
            const p = join(out, 'index', `${id}.json`);
            cache.set(id, existsSync(p) ? parseShard(readFileSync(p, 'utf8')) : null);
        }
        return cache.get(id) ?? null;
    };
    createServer((req, res) => {
        const m = /^\/(\d+)\/([^/?]+)/.exec(req.url ?? '');
        const name = m === null ? '' : cleanName(decodeURIComponent(m[2] ?? ''));
        const index = name === '' ? null : shard(shardOf(name));
        const file = index === null ? null : resolve(index, Number(m?.[1]), name);
        const headers = { 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'fileid' };
        if (file === null) {
            res.writeHead(404, headers).end();
            return;
        }
        const [sha, , real] = file;
        res.writeHead(200, {
            ...headers,
            'content-type': 'application/octet-stream',
            'content-encoding': 'br',
            fileid: real,
            'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(readFileSync(join(out, 'objects', sha.slice(0, 2), sha)));
    }).listen(port, () => console.log(`serving ${out} on :${port}`));
}

const [command, a, b] = process.argv.slice(2);
if (command === 'build' && a !== undefined && b !== undefined) build(a, b);
else if (command === 'serve' && a !== undefined) serve(a, Number(b ?? 5191));
else {
    console.error('usage: node scripts/tlstore.ts build <texlive root> <out dir> | serve <out dir> [port]');
    process.exit(2);
}
