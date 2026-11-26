import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Environment } from '@yukibana/papers-project';
import { cacheDir } from '@yukibana/papers-sandbox';

/** A TeX installation to build with. */
export interface Toolchain {
    /** The tree's root, holding `bin/` and `texmf-dist/`. */
    readonly root: string;
    /** Its programs. */
    readonly bin: string;
    /** For messages: where it came from. */
    readonly label: string;
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

/** The toolchain whose programs are in `bin` (a TeX Live `bin/<platform>` folder), or null if it has no pdflatex. */
function fromBin(bin: string, label: string): Toolchain | null {
    const b = resolve(bin);
    if (!existsSync(join(b, exe('pdflatex')))) return null;
    // TeX Live: <root>/bin/<platform>/pdflatex. MiKTeX and distribution packages lay out differently; their root is
    // then the bin folder's parent, which is what the sandbox needs to read anyway.
    const root = basename(dirname(b)) === 'bin' ? dirname(dirname(b)) : dirname(b);
    return { root, bin: b, label };
}

/** The pdflatex on the PATH, as a toolchain, or null. */
function onPath(): Toolchain | null {
    try {
        const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pdflatex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = out.split(/\r?\n/)[0]?.trim();
        return first ? fromBin(dirname(first), `system TeX at ${dirname(first)}`) : null;
    } catch {
        return null;
    }
}

/** The managed TeX Live of `year`, if it is installed in the cache. */
function managed(year: string): Toolchain | null {
    const root = join(cacheDir(), 'texlive', year);
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'universal-darwin' : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux`;
    return fromBin(join(root, 'bin', platform), `TeX Live ${year} (managed)`);
}

/** The toolchain a build uses: `--tex` (or `PAPERS_TEX`) when given, else what the project declares. Never a guess:
 *  a project that declares `managed` does not silently build with some other TeX on the PATH.
 *  Throws with what to do when the declared environment is not available here. */
export function resolveToolchain(env: Environment, explicit: string | undefined): Toolchain {
    const given = explicit ?? process.env['PAPERS_TEX'];
    if (given) {
        const bin = existsSync(join(given, exe('pdflatex')))
            ? given
            : [join(given, 'bin', 'windows'), join(given, 'bin', 'universal-darwin'), join(given, 'bin', 'x86_64-linux'), join(given, 'bin', 'aarch64-linux')].find(b =>
                  existsSync(join(b, exe('pdflatex'))),
              );
        const t = bin ? fromBin(bin, `TeX at ${given}`) : null;
        if (!t) throw new Error(`no pdflatex in ${given} (give a TeX Live root or its bin/<platform> folder)`);
        return t;
    }
    switch (env.kind) {
        case 'system': {
            const t = onPath();
            if (!t) throw new Error('papers.toml asks for the system TeX, but there is no pdflatex on the PATH');
            return t;
        }
        case 'managed': {
            const t = managed(env.texlive);
            if (t) return t;
            throw new Error(
                `TeX Live ${env.texlive} is not installed for this project yet. Build with --tex <TeX Live folder>, or declare [environment] kind = "system" in papers.toml to use the TeX on your PATH`,
            );
        }
        case 'nix':
            throw new Error(`papers.toml asks for the nix flake ${env.flake}; run the build inside \`nix develop ${env.flake}\` with --tex pointing at its TeX`);
        case 'oci':
            throw new Error(`papers.toml asks for the image ${env.image}; local builds in containers are not supported yet`);
        default:
            throw new Error('unknown environment');
    }
}
