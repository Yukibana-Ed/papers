import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collect, type ProcessRunner } from '@yukibana/papers-compiler';
import { isInside, outsideWorkDir, texEnv, type SandboxOptions } from './options.ts';

/** The launcher's C# source, shipped next to this package (and next to the CLI's bundle). */
const SOURCE = new URL('../native/windows/sandbox-run.cs', import.meta.url);

/** The AppContainer profile builds run as. One profile for every build: each build only ever gets its own work
 *  folder, granted for the run. */
export const PROFILE = 'yukibana.papers.build';

/** The in-box C# compiler of the .NET Framework 4, on every supported Windows. */
function cscPath(): string {
    return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
}

/** The user's cache folder for Yukibana Papers. */
export function cacheDir(): string {
    if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'yukibana-papers');
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'yukibana-papers');
    return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'yukibana-papers');
}

/** The launcher executable, compiled from its source on first use into the cache, keyed by the source's hash, so a
 *  changed source builds a new one. `PAPERS_SANDBOX_LAUNCHER` names a prebuilt one instead.
 *  Throws when there is no C# compiler or the build fails. */
export async function ensureLauncher(): Promise<string> {
    const given = process.env['PAPERS_SANDBOX_LAUNCHER'];
    if (given) return given;
    const source = readFileSync(SOURCE);
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const dir = join(cacheDir(), 'launcher');
    const exe = join(dir, `sandbox-run-${hash}.exe`);
    if (existsSync(exe)) return exe;
    mkdirSync(dir, { recursive: true });
    const csc = cscPath();
    if (!existsSync(csc)) throw new Error(`no C# compiler at ${csc}: the .NET Framework 4 is needed to build the sandbox launcher`);
    const tmp = `${exe}.${process.pid}.tmp`;
    await promisify(execFile)(csc, ['/nologo', '/optimize+', '/platform:x64', '/r:System.Security.dll', `/out:${tmp}`, fileURLToPath(SOURCE)], { windowsHide: true });
    renameSync(tmp, exe);
    return exe;
}

/** A drive letter no drive uses now, from the end of the alphabet. kpathsea cannot resolve its own path through
 *  folders an AppContainer may not list (`C:\`, `C:\Users`), so the TeX tree is mapped as a drive root of its own. */
function freeDrive(): string {
    for (let c = 'Z'.charCodeAt(0); c >= 'K'.charCodeAt(0); c--) {
        const d = `${String.fromCharCode(c)}:`;
        if (!existsSync(`${d}\\`)) return d;
    }
    throw new Error('no free drive letter to map the TeX tree');
}

/** A runner that starts every program in a Less Privileged AppContainer with the `registryRead` capability and a
 *  Job object: read and execute on the TeX tree, modify on the work folder only, no network, no other user files,
 *  processes, pipes or registry keys, wall-time, memory and process limits. No administrator rights are needed.
 *
 *  Programs linked without relocations (TeX Live's biber and xindy) cannot start in any AppContainer; see the
 *  project's research notes for relocatable builds. Runs are serialized: each maps the TeX tree to a free drive
 *  letter for its duration. */
export function appContainerRunner(o: SandboxOptions): ProcessRunner {
    let queue: Promise<unknown> = Promise.resolve();
    const run: ProcessRunner['run'] = async req => {
        if (!isInside(o.workDir, req.cwd)) throw outsideWorkDir(req.cwd);
        const launcher = await ensureLauncher();
        const drive = freeDrive();
        const bin = `${drive}\\${o.texBin
            .slice(o.texRoot.length)
            .replace(/^[\\/]+/, '')
            .replace(/\//g, '\\')}`;
        const env = { ...texEnv(o.workDir, '\\'), ...req.env };
        const args = [
            '--name',
            PROFILE,
            '--lpac',
            '--cap',
            'registryRead',
            '--subst',
            `${drive}=${o.texRoot}`,
            '--ro',
            o.texRoot,
            ...(o.readOnly ?? []).flatMap(d => ['--ro', d, '--path', d]),
            '--rw',
            o.workDir,
            '--path',
            bin,
            ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
            '--timeout',
            String(Math.ceil((req.timeoutMs ?? o.timeoutMs ?? 120_000) / 1000)),
            '--mem',
            String(o.memoryMb ?? 2048),
            '--procs',
            String(o.processes ?? 32),
            '--cwd',
            req.cwd,
            '--',
            req.program,
            ...req.args,
        ];
        const started = performance.now();
        return new Promise(done => {
            const child = spawn(launcher, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const out = collect();
            const err = collect();
            child.stdout.on('data', (b: Buffer) => out.push(b));
            child.stderr.on('data', (b: Buffer) => err.push(b));
            child.on('error', e => done({ code: null, stdout: '', stderr: e.message, ms: performance.now() - started, timedOut: false }));
            child.on('close', code => {
                const stderr = err.text();
                // The launcher's own summary line, and its own failures (exit 125), are not the program's.
                const own = /\[sandbox-run\] ERROR: (.*)/.exec(stderr);
                const timedOut = code === 124 || /events=.*TIMEOUT/.test(stderr);
                done({
                    code: own || timedOut ? null : code,
                    stdout: out.text(),
                    stderr: stderr.replace(/^\[sandbox-run\] exit=.*$/m, '').trim() + (own ? `\n${own[1] ?? ''}` : ''),
                    ms: performance.now() - started,
                    timedOut,
                });
            });
        });
    };
    return {
        kind: 'appcontainer',
        run(req) {
            const next = queue.then(() => run(req));
            queue = next.catch(() => undefined);
            return next;
        },
    };
}
