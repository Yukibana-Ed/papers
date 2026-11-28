import { notFound, objectResponse, type AssetBucket } from '#lib/r2.ts';
import { parsePathShard, pathShardOf, type PathShard } from '#lib/tl-index.ts';
import { workerPlatform } from '#lib/platform.ts';

/** Parsed path shards, per isolate: a shard is about 25 KB, and the isolate keeps at most this many. */
const KEPT = 512;
const shards = new Map<string, Promise<PathShard | null>>();

function shard(bucket: AssetBucket, snapshot: string, id: string): Promise<PathShard | null> {
    const key = `${snapshot}/${id}`;
    let s = shards.get(key);
    if (s === undefined) {
        if (shards.size >= KEPT) shards.clear();
        s = bucket.get(`tl/${snapshot}/paths/${id}.json`).then(async (o): Promise<PathShard | null> => (o === null ? null : parsePathShard(await o.text())));
        s.catch(() => shards.delete(key));
        shards.set(key, s);
    }
    return s;
}

/** `/tl-file/<path>`: the file an installation of the snapshot `PDFTEX_SNAPSHOT` has at `<path>` from TeX Live's root, as
 *  our pdfTeX asks for it. 404 when the snapshot has no such file. */
export async function GET({ params }: { params: { path: string } }): Promise<Response> {
    const platform: App.Platform | undefined = workerPlatform();
    if (platform === undefined || params.path === '') return notFound();
    const { ASSETS_R2: bucket, PDFTEX_SNAPSHOT: snapshot } = platform.env;
    const index = await shard(bucket, snapshot, pathShardOf(params.path));
    // A path is the document's to choose: only the shard's own entries count.
    const file = index !== null && Object.hasOwn(index, params.path) ? index[params.path] : undefined;
    if (file === undefined) return notFound();
    const [sha] = file;
    const object = await bucket.get(`tl/${snapshot}/objects/${sha.slice(0, 2)}/${sha}`);
    return object === null ? notFound() : objectResponse(object, 'application/octet-stream');
}
