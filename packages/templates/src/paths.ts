/** `p` as a safe project path: `/` separators, no leading `/` or drive, no `.`/`..`/empty segments, no control
 *  characters, at most 512 characters; null for anything else. Archives and repositories are other people's data:
 *  every path from them goes through this before it names a file. */
export function safePath(p: string): string | null {
    const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (n.length === 0 || n.length > 512) return null;
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
    // Control characters, and the characters Windows cannot have in a file name.
    for (let i = 0; i < n.length; i++) if (n.charCodeAt(i) < 32 || '<>:"|?*'.includes(n.charAt(i))) return null;
    const parts = n.split('/');
    if (parts.some(s => s === '' || s === '.' || s === '..' || s.endsWith(' ') || s.endsWith('.'))) return null;
    return n;
}

/** A folder name for a new paper inside a repository: `safePath`, or `''` for the repository's root. */
export function safeFolder(folder: string): string | null {
    const f = folder.trim().replace(/^\/+|\/+$/g, '');
    return f === '' ? '' : safePath(f);
}

/** A repository name GitHub accepts, made from a paper's name: letters, digits, `-`, `_`, `.`; at most 100. */
export function repositoryName(name: string): string {
    const n = name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 100);
    return n === '' ? 'paper' : n;
}
