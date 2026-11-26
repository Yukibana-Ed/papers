import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';

/** One program to run: a TeX Live program by name (`pdflatex`, `biber`), resolved by the runner. */
export interface RunRequest {
    readonly program: string;
    readonly args: readonly string[];
    /** Absolute; the runner may require it to be inside the folder it was made for. */
    readonly cwd: string;
    /** Added to the environment the runner builds. */
    readonly env?: Readonly<Record<string, string>>;
    /** Wall time after which the whole process tree is killed. */
    readonly timeoutMs?: number;
}

export interface RunResult {
    /** The exit code; null when the process was killed. */
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly ms: number;
    readonly timedOut: boolean;
}

/** Runs programs for a build. The sandbox package provides confined runners; `nativeRunner` runs them as the user,
 *  unconfined, and is meant only for a toolchain the user trusts with their files. */
export interface ProcessRunner {
    /** For messages: `native`, `appcontainer`, `bubblewrap`, `seatbelt`. */
    readonly kind: string;
    run(req: RunRequest): Promise<RunResult>;
}

/** Collects a child's output up to `limit` bytes, keeping the end (where TeX puts what matters). */
export function collect(limit = 4 << 20): { push(b: Buffer): void; text(): string } {
    const chunks: Buffer[] = [];
    let size = 0;
    return {
        push(b) {
            chunks.push(b);
            size += b.length;
            while (size > limit && chunks.length > 1) size -= chunks.shift()?.length ?? 0;
        },
        text: () => Buffer.concat(chunks).toString('utf8'),
    };
}

/** A runner that starts programs directly, with `texBin` (a TeX Live `bin/<platform>` folder) first on the PATH, or
 *  the user's PATH alone when it is null. Unconfined: the programs can read and write whatever the user can. */
export function nativeRunner(texBin: string | null): ProcessRunner {
    return {
        kind: 'native',
        run(req) {
            const started = performance.now();
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
            Object.assign(env, req.env);
            if (texBin) {
                // Windows spells it Path; one key only, or the child sees either.
                const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
                env[key] = `${texBin}${delimiter}${env[key] ?? ''}`;
            }
            const exe = texBin && process.platform === 'win32' ? join(texBin, `${req.program}.exe`) : req.program;
            return new Promise(resolve => {
                const child = spawn(exe, [...req.args], { cwd: req.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
                const out = collect();
                const err = collect();
                child.stdout.on('data', (b: Buffer) => out.push(b));
                child.stderr.on('data', (b: Buffer) => err.push(b));
                let timedOut = false;
                const timer = req.timeoutMs
                    ? setTimeout(() => {
                          timedOut = true;
                          child.kill('SIGKILL');
                      }, req.timeoutMs)
                    : null;
                const done = (code: number | null, extra = ''): void => {
                    if (timer) clearTimeout(timer);
                    resolve({ code, stdout: out.text(), stderr: err.text() + extra, ms: performance.now() - started, timedOut });
                };
                child.on('error', e => done(null, e.message));
                child.on('close', code => done(timedOut ? null : code));
            });
        },
    };
}
