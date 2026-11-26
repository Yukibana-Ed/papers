import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { engineType } from './src/lib/engine-files.ts';

/** In development, what the Worker serves from R2 in production:
 *  - `/engine/<file>` from the BusyTeX release assets on disk (`BUSYTEX_ASSETS`, default `.engine/busytex` beside this
 *    file, which `pnpm fetch:engine` fills);
 *  - `/tl/<format>/<name>` proxied to a local TeX Live store server (`TL_STORE_URL`, default http://localhost:5191, the
 *    store server of scripts/tlstore.ts `serve`).
 *  Every response carries the headers a cross-origin-isolated page needs from its own subresources. */
export function devAssets(): Plugin {
    const engineDir = resolve(process.env['BUSYTEX_ASSETS'] ?? join(import.meta.dirname, '.engine', 'busytex'));
    const store = process.env['TL_STORE_URL'] ?? 'http://localhost:5191';
    return {
        name: 'yukibana-dev-assets',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url ?? '';
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
