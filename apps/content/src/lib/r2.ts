/** The part of a Workers R2 binding this app uses, typed here so the app needs no runtime type package. */
export interface AssetBucket {
    get(key: string): Promise<AssetObject | null>;
    /** Stores `value` at `key` (the Typst package cache; everything else is uploaded by assets.yml). */
    put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export interface AssetObject {
    readonly body: ReadableStream<Uint8Array>;
    readonly size: number;
    readonly httpEtag: string;
    readonly httpMetadata?: { readonly contentType?: string; readonly contentEncoding?: string };
    text(): Promise<string>;
}

/** Workers' ResponseInit: `encodeBody: 'manual'` sends a body that is already compressed as is, with its
 *  Content-Encoding, instead of compressing it again. */
interface WorkersResponseInit extends ResponseInit {
    readonly encodeBody?: 'automatic' | 'manual';
}

/** Cached for a year: every key names immutable content (a release, a snapshot, a content hash). */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A response for an R2 object, which may be stored brotli-compressed (Content-Encoding br in its metadata): the bytes go
 *  out as stored, and the browser decompresses them. `type` overrides the stored Content-Type. */
export function objectResponse(object: AssetObject, type: string | undefined, extra: Record<string, string> = {}): Response {
    const headers = new Headers({
        'Content-Type': type ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': IMMUTABLE,
        ETag: object.httpEtag,
        'Cross-Origin-Resource-Policy': 'same-origin',
        ...extra,
    });
    const encoding = object.httpMetadata?.contentEncoding;
    const init: WorkersResponseInit = encoding === undefined ? { headers } : { headers, encodeBody: 'manual' };
    if (encoding !== undefined) headers.set('Content-Encoding', encoding);
    return new Response(object.body, init);
}

export function notFound(): Response {
    // A miss is as permanent as a hit within one snapshot: kpathsea probes many names that do not exist.
    return new Response(null, { status: 404, headers: { 'Cache-Control': IMMUTABLE, 'Cross-Origin-Resource-Policy': 'same-origin' } });
}
