import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nativeRunner, type ProcessRunner } from '@yukibana/papers-compiler';
import type { SandboxOptions } from './options.ts';
import { bubblewrapRunner, seatbeltRunner } from './unix.ts';
import { appContainerRunner, ensureLauncher } from './windows.ts';

export { cacheDir, ensureLauncher, PROFILE } from './windows.ts';
export { isInside, type SandboxOptions } from './options.ts';

export type SandboxKind = 'appcontainer' | 'bubblewrap' | 'seatbelt';

/** The confinement this machine offers, and whether it works here. */
export interface SandboxSupport {
    readonly kind: SandboxKind | null;
    readonly available: boolean;
    /** What was found, or why not, in a short phrase. */
    readonly detail: string;
}

/** Checks what confinement works on this machine, by trying it: on Windows building (or finding) the launcher, on
 *  Linux running `bwrap` with a network namespace, on macOS finding `sandbox-exec`. */
export async function sandboxSupport(): Promise<SandboxSupport> {
    if (process.platform === 'win32') {
        try {
            const exe = await ensureLauncher();
            const { stdout } = await promisify(execFile)(exe, ['--name', 'yukibana.papers.probe', '--print-sid'], { windowsHide: true });
            return { kind: 'appcontainer', available: stdout.startsWith('S-1-15-2-'), detail: `AppContainer (LPAC) via ${exe}` };
        } catch (e) {
            return { kind: 'appcontainer', available: false, detail: e instanceof Error ? e.message : String(e) };
        }
    }
    if (process.platform === 'linux') {
        const bwrap = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(p => existsSync(p));
        if (!bwrap) return { kind: 'bubblewrap', available: false, detail: 'bubblewrap (bwrap) is not installed' };
        try {
            await promisify(execFile)(bwrap, ['--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true']);
            return { kind: 'bubblewrap', available: true, detail: `bubblewrap at ${bwrap}` };
        } catch (e) {
            return { kind: 'bubblewrap', available: false, detail: `bwrap cannot create namespaces here: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
        }
    }
    if (process.platform === 'darwin') {
        const ok = existsSync('/usr/bin/sandbox-exec');
        return { kind: 'seatbelt', available: ok, detail: ok ? 'Seatbelt via /usr/bin/sandbox-exec' : 'sandbox-exec is missing' };
    }
    return { kind: null, available: false, detail: `no sandbox for ${process.platform}` };
}

/** `auto`: this platform's sandbox, or an error when it does not work here. `none`: no confinement at all, the
 *  user's own explicit choice for a toolchain they trust with all their files. */
export type SandboxChoice = 'auto' | 'none';

/** A runner for one build: confined to `o.workDir` with `auto`, unconfined with `none`.
 *  Throws when `auto` finds no working sandbox: a build never silently runs unconfined. */
export async function sandboxRunner(choice: SandboxChoice, o: SandboxOptions): Promise<ProcessRunner> {
    mkdirSync(join(o.workDir, '.tmp'), { recursive: true });
    if (choice === 'none') return nativeRunner(o.texBin);
    const s = await sandboxSupport();
    if (!s.available) throw new Error(`no sandbox available (${s.detail}); build with --sandbox none only for a toolchain you trust`);
    if (s.kind === 'appcontainer') return appContainerRunner(o);
    if (s.kind === 'bubblewrap')
        return bubblewrapRunner(
            o,
            ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(p => existsSync(p)),
        );
    return seatbeltRunner(o);
}
