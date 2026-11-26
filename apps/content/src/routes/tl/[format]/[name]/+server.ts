import { notFound, objectResponse, type AssetBucket } from '#lib/r2.ts';
import { cleanName, parseShard, resolve, shardOf, type Shard } from '#lib/tl-index.ts';

/** Parsed index shards, per isolate: 256 at most, about 150 KB each. */
const shards = new Map<string, Promise<Shard | null>>();

function shard(bucket: AssetBucket, snapshot: string, id: string): Promise<Shard | null> {
    const key = `${snapshot}/${id}`;
    let s = shards.get(key);
    if (s === undefined) {
        s = bucket.get(`tl/${snapshot}/index/${id}.json`).then(async (o): Promise<Shard | null> => (o === null ? null : parseShard(await o.text())));
        s.catch(() => shards.delete(key));
        shards.set(key, s);
    }
    return s;
}

/** `/tl/<format>/<name>`: the TeX Live file kpathsea asks for, as texlyre-busytex's remote endpoint expects it (the
 *  bytes, and the file's real name in a `fileid` header), from the snapshot `TL_SNAPSHOT` in the bucket. 404 when the
 *  snapshot has no such file. */
export async function GET({ params, platform }: { params: { format: string; name: string }; platform?: App.Platform }): Promise<Response> {
    const format = Number(params.format);
    const name = cleanName(params.name);
    if (platform === undefined || !Number.isInteger(format) || name === '') return notFound();
    const { ASSETS_R2: bucket, TL_SNAPSHOT: snapshot } = platform.env;
    const index = await shard(bucket, snapshot, shardOf(name));
    const file = index === null ? null : resolve(index, format, name);
    if (file === null) return notFound();
    const [sha, , real] = file;
    const object = await bucket.get(`tl/${snapshot}/objects/${sha.slice(0, 2)}/${sha}`);
    return object === null ? notFound() : objectResponse(object, 'application/octet-stream', { fileid: real, 'Access-Control-Expose-Headers': 'fileid' });
}
