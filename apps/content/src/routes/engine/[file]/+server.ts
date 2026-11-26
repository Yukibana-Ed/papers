import { ENGINE_FILES, engineType } from '#lib/engine-files.ts';
import { notFound, objectResponse } from '#lib/r2.ts';

/** `/engine/<file>`: one of the engine's release files, from `engine/<ENGINE_VERSION>/<file>` in the bucket. Only the
 *  files of `ENGINE_FILES` exist here. */
export async function GET({ params, platform }: { params: { file: string }; platform?: App.Platform }): Promise<Response> {
    if (platform === undefined || !ENGINE_FILES.includes(params.file)) return notFound();
    const object = await platform.env.ASSETS_R2.get(`engine/${platform.env.ENGINE_VERSION}/${params.file}`);
    return object === null ? notFound() : objectResponse(object, engineType(params.file));
}
