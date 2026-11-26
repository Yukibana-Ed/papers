import { notFound, objectResponse } from '#lib/r2.ts';
import { packageArchive, upstreamPackageUrl } from '#lib/typst-assets.ts';
import { workerPlatform } from '#lib/platform.ts';

/** `/typst-packages/preview/<name>-<version>.tar.gz`: a Typst Universe package, read through to packages.typst.org
 *  once and kept in the bucket after. A published version never changes (Typst Universe does not allow it), so the
 *  archive is cached as immutable; papers.lock pins its SHA-256 for reproducible builds. */
export async function GET({ params }: { params: { namespace: string; file: string } }): Promise<Response> {
    const platform: App.Platform | undefined = workerPlatform();
    const p = packageArchive(params.namespace, params.file);
    if (platform === undefined || p === null) return notFound();
    const key = `typst-packages/${p.namespace}/${params.file}`;
    const cached = await platform.env.ASSETS_R2.get(key);
    if (cached !== null) return objectResponse(cached, 'application/gzip');
    const upstream = await fetch(upstreamPackageUrl(p));
    if (!upstream.ok) return upstream.status === 404 ? notFound() : new Response(null, { status: 502 });
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    await platform.env.ASSETS_R2.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' } });
    return new Response(bytes, {
        headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin' },
    });
}
