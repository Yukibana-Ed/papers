import { safePath } from './paths.ts';

/** What an archive may hold before it is refused: an Overleaf export or an arXiv source is far below this. */
export interface ArchiveLimits {
    readonly maxFiles: number;
    /** Uncompressed bytes, all files together. */
    readonly maxBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = { maxFiles: 2000, maxBytes: 64 * 1024 * 1024 };

/** An archive that cannot be read, or that is over its limits; the message says which. */
export class ArchiveError extends Error {}

async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw', limit: number): Promise<Uint8Array> {
    const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream(format));
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        // A small archive that expands without end (a zip bomb) stops here, not when memory runs out.
        if (size > limit) {
            await reader.cancel();
            throw new ArchiveError('The archive is too large');
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
    }
    return out;
}

/** The files of a .zip, by safe path. Directories and macOS metadata (`__MACOSX/`, `._*`) are skipped; an unsafe path,
 *  an encrypted entry, a compression other than stored or deflate, or anything beyond `limits` refuses the archive.
 *  Reads the central directory, as unzip does, so a file's entry is found by its offset, not by scanning. */
export async function unzip(zip: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<Map<string, Uint8Array>> {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new ArchiveError('Not a zip file');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    if (count > limits.maxFiles) throw new ArchiveError(`More than ${limits.maxFiles} files`);
    const out = new Map<string, Uint8Array>();
    const dec = new TextDecoder();
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (view.getUint32(p, true) !== 0x02014b50) throw new ArchiveError('Damaged zip file');
        const flags = view.getUint16(p + 8, true);
        const method = view.getUint16(p + 10, true);
        const compressed = view.getUint32(p + 20, true);
        const size = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const local = view.getUint32(p + 42, true);
        const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('._')) continue;
        const path = safePath(name);
        if (path === null) throw new ArchiveError(`Unsafe path in the archive: ${name.slice(0, 80)}`);
        if (flags & 1) throw new ArchiveError('Encrypted zip files are not supported');
        total += size;
        if (total > limits.maxBytes) throw new ArchiveError('The archive is too large');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const raw = zip.subarray(start, start + compressed);
        if (method === 0) out.set(path, raw.slice());
        else if (method === 8) out.set(path, await inflate(raw, 'deflate-raw', size + 1024));
        else throw new ArchiveError(`Unsupported compression in ${path}`);
    }
    return out;
}

/** The files of a .tar.gz (a Typst package), by safe path. Only regular files; links and anything unsafe refuse it. */
export async function untargz(tgz: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<Map<string, Uint8Array>> {
    const tar = await inflate(tgz, 'gzip', limits.maxBytes);
    const dec = new TextDecoder();
    const out = new Map<string, Uint8Array>();
    const str = (a: number, b: number): string => dec.decode(tar.subarray(a, b)).replace(/\0.*$/s, '');
    let longName: string | null = null;
    for (let p = 0; p + 512 <= tar.length;) {
        const header = tar.subarray(p, p + 512);
        if (header.every(b => b === 0)) break;
        const size = parseInt(str(p + 124, p + 136).trim() || '0', 8);
        const type = String.fromCharCode(header[156] ?? 48);
        const prefix = str(p + 345, p + 500);
        const name = longName ?? (prefix ? `${prefix}/${str(p, p + 100)}` : str(p, p + 100));
        longName = null;
        const body = tar.subarray(p + 512, p + 512 + size);
        p += 512 + Math.ceil(size / 512) * 512;
        if (type === 'L') {
            longName = dec.decode(body).replace(/\0.*$/s, '');
            continue;
        }
        if (type === 'x' || type === 'g' || type === '5') continue;
        if (type !== '0' && type !== '\0') throw new ArchiveError(`Unsupported entry in the package: ${name.slice(0, 80)}`);
        const path = safePath(name);
        if (path === null) throw new ArchiveError(`Unsafe path in the package: ${name.slice(0, 80)}`);
        if (out.size >= limits.maxFiles) throw new ArchiveError(`More than ${limits.maxFiles} files`);
        out.set(path, body.slice());
    }
    return out;
}
