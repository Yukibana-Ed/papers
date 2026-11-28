import { engineType } from '#lib/engine-files.ts';
import { notFound, objectResponse } from '#lib/r2.ts';
import { pdftexAssetKey } from '#lib/pdftex-assets.ts';
import { typstAssetKey } from '#lib/typst-assets.ts';
import { workerPlatform } from '#lib/platform.ts';

/** `/engine/typst/<file>`, `/engine/tinymist/<file>`, `/engine/typst-fonts/<file>`: the Typst compiler, language
 *  server and default fonts, from their pinned folders in the bucket; `/engine/pdftex/<file>`: our pdfTeX's modules and
 *  the LaTeX format it dumped from the snapshot `PDFTEX_SNAPSHOT`. Only the files `TYPST_ASSETS` and `pdftexAssetKey` name
 *  exist. */
export async function GET({ params }: { params: { kind: string; file: string } }): Promise<Response> {
    const platform: App.Platform | undefined = workerPlatform();
    if (platform === undefined) return notFound();
    const key = params.kind === 'pdftex' ? pdftexAssetKey(params.file, platform.env.PDFTEX_SNAPSHOT) : typstAssetKey(params.kind, params.file);
    if (key === null) return notFound();
    const object = await platform.env.ASSETS_R2.get(key);
    return object === null ? notFound() : objectResponse(object, engineType(params.file));
}
