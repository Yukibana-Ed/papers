import { ASSETS } from './asset-path.ts';
/** The Typst side of the content origin's assets: the typst.ts compiler, the tinymist language server, the default
 *  fonts, and Typst Universe packages. Like the TeX engine, they are served from the R2 bucket in production (the
 *  compiler and the server are each above the Workers static asset limit) and from disk or upstream in development.
 *
 *  Versions are pinned here: changing one is a deploy, and assets.yml uploads the new folder. */

/** typst.ts's web compiler. 0.8.0-rc4 (a pre-release, 2026-11-09) is the one on Typst 0.15.1, the Typst of tinymist
 *  0.15.12: compiler and language server must agree on the language. Matches the `@myriaddreamin/typst.ts` dependency. */
export const TYPST_TS_VERSION = '0.8.0-rc4';
/** tinymist's official web build (`tinymist-web.tar.gz` of the GitHub release). */
export const TINYMIST_VERSION = '0.15.12';
/** The SHA-256 of that release asset (GitHub's asset digest); scripts/typst.ts checks it before upload. */
export const TINYMIST_WEB_SHA256 = 'ba4756446f0b6cf4d587a0644445df44e53066d3d92e3f8fd4b5d774df1d5eba';
/** The typst-assets release the default fonts come from. */
export const TYPST_FONTS_VERSION = 'v0.13.1';

/** Typst's default text fonts (typst-assets), as typst.ts names them. */
export const TYPST_TEXT_FONTS: readonly string[] = [
    'DejaVuSansMono-Bold.ttf',
    'DejaVuSansMono-BoldOblique.ttf',
    'DejaVuSansMono-Oblique.ttf',
    'DejaVuSansMono.ttf',
    'LibertinusSerif-Bold.otf',
    'LibertinusSerif-BoldItalic.otf',
    'LibertinusSerif-Italic.otf',
    'LibertinusSerif-Regular.otf',
    'LibertinusSerif-Semibold.otf',
    'LibertinusSerif-SemiboldItalic.otf',
    'NewCM10-Bold.otf',
    'NewCM10-BoldItalic.otf',
    'NewCM10-Italic.otf',
    'NewCM10-Regular.otf',
    'NewCMMath-Bold.otf',
    'NewCMMath-Book.otf',
    'NewCMMath-Regular.otf',
];

/** Where each kind of asset lives: its URL path on the content origin, and its key prefix in the bucket. */
export const TYPST_ASSETS = {
    compiler: { path: `${ASSETS}/engine/typst/`, key: `typst/${TYPST_TS_VERSION}/`, files: ['typst_ts_web_compiler_bg.wasm'] },
    tinymist: { path: `${ASSETS}/engine/tinymist/`, key: `tinymist/${TINYMIST_VERSION}/`, files: ['tinymist_bg.wasm'] },
    fonts: { path: `${ASSETS}/engine/typst-fonts/`, key: `typst-fonts/${TYPST_FONTS_VERSION}/`, files: TYPST_TEXT_FONTS },
} as const;

export type TypstAssetKind = keyof typeof TYPST_ASSETS;

/** The bucket key of `/engine/<kind>/<file>`, or null for a file that is not one of ours. */
export function typstAssetKey(kind: string, file: string): string | null {
    const a = (TYPST_ASSETS as Record<string, { key: string; files: readonly string[] }>)[kind === 'typst' ? 'compiler' : kind === 'typst-fonts' ? 'fonts' : kind];
    return a !== undefined && a.files.includes(file) ? `${a.key}${file}` : null;
}

/** A Typst Universe package archive's name, `<name>-<version>.tar.gz`, checked: Typst's identifier characters and a
 *  semantic version. Returns null for anything else, so nothing but package archives is fetched or cached. */
export function packageArchive(namespace: string, file: string): { namespace: string; name: string; version: string } | null {
    if (namespace !== 'preview') return null;
    const m = /^([a-z][a-z0-9-]{0,63})-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(file);
    return m ? { namespace, name: m[1] ?? '', version: m[2] ?? '' } : null;
}

/** Where Typst Universe serves an archive. */
export function upstreamPackageUrl(p: { namespace: string; name: string; version: string }): string {
    return `https://packages.typst.org/${p.namespace}/${p.name}-${p.version}.tar.gz`;
}
