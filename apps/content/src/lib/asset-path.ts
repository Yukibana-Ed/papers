/** The prefix of every engine, TeX Live and Typst asset URL the frame requests: `/r<revision>`, which `reroute`
 *  (src/hooks.ts) strips before routing. Bumping the revision gives every asset a new URL, so browsers drop anything
 *  they cached under the old ones, in particular misses cached while the store was still empty. */
export const ASSET_REVISION = 2;
export const ASSETS = `/r${ASSET_REVISION}`;

/** `pathname` without the asset prefix, or unchanged when it has none. */
export function stripAssetPrefix(pathname: string): string {
    return pathname.replace(/^\/r\d+(?=\/)/, '');
}
