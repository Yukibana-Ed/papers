import { gunzipSync } from 'node:zlib';
import { backward, forward, parseSynctex as parseSynctexText, type PageBox, type SyncTex } from '@yukibana/papers-tex';

/** SyncTeX for the local tools: the shared reader of `@yukibana/papers-tex` (the content frame uses the same one), with
 *  the gunzip that only Node can do here. Coordinates are PDF points from the page's top-left corner. */

export type { SyncTex };

/** A box on a page, in PDF points from the top-left corner. */
export type SyncBox = PageBox;

/** The SyncTeX data in `data`: the `.synctex.gz` bytes, or the uncompressed text (as bytes or a string). */
export function parseSynctex(data: Uint8Array | string): SyncTex {
    const text = typeof data === 'string' ? data : data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data).toString('utf8') : Buffer.from(data).toString('utf8');
    return parseSynctexText(text);
}

/** The boxes that `line` of `file` (a project path) produced, horizontal boxes first; empty when it produced none. */
export function forwardSearch(sync: SyncTex, file: string, line: number): SyncBox[] {
    return forward(sync, file.replace(/\\/g, '/'), line);
}

/** The source line under the point (`x`, `y` in PDF points from the top-left corner of `page`), or null for a page with
 *  no records. `file` is the path exactly as the engine wrote it (absolute, or relative to the folder it ran in); the
 *  caller resolves it against its build folder. */
export function inverseSearch(sync: SyncTex, page: number, x: number, y: number): { file: string; line: number } | null {
    const hit = backward(sync, page, x, y);
    return hit === null ? null : { file: hit.input, line: hit.line };
}
