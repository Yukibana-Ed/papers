/** The engine's files that the content origin serves at `/engine/<name>`: texlyre-busytex's release assets, minus the
 *  big TeX Live data packages (recommended, extra), which the per-file store replaces. */
export const ENGINE_FILES: readonly string[] = [
    'busytex_worker.js',
    'busytex_pipeline.js',
    'busytex_biber.js',
    'busytex.js',
    'busytex.wasm',
    'biber.js',
    'biber.wasm',
    'biber.data',
    'texlive-basic.js',
    'texlive-basic.data',
    'texmf.cnf',
    'versions.txt',
];

/** Content types by extension; the browser compiles WebAssembly while it streams only as application/wasm. */
export const ENGINE_TYPES: Readonly<Record<string, string>> = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript; charset=utf-8',
    '.data': 'application/octet-stream',
    '.txt': 'text/plain; charset=utf-8',
    '.cnf': 'text/plain; charset=utf-8',
};

/** The content type of an engine file. */
export function engineType(name: string): string {
    return ENGINE_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream';
}
