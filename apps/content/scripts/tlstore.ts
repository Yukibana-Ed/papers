// The TeX Live store: builds it from a TeX Live installation, and serves it locally for the content frame's dev server.
//
//   node scripts/tlstore.ts build <texlive root> <out dir>   objects/<xx>/<sha256> (brotli), index/<xx>.json and
//                                                            paths/<xxx>.json
//   node scripts/tlstore.ts serve <out dir> [port]           GET /<format>/<name>, as /tl/* in production, and
//                                                            GET /file/<path>, as /tl-file/* (port 5191)
//
// By name the store has the files of texmf-dist. By path it has the installation our pdfTeX sees: texmf-dist, what the
// installation made for itself in texmf-var (pdftex.map is made, not shipped), and for each of the two trees an ls-R
// that lists exactly what the store has of it.
//
// The output directory is what .github/workflows/assets.yml uploads to `tl/<snapshot>/` in the bucket. A build into an
// existing directory writes only the objects it does not have, so a later snapshot adds only what changed.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import {
    buildPathShards,
    buildShards,
    cleanName,
    lsR,
    parsePathShard,
    parseShard,
    pathShardOf,
    resolve,
    shardOf,
    type IndexedFile,
    type PathShard,
    type Shard,
} from '../src/lib/tl-index.ts';
import { FORMAT_PATH } from '../src/lib/pdftex-assets.ts';

function build(root: string, out: string): void {
    const tree = join(root, 'texmf-dist');
    if (!existsSync(tree)) throw new Error(`${tree} does not exist: give the TeX Live root (the folder with texmf-dist)`);
    const t0 = Date.now();
    const files: IndexedFile[] = [];
    const paths: [path: string, sha: string, size: number][] = [];
    let bytes = 0;
    let written = 0;
    /** Stores `buf` as an object, and as the file at `path` (from the root). */
    const put = (path: string, buf: Uint8Array): string => {
        const sha = createHash('sha256').update(buf).digest('hex');
        paths.push([path, sha, buf.length]);
        bytes += buf.length;
        const dirOut = join(out, 'objects', sha.slice(0, 2));
        const obj = join(dirOut, sha);
        if (!existsSync(obj)) {
            mkdirSync(dirOut, { recursive: true });
            writeFileSync(obj, brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
            written++;
        }
        return sha;
    };
    /** Stores the files under `dir`, whose path from the root is `rel`; those of texmf-dist also by name. */
    const walk = (dir: string, rel: string, named: boolean): void => {
        // Sorted, so that which of two files of the same name wins does not depend on the file system.
        for (const e of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                // Documentation and sources are never read by a build.
                if (dir === tree && (e.name === 'doc' || e.name === 'source')) continue;
                walk(p, `${rel}/${e.name}`, named);
                continue;
            }
            // The databases are made below, for what the store has.
            if (!e.isFile() || e.name === 'ls-R') continue;
            const buf = readFileSync(p);
            const sha = put(`${rel}/${e.name}`, buf);
            if (named) files.push([sha, buf.length, e.name]);
        }
    };
    walk(tree, 'texmf-dist', true);
    // What the installation made for itself (pdftex.map above all), without its formats, which are another engine's,
    // and its caches.
    const made = join(root, 'texmf-var');
    if (existsSync(made)) {
        for (const e of readdirSync(made, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            if (e.isDirectory() && e.name !== 'web2c' && e.name !== 'luatex-cache') walk(join(made, e.name), `texmf-var/${e.name}`, false);
        }
    }
    // The LaTeX format is the one made by our pdfTeX, served apart (src/lib/pdftex-assets.ts): the database names it,
    // so that the engine finds it where an installation has it.
    const inTree = (name: string, extra: readonly string[]): string[] => [...paths.filter(([p]) => p.startsWith(`${name}/`)).map(([p]) => p.slice(name.length + 1)), ...extra];
    const encoder = new TextEncoder();
    put('texmf-var/ls-R', encoder.encode(lsR(inTree('texmf-var', [FORMAT_PATH.slice('texmf-var/'.length)]))));
    put('texmf-dist/ls-R', encoder.encode(lsR(inTree('texmf-dist', []))));
    mkdirSync(join(out, 'index'), { recursive: true });
    const shards = buildShards(files);
    for (const [id, shard] of shards) writeFileSync(join(out, 'index', `${id}.json`), JSON.stringify(shard));
    mkdirSync(join(out, 'paths'), { recursive: true });
    const pathShards = buildPathShards(paths);
    for (const [id, shard] of pathShards) writeFileSync(join(out, 'paths', `${id}.json`), JSON.stringify(shard));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), files: files.length, paths: paths.length, bytes, shards: shards.size }));
    console.log(
        JSON.stringify({
            seconds: Math.round((Date.now() - t0) / 1000),
            files: files.length,
            paths: paths.length,
            GB: +(bytes / 1e9).toFixed(2),
            objectsWritten: written,
            shards: shards.size,
            pathShards: pathShards.size,
        }),
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
    const pathCache = new Map<string, PathShard | null>();
    const pathShard = (id: string): PathShard | null => {
        if (!pathCache.has(id)) {
            const p = join(out, 'paths', `${id}.json`);
            pathCache.set(id, existsSync(p) ? parsePathShard(readFileSync(p, 'utf8')) : null);
        }
        return pathCache.get(id) ?? null;
    };
    createServer((req, res) => {
        const byPath = /^\/file\/([^?]+)/.exec(req.url ?? '');
        if (byPath !== null) {
            const path = decodeURIComponent(byPath[1] ?? '');
            const index = pathShard(pathShardOf(path));
            const sha = index !== null && Object.hasOwn(index, path) ? index[path]?.[0] : undefined;
            const common = { 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': '*' };
            if (sha === undefined) {
                res.writeHead(404, common).end();
                return;
            }
            res.writeHead(200, { ...common, 'content-type': 'application/octet-stream', 'content-encoding': 'br', 'cache-control': 'public, max-age=31536000, immutable' });
            res.end(readFileSync(join(out, 'objects', sha.slice(0, 2), sha)));
            return;
        }
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
