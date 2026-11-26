/** Sealing small values into cookies: AES-256-GCM with a key only the Worker has, so a cookie can carry the user's
 *  GitHub tokens without the browser's JavaScript, or anyone holding the cookie jar's file, reading or forging them.
 *
 *  A sealed value is `base64url(iv ‖ ciphertext ‖ tag)`, with the cookie's purpose as associated data, so a value
 *  sealed for one cookie does not open as another. */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array<ArrayBuffer> {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** The AES key in `secret`, the base64 of 32 random bytes (`openssl rand -base64 32`).
 *  Precondition: `secret` decodes to exactly 32 bytes; throws otherwise. */
export async function importKey(secret: string): Promise<CryptoKey> {
    const raw = unb64url(secret.trim().replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
    if (raw.length !== 32) throw new Error('SESSION_KEY must be 32 bytes, base64');
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `value` as JSON, sealed for `purpose`. */
export async function seal(key: CryptoKey, purpose: string, value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, key, enc.encode(JSON.stringify(value))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return b64url(out);
}

/** The value `sealed` holds, if it was sealed with `key` for `purpose`; null for anything else. */
export async function unseal(key: CryptoKey, purpose: string, sealed: string): Promise<unknown> {
    try {
        const bytes = unb64url(sealed);
        if (bytes.length < 13) return null;
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(purpose) }, key, bytes.slice(12));
        return JSON.parse(dec.decode(pt));
    } catch {
        return null;
    }
}
