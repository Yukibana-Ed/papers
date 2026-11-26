import { engineType } from '#lib/engine-files.ts';
import { notFound, objectResponse } from '#lib/r2.ts';
import { typstAssetKey } from '#lib/typst-assets.ts';

/** `/engine/typst/<file>`, `/engine/tinymist/<file>`, `/engine/typst-fonts/<file>`: the Typst compiler, language
 *  server and default fonts, from their pinned folders in the bucket. Only the files `TYPST_ASSETS` lists exist. */
export async function GET({ params, platform }: { params: { kind: string; file: string }; platform?: App.Platform }): Promise<Response> {
    const key = typstAssetKey(params.kind, params.file);
    if (platform === undefined || key === null) return notFound();
    const object = await platform.env.ASSETS_R2.get(key);
    return object === null ? notFound() : objectResponse(object, engineType(params.file));
}
