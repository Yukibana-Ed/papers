import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collect, type ProcessRunner, type RunRequest, type RunResult } from '@yukibana/papers-compiler';
import { isInside, outsideWorkDir, texEnv, type SandboxOptions } from './options.ts';

/** Starts `command` in a process group of its own and kills the whole group at the deadline. */
function runGroup(command: string, args: readonly string[], env: Record<string, string>, req: RunRequest, timeoutMs: number): Promise<RunResult> {
    const started = performance.now();
    return new Promise(done => {
        const child = spawn(command, [...args], { cwd: req.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = collect();
        const err = collect();
        child.stdout.on('data', (b: Buffer) => out.push(b));
        child.stderr.on('data', (b: Buffer) => err.push(b));
        let timedOut = false;
        const kill = (): void => {
            try {
                if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
            } catch {
                // Already gone.
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, timeoutMs);
        child.on('error', e => {
            clearTimeout(timer);
            done({ code: null, stdout: '', stderr: e.message, ms: performance.now() - started, timedOut: false });
        });
        child.on('close', code => {
            clearTimeout(timer);
            kill(); // detached children left behind
            done({ code: timedOut ? null : code, stdout: out.text(), stderr: err.text(), ms: performance.now() - started, timedOut });
        });
    });
}

/** The environment of a confined run: nothing of the user's, only what TeX needs. */
function cleanEnv(o: SandboxOptions, home: string, extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
    return { PATH: `${o.texBin}:/usr/bin:/bin`, HOME: home, TMPDIR: `${o.workDir}/.tmp`, LANG: 'C.UTF-8', ...texEnv(o.workDir, '/'), ...extra };
}

/** Linux: bubblewrap (`bwrap`), unprivileged user namespaces. The build sees the system's `/usr`, `/bin`, `/lib*` and
 *  `/etc` read-only (shared libraries, fonts config, locale), the TeX tree read-only, the work folder read-write, a
 *  private `/tmp`, and no network (a namespace with only loopback). It dies with its parent. */
export function bubblewrapRunner(o: SandboxOptions, bwrap = '/usr/bin/bwrap'): ProcessRunner {
    return {
        kind: 'bubblewrap',
        run(req) {
            if (!isInside(o.workDir, req.cwd)) return Promise.reject(outsideWorkDir(req.cwd));
            const ro = (p: string): string[] => (existsSync(p) ? ['--ro-bind', p, p] : []);
            const args = [
                '--unshare-all',
                '--die-with-parent',
                '--new-session',
                // The private /tmp first: bwrap mounts in order, and a work folder or TeX tree under /tmp (as in tests and
                // CI) must be bound over it, not hidden by it.
                '--tmpfs',
                '/tmp',
                ...['/usr', '/bin', '/lib', '/lib64', '/lib32', '/etc/fonts', '/etc/ssl', '/etc/alternatives', '/etc/ld.so.cache', '/etc/localtime'].flatMap(ro),
                '--ro-bind',
                o.texRoot,
                o.texRoot,
                ...(o.readOnly ?? []).flatMap(d => ['--ro-bind', d, d]),
                '--bind',
                o.workDir,
                o.workDir,
                '--proc',
                '/proc',
                '--dev',
                '/dev',
                '--chdir',
                req.cwd,
                '--clearenv',
                ...Object.entries(cleanEnv(o, o.workDir, req.env)).flatMap(([k, v]) => ['--setenv', k, v]),
                '--',
                req.program,
                ...req.args,
            ];
            return runGroup(bwrap, args, {}, req, req.timeoutMs ?? o.timeoutMs ?? 120_000);
        },
    };
}

const PROFILE = new URL('../native/macos/yk.sb', import.meta.url);

/** macOS: Seatbelt through `sandbox-exec` with the `yk.sb` profile: deny by default; the TeX tree and the system
 *  paths TeX needs read-only; the work folder read-write; no network; signals and process inspection only inside the
 *  sandbox. Seatbelt matches resolved paths, so every folder is passed resolved. macOS cannot cap memory without
 *  root; the wall-time limit kills the process group. */
export function seatbeltRunner(o: SandboxOptions): ProcessRunner {
    return {
        kind: 'seatbelt',
        run(req) {
            if (!isInside(o.workDir, req.cwd)) return Promise.reject(outsideWorkDir(req.cwd));
            const tex = realpathSync(o.texRoot);
            const work = realpathSync(o.workDir);
            const py = realpathSync(o.readOnly?.[0] ?? o.texRoot);
            const env = cleanEnv({ ...o, workDir: work }, work, req.env);
            const args = ['-f', fileURLToPath(PROFILE), '-D', `TEX=${tex}`, '-D', `PY=${py}`, '-D', `SCRATCH=${work}`, req.program, ...req.args];
            return runGroup('/usr/bin/sandbox-exec', args, env, req, req.timeoutMs ?? o.timeoutMs ?? 120_000);
        },
    };
}
