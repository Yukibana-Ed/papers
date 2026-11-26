import { createHash } from 'node:crypto';

/** The SHA-256 of each pinned version's `busytex-assets.tar.gz`. The release is downloaded from GitHub and deployed to
 *  the content origin as is, so a release replaced upstream must not slip in: bumping texlyre-busytex means adding its
 *  release's hash here (GitHub shows it beside the asset as its digest). */
export const RELEASE_SHA256: Readonly<Record<string, string>> = {
    '1.4.1': '4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b',
};

/** Throws unless `data` is the release of version `v` that `pins` (RELEASE_SHA256 by default) pins. */
export function checkRelease(v: string, data: Uint8Array, pins: Readonly<Record<string, string>> = RELEASE_SHA256): void {
    const expected = pins[v];
    if (expected === undefined) throw new Error(`no SHA-256 pinned for the busytex ${v} release: add it to RELEASE_SHA256 in scripts/engine-release.ts`);
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected) throw new Error(`the busytex ${v} release has SHA-256 ${actual}, not the pinned ${expected}`);
}
