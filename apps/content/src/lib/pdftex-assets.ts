import { ASSETS } from './asset-path.ts';
/** Our pdfTeX (packages/pdftex-wasm), which keeps a LaTeX document built while it is typed, and what it runs with.
 *
 *  The modules are served from the bucket under their build's name. The LaTeX format is dumped by that build from a
 *  TeX Live snapshot (.github/workflows/assets.yml), so it is served under both names: a format is only good for the
 *  engine that made it and the files it was made from. */

/** The build of the engine: the `@yukibana/pdftex-wasm` dependency, the release archive `pdftex-wasm-<this>`. */
export const PDFTEX_BUILD = '1.40.29-yb.1';

/** The modules, at `/engine/pdftex/<file>`. */
export const PDFTEX_MODULES: readonly string[] = ['pdftex.wasm', 'bibtex8.wasm'];
/** The LaTeX format, at `/engine/pdftex/<this>`. */
export const FORMAT_FILE = 'pdflatex.fmt';
/** Where the engine's assets are served. */
export const PDFTEX_PATH = `${ASSETS}/engine/pdftex/`;
/** Where TeX Live's files are served by their path from its root. */
export const TL_FILE_PATH = `${ASSETS}/tl-file/`;

/** Where an installation has pdfLaTeX's format, from TeX Live's root. */
export const FORMAT_PATH = 'texmf-var/web2c/pdftex/pdflatex.fmt';

/** The bucket key of `/engine/pdftex/<file>` with the TeX Live snapshot `snapshot`, or null for a file that is not one
 *  of the engine's. */
export function pdftexAssetKey(file: string, snapshot: string): string | null {
    if (PDFTEX_MODULES.includes(file)) return `pdftex/${PDFTEX_BUILD}/${file}`;
    return file === FORMAT_FILE ? `pdftex/${PDFTEX_BUILD}/${snapshot}/${file}` : null;
}
