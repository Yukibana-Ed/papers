import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { stripAssetPrefix } from './src/lib/asset-path.ts';
import { engineType } from './src/lib/engine-files.ts';
import { pdftexAssetKey } from './src/lib/pdftex-assets.ts';
import { TYPST_FONTS_VERSION, packageArchive, typstAssetKey, upstreamPackageUrl } from './src/lib/typst-assets.ts';

/** The headers a cross-origin-isolated page needs on its own subresources. */
function isolated(res: { setHeader(name: string, value: string): unknown }): void {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-cache');
}

/** In development, what the Worker serves from R2 in production:
 *  - `/engine/<file>` from the BusyTeX release assets on disk (`BUSYTEX_ASSETS`, default `.engine/busytex` beside this
 *    file, which `pnpm fetch:engine` fills);
 *  - `/tl/<format>/<name>` and `/tl-file/<path>` proxied to a local TeX Live store server (`TL_STORE_URL`, default
 *    http://localhost:5191, the store server of scripts/tlstore.ts `serve`);
 *  - `/engine/pdftex/<file>` from `.engine/pdftex` beside this file, which `node scripts/pdftex.ts dev` fills.
 *  Every response carries the headers a cross-origin-isolated page needs from its own subresources. */
export function devAssets(): Plugin {
    const engineDir = resolve(process.env['BUSYTEX_ASSETS'] ?? join(import.meta.dirname, '.engine', 'busytex'));
    const store = process.env['TL_STORE_URL'] ?? 'http://localhost:5191';
    // The typst.ts web compiler from node_modules; tinymist's web build from TINYMIST_WEB (default .engine/tinymist,
    // which `pnpm fetch:typst` fills); fonts and packages from upstream.
    const compilerDir = join(dirname(fileURLToPath(import.meta.resolve('@myriaddreamin/typst-ts-web-compiler/package.json'))), 'pkg');
    const pdftexDir = join(import.meta.dirname, '.engine', 'pdftex');
    const tinymistDir = resolve(process.env['TINYMIST_WEB'] ?? join(import.meta.dirname, '.engine', 'tinymist'));
    const serveFile = (res: import('node:http').ServerResponse, file: string, name: string): void => {
        if (!existsSync(file)) {
            res.statusCode = 404;
            res.end();
            return;
        }
        res.setHeader('Content-Type', engineType(name));
        res.setHeader('Content-Length', String(statSync(file).size));
        isolated(res);
        createReadStream(file).pipe(res);
    };
    const proxy = (res: import('node:http').ServerResponse, url: string, type: string): void => {
        fetch(url)
            .then(async r => {
                res.statusCode = r.status;
                res.setHeader('Content-Type', type);
                isolated(res);
                res.end(Buffer.from(await r.arrayBuffer()));
            })
            .catch(() => {
                res.statusCode = 502;
                res.end();
            });
    };
    return {
        name: 'yukibana-dev-assets',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                // Asset URLs carry the revision prefix (src/lib/asset-path.ts); the files on disk do not.
                const url = stripAssetPrefix(req.url ?? '');
                const typst = /^\/engine\/(typst|tinymist|typst-fonts)\/([A-Za-z0-9._-]+)$/.exec(url.split('?')[0] ?? '');
                if (typst !== null) {
                    const [, kind = '', name = ''] = typst;
                    if (typstAssetKey(kind, name) === null) {
                        res.statusCode = 404;
                        res.end();
                    } else if (kind === 'typst') serveFile(res, join(compilerDir, name), name);
                    else if (kind === 'tinymist') serveFile(res, join(tinymistDir, name), name);
                    else proxy(res, `https://cdn.jsdelivr.net/gh/typst/typst-assets@${TYPST_FONTS_VERSION}/files/fonts/${name}`, 'font/otf');
                    return;
                }
                const pdftex = /^\/engine\/pdftex\/([A-Za-z0-9._-]+)$/.exec(url.split('?')[0] ?? '');
                if (pdftex !== null) {
                    const name = pdftex[1] ?? '';
                    if (pdftexAssetKey(name, '') === null) {
                        res.statusCode = 404;
                        res.end();
                    } else serveFile(res, join(pdftexDir, name), name);
                    return;
                }
                const byPath = /^\/tl-file\/([^?]+)/.exec(url);
                if (byPath !== null) {
                    proxy(res, `${store}/file/${byPath[1] ?? ''}`, 'application/octet-stream');
                    return;
                }
                const pkg = /^\/typst-packages\/([a-z]+)\/([A-Za-z0-9._-]+)$/.exec(url.split('?')[0] ?? '');
                if (pkg !== null) {
                    const p = packageArchive(pkg[1] ?? '', pkg[2] ?? '');
                    if (p === null) {
                        res.statusCode = 404;
                        res.end();
                    } else proxy(res, upstreamPackageUrl(p), 'application/gzip');
                    return;
                }
                const engine = /^\/engine\/([A-Za-z0-9._-]+)$/.exec(url.split('?')[0] ?? '');
                if (engine !== null) {
                    const name = engine[1] ?? '';
                    const file = join(engineDir, name);
                    if (!existsSync(file)) {
                        res.statusCode = 404;
                        res.end();
                        return;
                    }
                    res.setHeader('Content-Type', engineType(name));
                    res.setHeader('Content-Length', String(statSync(file).size));
                    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
                    // The engine's worker script must itself be isolated, or the isolated page may not start it.
                    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
                    res.setHeader('Cache-Control', 'no-cache');
                    createReadStream(file).pipe(res);
                    return;
                }
                const tl = /^\/tl\/(\d+)\/([^/?]+)/.exec(url);
                if (tl !== null) {
                    fetch(`${store}/${tl[1] ?? ''}/${tl[2] ?? ''}`)
                        .then(async r => {
                            res.statusCode = r.status;
                            const fileid = r.headers.get('fileid');
                            if (fileid !== null) res.setHeader('fileid', fileid);
                            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
                            res.end(Buffer.from(await r.arrayBuffer()));
                        })
                        .catch(() => {
                            res.statusCode = 502;
                            res.end();
                        });
                    return;
                }
                next();
            });
        },
    };
}
