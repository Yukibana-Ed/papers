/** A file as tinymist's file-system bridge carries it (`tinymist/fsChange`, answers to `tinymist/fs/watch`): its bytes,
 *  base64-encoded, as its VS Code web extension sends them. Text goes as its UTF-8 bytes; a binary file (an image, a
 *  font) as it is. A file the project does not have is an error. */
export type FsContents = { readonly type: 'ok'; readonly content: string } | { readonly type: 'err'; readonly error: string };

/** The base64 of `bytes`, in chunks (spreading a large array into one call would overflow the stack). */
export function base64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** `file` (a project file's text or bytes, or undefined when there is none) as the bridge carries it. */
export function fsContents(file: string | Uint8Array | undefined): FsContents {
    if (file === undefined) return { type: 'err', error: 'not in the project' };
    return { type: 'ok', content: base64(typeof file === 'string' ? new TextEncoder().encode(file) : file) };
}
