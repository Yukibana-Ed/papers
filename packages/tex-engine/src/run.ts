/** One run of the engine, and the snapshots it leaves.
 *
 *  A run is a function of what the host answered it: the bytes of the files it read, what it was told about the paths
 *  it asked for, the clock. For the project's files the host records those answers as observations. A snapshot is the
 *  run's state at a pause: the module's memory, the open files with their positions, and the outputs so far. It fits
 *  any state of the project that would have answered the observations made before it in the same way, and from it a
 *  run goes on exactly as a run from the start on that project would. The tree outside the project is taken not to
 *  change, so what is read from it is not recorded. */
import { absolute, commonPrefix, projectKind, projectList, type DirEntry, type Kind, type Project, type Tree } from './files.ts';
import type { HostImports, Machine, MemoryImage } from './memory.ts';

// Error numbers of WASI, which Emscripten's C library uses.
const EBADF = 8;
const EINVAL = 28;
const ENOENT = 44;
const ENOSYS = 52;
// Flags of open(2), as the C library passes them.
const O_ACCMODE = 3;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;
/** Bytes of a `struct dirent` record as the host writes them. */
const DIRENT = 280;
/** Files whose bytes are not lines of text. Text of the project is given to the engine a line a read: any split of a
 *  file into reads is correct, and this one makes a snapshot depend on no more of a file than the engine has used. */
const BINARY = /\.(pdf|png|jpe?g|eps|ps|gif|bmp|ttf|otf|pfb|tfm|vf|jbig2|jb2)$/i;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** What a run has seen of one project file. Immutable. */
interface FileSeen {
    /** The file's bytes when the run read it. */
    readonly data: Uint8Array;
    /** The run read the first `read` bytes. */
    readonly read: number;
    /** The run saw the file end after `read` bytes. */
    readonly end: boolean;
    /** The run asked for the file's length. */
    readonly length: boolean;
    /** The run read the file out of order: every byte counts. */
    readonly whole: boolean;
}

/** What a run was told about a path of the project, other than a file's bytes. */
type Observation =
    | readonly ['absent', path: string]
    | readonly ['kind', path: string, kind: Kind]
    | readonly ['stat', path: string, kind: Kind, size: number]
    | readonly ['list', path: string, entries: string];

type Descriptor =
    | { readonly kind: 'null' }
    | { readonly kind: 'in'; readonly path: string; readonly data: Uint8Array; readonly project: boolean; pos: number }
    | { readonly kind: 'out' | 'own'; readonly path: string; pos: number }
    | { readonly kind: 'dir'; readonly entries: readonly DirEntry[]; pos: number };

/** An output file: `length` bytes of `bytes`. The first `shared` bytes belong to snapshots too and are not written
 *  again in place. */
interface Output {
    bytes: Uint8Array;
    length: number;
    shared: number;
}

/** The state of a run at a pause. Immutable. */
export interface Snapshot {
    readonly run: Run;
    readonly memory: MemoryImage;
    /** Milliseconds the engine ran from the start of the job to here. */
    readonly cpu: number;
    /** Pages shipped out before here. */
    readonly pages: number;
    readonly descriptors: ReadonlyMap<number, Descriptor>;
    readonly nextDescriptor: number;
    readonly outputs: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly length: number }>;
    readonly files: ReadonlyMap<string, FileSeen>;
    /** How many of the run's observations were made before here. */
    readonly observations: number;
}

/** What every run of a job has in common. Snapshots are shared only between runs with equal settings. */
export interface JobSettings {
    readonly tree: Tree;
    /** Where the project is: an absolute, normalized path. A project's paths are relative to it. */
    readonly root: string;
    /** The directory the run starts in: `root` or a directory under it, absolute and normalized. */
    readonly cwd: string;
    /** The command line, program name first. */
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /** The time the engine is told it is, in seconds since 1970: the same during the whole run. */
    readonly time: number;
}

export interface RunOptions {
    readonly machine: Machine;
    readonly job: JobSettings;
    readonly project: Project;
    /** Milliseconds of engine time between two snapshots; Infinity for none but those at the ends of `go`. */
    readonly snapshotEvery?: number;
    /** A snapshot to go on from, of a run with the same `job`. Precondition: `fits(from, project)`. */
    readonly from?: Snapshot;
    /** The clock that engine time is measured with, in milliseconds. */
    readonly now?: () => number;
}

class Exit extends Error {
    readonly code: number;
    constructor(code: number) {
        super(`exit ${code}`);
        this.code = code;
    }
}

/** Why `Run.go` returned: the job ended, the page asked for is out, or the time was up. */
export type Stop = 'done' | 'held' | 'paused';

export class Run {
    readonly machine: Machine;
    readonly job: JobSettings;
    readonly project: Project;
    /** The snapshots taken, in order. */
    readonly snapshots: Snapshot[] = [];
    /** The pages shipped out: the page's number and the engine time when it was out. */
    readonly pages: (readonly [page: number, cpu: number])[];
    /** The engine's exit code once the job ended. */
    exitCode: number | null = null;

    readonly #every: number;
    readonly #now: () => number;
    readonly #from: Snapshot | null;
    readonly #observations: Observation[];
    #files: Map<string, FileSeen>;
    #descriptors: Map<number, Descriptor>;
    #nextDescriptor: number;
    #outputs: Map<string, Output>;
    #cpu: number;
    #lastSnapshot: number;
    #started = false;
    #clock = 0;
    #until = Infinity;
    #deadline = Infinity;
    #stop = false;
    readonly #host: HostImports;

    constructor(options: RunOptions) {
        this.machine = options.machine;
        this.job = options.job;
        this.project = options.project;
        this.#every = options.snapshotEvery ?? Infinity;
        this.#now = options.now ?? ((): number => performance.now());
        const from = options.from ?? null;
        this.#from = from;
        if (from === null) {
            this.#descriptors = new Map<number, Descriptor>([
                [0, { kind: 'null' }],
                [1, { kind: 'out', path: '<stdout>', pos: 0 }],
                [2, { kind: 'out', path: '<stderr>', pos: 0 }],
            ]);
            this.#nextDescriptor = 3;
            this.#outputs = new Map();
            this.#observations = [];
            this.#files = new Map();
            this.#cpu = 0;
            this.pages = [];
        } else {
            if (from.run.job !== options.job) throw new Error('the snapshot is of another job');
            // What the earlier run read of the project is the same in this project (the precondition), but this run
            // reads on in this project's bytes: its open files and what it has seen of each are moved onto them.
            const current = (path: string, was: Uint8Array): Uint8Array => {
                const now = options.project.get(this.#relative(path) ?? '');
                if (now === undefined) throw new Error(`the snapshot does not fit the project: ${path} is gone`);
                return now === was ? was : now;
            };
            this.#descriptors = new Map([...from.descriptors].map(([fd, d]) => [fd, d.kind === 'in' && d.project ? { ...d, data: current(d.path, d.data) } : { ...d }]));
            this.#nextDescriptor = from.nextDescriptor;
            // Another run's bytes: copied at the first write.
            this.#outputs = new Map([...from.outputs].map(([path, o]) => [path, { bytes: o.bytes, length: o.length, shared: Infinity }]));
            this.#observations = from.run.#observations.slice(0, from.observations);
            this.#files = new Map([...from.files].map(([path, seen]) => [path, { ...seen, data: current(path, seen.data) }]));
            this.#cpu = from.cpu;
            this.pages = from.run.pages.slice(0, from.pages);
        }
        this.#lastSnapshot = this.#cpu;
        this.#host = this.#imports();
    }

    /** The latest state of this run that can be gone on from: null before the first pause of a run from the start. */
    get last(): Snapshot | null {
        return this.snapshots.at(-1) ?? this.#from;
    }

    /** Whether the job ended. */
    get done(): boolean {
        return this.exitCode !== null;
    }

    /** Milliseconds the engine ran from the start of the job to where this run stands. */
    get cpu(): number {
        return this.#cpu;
    }

    /** The outputs so far, by absolute path (`<stdout>` and `<stderr>` for the two streams). The arrays are views:
     *  copy what must outlive the run's next step. */
    outputs(): Map<string, Uint8Array> {
        return new Map([...this.#outputs].map(([path, o]) => [path, o.bytes.subarray(0, o.length)]));
    }

    /** Runs the engine until the job ends ('done'), page `untilPage` is out ('held'), or the clock passes `deadline`
     *  ('paused'). Every return but 'done' leaves a snapshot of where the run stands (`last`), and the run goes on
     *  with another `go`, whatever used the machine in between. Precondition: not `done`. */
    go(limits: { readonly untilPage?: number; readonly deadline?: number } = {}): Stop {
        if (this.done) throw new Error('the job has ended');
        this.#until = limits.untilPage ?? Infinity;
        this.#deadline = limits.deadline ?? Infinity;
        this.#stop = this.pages.some(([page]) => page >= this.#until);
        const machine = this.machine;
        try {
            for (let first = true; ; first = false) {
                let paused: number;
                if (!this.#started) {
                    this.#started = true;
                    if (this.#from === null) {
                        machine.start(this, this.#host);
                        const argv = this.#arguments();
                        this.#clock = this.#now();
                        paused = machine.exports.inc_main(this.job.args.length, argv);
                    } else {
                        machine.restore(this, this.#host, this.#from.memory);
                        this.#clock = this.#now();
                        paused = this.#resume();
                    }
                } else {
                    // Where this run stands is its last snapshot: every return from the engine took one.
                    const at = this.last;
                    if (first && machine.owner !== this && at !== null) machine.restore(this, this.#host, at.memory);
                    this.#clock = this.#now();
                    paused = this.#resume();
                }
                if (paused !== 1) throw new Error('the engine returned without pausing or ending');
                this.#snapshot();
                if (this.#stop) return 'held';
                if (this.#now() >= this.#deadline) return 'paused';
            }
        } catch (e) {
            if (!(e instanceof Exit)) throw e;
            this.#tock();
            this.exitCode = e.code;
            return 'done';
        }
    }

    /** The outputs the job would have if it ended where this run stands: the PDF then has its fonts, page tree and
     *  cross-reference table, so it can be shown. The run is not disturbed. Precondition: the run has paused. */
    preview(): Map<string, Uint8Array> {
        const at = this.last;
        if (at === null) throw new Error('the run has not paused');
        const copy = new Run({ machine: this.machine, job: this.job, project: this.project, from: at, now: this.#now });
        this.machine.restore(copy, copy.#host, at.memory);
        try {
            const finish = this.machine.exports.inc_finish;
            if (finish === undefined) throw new Error('the program cannot end early');
            finish();
        } catch (e) {
            if (!(e instanceof Exit)) throw e;
        }
        return copy.outputs();
    }

    #resume(): number {
        const resume = this.machine.exports.inc_resume;
        if (resume === undefined) throw new Error('the program cannot go on after a pause');
        return resume();
    }

    #tock(): void {
        const t = this.#now();
        this.#cpu += t - this.#clock;
        this.#clock = t;
    }

    #snapshot(): void {
        this.#tock();
        const outputs = new Map<string, { bytes: Uint8Array; length: number }>();
        for (const [path, o] of this.#outputs) {
            o.shared = Math.max(o.shared, o.length);
            outputs.set(path, { bytes: o.bytes, length: o.length });
        }
        this.snapshots.push({
            run: this,
            memory: this.machine.capture(),
            cpu: this.#cpu,
            pages: this.pages.length,
            descriptors: new Map([...this.#descriptors].map(([fd, d]) => [fd, { ...d }])),
            nextDescriptor: this.#nextDescriptor,
            outputs,
            files: new Map(this.#files),
            observations: this.#observations.length,
        });
        this.#lastSnapshot = this.#cpu;
    }

    /** Writes the command line into the module's memory; returns the address of argv. */
    #arguments(): number {
        const x = this.machine.exports;
        const args = this.job.args.map(a => encoder.encode(`${a}\0`));
        const argv = x.inc_alloc(4 * (args.length + 1));
        const at = args.map(a => x.inc_alloc(a.length));
        const memory = this.machine.bytes();
        const view = new DataView(memory.buffer);
        for (const [i, a] of args.entries()) {
            const p = at[i] ?? 0;
            memory.set(a, p);
            this.machine.mark(p, a.length);
            view.setUint32(argv + 4 * i, p, true);
        }
        view.setUint32(argv + 4 * args.length, 0, true);
        this.machine.mark(argv, 4 * (args.length + 1));
        return argv;
    }

    /** The path of the project file at the absolute path `path`; null when `path` is outside the project. */
    #relative(path: string): string | null {
        const root = this.job.root;
        if (path === root) return '';
        return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
    }

    #kind(path: string): Kind {
        const rel = this.#relative(path);
        return rel === null ? this.job.tree.kind(path) : projectKind(this.project, rel);
    }

    #read(path: string): Uint8Array | null {
        const rel = this.#relative(path);
        return rel === null ? this.job.tree.read(path) : (this.project.get(rel) ?? null);
    }

    #seen(path: string, data: Uint8Array, change: Partial<FileSeen>): void {
        const old = this.#files.get(path) ?? { data, read: 0, end: false, length: false, whole: false };
        this.#files.set(path, { ...old, ...change });
    }

    #imports(): HostImports {
        const machine = this.machine;
        const bytes = (): Uint8Array => machine.bytes();
        const view = (): DataView => new DataView(machine.exports.memory.buffer);
        const string = (p: number): string => {
            const m = bytes();
            let e = p;
            while (m[e] !== 0) e++;
            return decoder.decode(m.subarray(p, e));
        };
        const path = (p: number): string => absolute(this.job.cwd, string(p));
        const descriptor = (d: Descriptor): number => {
            const fd = this.#nextDescriptor++;
            this.#descriptors.set(fd, d);
            return fd;
        };
        const output = (p: string): Output => {
            let o = this.#outputs.get(p);
            if (o === undefined) {
                o = { bytes: new Uint8Array(65536), length: 0, shared: 0 };
                this.#outputs.set(p, o);
            }
            return o;
        };
        const writeStat = (kind: number, size: number, pKind: number, pSize: number, pTime: number): void => {
            const v = view();
            v.setInt32(pKind, kind, true);
            v.setFloat64(pSize, size, true);
            v.setFloat64(pTime, this.job.time, true);
            machine.mark(pKind, 4);
            machine.mark(pSize, 8);
            machine.mark(pTime, 8);
        };
        const u32 = (p: number, value: number): void => {
            view().setUint32(p, value, true);
            machine.mark(p, 4);
        };
        const u64 = (p: number, value: number): void => {
            view().setBigUint64(p, BigInt(value), true);
            machine.mark(p, 8);
        };
        const environment = (): Uint8Array[] => Object.entries(this.job.env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));

        const inc = {
            tick: (): number => {
                this.#tock();
                return this.#stop || this.#cpu - this.#lastSnapshot >= this.#every || this.#clock >= this.#deadline ? 1 : 0;
            },
            page: (n: number): void => {
                this.#tock();
                this.pages.push([n, this.#cpu]);
                if (n >= this.#until) this.#stop = true;
            },
            open: (pPath: number, flags: number): number => {
                const p = path(pPath);
                if ((flags & O_ACCMODE) !== 0) {
                    // Written files live in the host, one set per run.
                    const o = output(p);
                    if ((flags & O_TRUNC) !== 0) {
                        o.length = 0;
                        if (o.shared > 0) {
                            o.bytes = new Uint8Array(65536);
                            o.shared = 0;
                        }
                    }
                    return descriptor({ kind: 'out', path: p, pos: (flags & O_APPEND) !== 0 ? o.length : 0 });
                }
                if (this.#outputs.has(p)) return descriptor({ kind: 'own', path: p, pos: 0 });
                const inProject = this.#relative(p) !== null;
                const data = this.#read(p);
                if (data !== null) {
                    // That the file is there is seen, whatever is read of it.
                    if (inProject && !this.#files.has(p)) this.#seen(p, data, {});
                    return descriptor({ kind: 'in', path: p, data, project: inProject, pos: 0 });
                }
                if (this.#kind(p) === 2) {
                    const rel = this.#relative(p);
                    const entries = rel === null ? this.job.tree.list(p) : (projectList(this.project, rel) ?? []);
                    if (inProject) this.#observations.push(['list', p, listing(entries)]);
                    return descriptor({ kind: 'dir', entries, pos: 0 });
                }
                if (inProject) this.#observations.push(['absent', p]);
                return -ENOENT;
            },
            kind: (pPath: number): number => {
                const p = path(pPath);
                if (this.#outputs.has(p)) return 1;
                const k = this.#kind(p);
                if (this.#relative(p) !== null) this.#observations.push(['kind', p, k]);
                return k;
            },
            stat: (pPath: number, pKind: number, pSize: number, pTime: number): number => {
                const p = path(pPath);
                const o = this.#outputs.get(p);
                let kind: Kind = 1;
                let size = o?.length ?? 0;
                if (o === undefined) {
                    kind = this.#kind(p);
                    size = kind === 1 ? (this.#read(p)?.length ?? 0) : 0;
                    if (this.#relative(p) !== null) this.#observations.push(['stat', p, kind, size]);
                }
                if (kind === 0) return -ENOENT;
                writeStat(kind, size, pKind, pSize, pTime);
                return 0;
            },
            fstat: (fd: number, pKind: number, pSize: number, pTime: number): number => {
                const d = this.#descriptors.get(fd);
                if (d === undefined) return -EBADF;
                let kind = 3;
                let size = 0;
                if (d.kind === 'in') {
                    kind = 1;
                    size = d.data.length;
                    if (d.project) this.#seen(d.path, d.data, { length: true });
                } else if (d.kind === 'dir') kind = 2;
                else if (d.kind === 'own' || (d.kind === 'out' && !d.path.startsWith('<'))) {
                    kind = 1;
                    size = this.#outputs.get(d.path)?.length ?? 0;
                }
                writeStat(kind, size, pKind, pSize, pTime);
                return 0;
            },
            find: (format: number, pName: number, pPath: number, size: number): number => {
                const found = this.job.tree.find(format, string(pName));
                if (found === null) return 0;
                const b = encoder.encode(found);
                if (b.length >= size) return 0;
                bytes().set(b, pPath);
                machine.mark(pPath, b.length);
                return b.length;
            },
            getcwd: (pBuffer: number, size: number): number => {
                const b = encoder.encode(`${this.job.cwd}\0`);
                if (b.length > size) return -EINVAL;
                bytes().set(b, pBuffer);
                machine.mark(pBuffer, b.length);
                return b.length;
            },
            unlink: (pPath: number): number => (this.#outputs.delete(path(pPath)) ? 0 : -ENOENT),
            rename: (pFrom: number, pTo: number): number => {
                const from = path(pFrom);
                const o = this.#outputs.get(from);
                if (o === undefined) return -ENOENT;
                this.#outputs.set(path(pTo), o);
                this.#outputs.delete(from);
                return 0;
            },
            mkdir: (): number => 0,
            readdir: (fd: number, pBuffer: number, count: number): number => {
                const d = this.#descriptors.get(fd);
                if (d?.kind !== 'dir') return -EBADF;
                const v = view();
                const m = bytes();
                let n = 0;
                // Records of `struct dirent`: inode 8 bytes, offset 8, record length 2, type 1, name.
                for (let entry = d.entries[d.pos]; entry !== undefined && n + DIRENT <= count; entry = d.entries[d.pos]) {
                    const o = pBuffer + n;
                    m.fill(0, o, o + DIRENT);
                    v.setBigUint64(o, BigInt(d.pos + 1), true);
                    v.setBigInt64(o + 8, BigInt(d.pos + 1), true);
                    v.setUint16(o + 16, DIRENT, true);
                    v.setUint8(o + 18, entry.kind === 2 ? 4 : 8);
                    m.set(encoder.encode(entry.name).subarray(0, 255), o + 19);
                    d.pos++;
                    n += DIRENT;
                }
                machine.mark(pBuffer, n);
                return n;
            },
        };

        const wasi = {
            fd_close: (fd: number): number => (this.#descriptors.delete(fd) ? 0 : EBADF),
            proc_exit: (code: number): never => {
                throw new Exit(code);
            },
            clock_time_get: (_id: number, _precision: bigint, pTime: number): number => {
                view().setBigUint64(pTime, BigInt(Math.round(this.job.time)) * 1_000_000_000n, true);
                machine.mark(pTime, 8);
                return 0;
            },
            environ_sizes_get: (pCount: number, pSize: number): number => {
                const e = environment();
                u32(pCount, e.length);
                u32(
                    pSize,
                    e.reduce((n, s) => n + s.length, 0),
                );
                return 0;
            },
            environ_get: (pPointers: number, pBuffer: number): number => {
                let at = pBuffer;
                for (const [i, s] of environment().entries()) {
                    u32(pPointers + 4 * i, at);
                    bytes().set(s, at);
                    machine.mark(at, s.length);
                    at += s.length;
                }
                return 0;
            },
            fd_write: (fd: number, pVectors: number, count: number, pWritten: number): number => {
                const d = this.#descriptors.get(fd);
                if (d?.kind !== 'out') return EBADF;
                const v = view();
                const m = bytes();
                const o = output(d.path);
                let total = 0;
                for (let i = 0; i < count; i++) {
                    const p = v.getUint32(pVectors + 8 * i, true);
                    const n = v.getUint32(pVectors + 8 * i + 4, true);
                    if (d.pos + n > o.bytes.length || d.pos < o.shared) {
                        // More room, or bytes a snapshot owns: those stay as they are, the output goes on in a copy.
                        const grown = new Uint8Array(Math.max(d.pos + n > o.bytes.length ? o.bytes.length * 2 : o.bytes.length, d.pos + n));
                        grown.set(o.bytes.subarray(0, o.length));
                        o.bytes = grown;
                        o.shared = 0;
                    }
                    o.bytes.set(m.subarray(p, p + n), d.pos);
                    d.pos += n;
                    if (d.pos > o.length) o.length = d.pos;
                    total += n;
                }
                u32(pWritten, total);
                return 0;
            },
            fd_read: (fd: number, pVectors: number, count: number, pRead: number): number => {
                const d = this.#descriptors.get(fd);
                if (d === undefined || d.kind === 'out' || d.kind === 'dir') return EBADF;
                if (d.kind === 'null') {
                    u32(pRead, 0);
                    return 0;
                }
                const own = d.kind === 'own' ? this.#outputs.get(d.path) : undefined;
                const data = d.kind === 'in' ? d.data : (own?.bytes.subarray(0, own.length) ?? new Uint8Array(0));
                const observed = d.kind === 'in' && d.project;
                const lines = observed && !BINARY.test(d.path);
                const v = view();
                const m = bytes();
                let total = 0;
                for (let i = 0; i < count; i++) {
                    const p = v.getUint32(pVectors + 8 * i, true);
                    const want = v.getUint32(pVectors + 8 * i + 4, true);
                    if (want === 0) continue;
                    let n = Math.min(want, data.length - d.pos);
                    if (lines && n > 0) {
                        const newline = data.indexOf(10, d.pos);
                        if (newline >= 0 && newline - d.pos + 1 < n) n = newline - d.pos + 1;
                    }
                    if (n <= 0) {
                        if (observed) this.#seen(d.path, data, { end: true });
                        break;
                    }
                    m.set(data.subarray(d.pos, d.pos + n), p);
                    machine.mark(p, n);
                    if (observed) {
                        const seen = this.#files.get(d.path);
                        const read = seen?.read ?? 0;
                        if (d.pos > read) this.#seen(d.path, data, { whole: true });
                        else if (d.pos + n > read) this.#seen(d.path, data, { read: d.pos + n });
                    }
                    d.pos += n;
                    total += n;
                    if (lines) break;
                }
                u32(pRead, total);
                return 0;
            },
            fd_seek: (fd: number, offset: bigint, whence: number, pPosition: number): number => {
                const d = this.#descriptors.get(fd);
                if (d === undefined || d.kind === 'null' || d.kind === 'dir') return EBADF;
                let base = 0;
                if (whence === 1) base = d.pos;
                else if (whence === 2) {
                    if (d.kind === 'in') {
                        base = d.data.length;
                        if (d.project) this.#seen(d.path, d.data, { length: true });
                    } else base = this.#outputs.get(d.path)?.length ?? 0;
                }
                d.pos = base + Number(offset);
                u64(pPosition, d.pos);
                return 0;
            },
        };

        // What the C library links but the engine does not use: processes, sockets, links.
        const env = {
            emscripten_notify_memory_growth: (): void => undefined,
            __syscall_pipe: (): number => -ENOSYS,
            __syscall_readlinkat: (): number => -EINVAL,
            __syscall_rmdir: (): number => -ENOSYS,
            _emscripten_system: (): number => -1,
            __syscall_connect: (): number => -ENOSYS,
            __syscall_socket: (): number => -ENOSYS,
        };
        return { inc, wasi_snapshot_preview1: wasi, env };
    }

    /** Whether a run of the same job on `project` would be this run again, byte for byte: everything this run observed
     *  of its project is the same in `project`. Precondition: `done`. */
    repeats(project: Project): boolean {
        if (!this.done) throw new Error('the job has not ended');
        return Run.fits({ run: this, files: this.#files, observations: this.#observations.length }, project);
    }

    /** Whether everything this run had observed of the project before `snapshot` is the same in `project`. */
    static fits(snapshot: Pick<Snapshot, 'run' | 'files' | 'observations'>, project: Project, memo: FitMemo = new FitMemo()): boolean {
        const run = snapshot.run;
        // Observations only accumulate along a run: its first one that fails decides for every later snapshot.
        let failing = memo.failing.get(run);
        if (failing === undefined) {
            failing = run.#observations.findIndex(o => !holds(run, o, project));
            if (failing < 0) failing = Infinity;
            memo.failing.set(run, failing);
        }
        if (snapshot.observations > failing) return false;
        for (const [path, seen] of snapshot.files) {
            const now = project.get(run.#relative(path) ?? '');
            if (now === undefined) return false;
            if (now === seen.data) continue;
            let byNow = memo.common.get(seen.data);
            if (byNow === undefined) memo.common.set(seen.data, (byNow = new Map<Uint8Array, number>()));
            let common = byNow.get(now);
            if (common === undefined) byNow.set(now, (common = commonPrefix(seen.data, now)));
            const equal = common === seen.data.length && now.length === seen.data.length;
            if (seen.whole ? !equal : common < seen.read || (seen.end && now.length !== seen.read) || (seen.length && now.length !== seen.data.length)) return false;
        }
        return true;
    }
}

/** What `Run.fits` has worked out for one project, to be shared between the snapshots asked about. */
export class FitMemo {
    readonly failing = new Map<Run, number>();
    /** Bytes read by a run, then bytes of the project asked about: how many leading bytes the two share. */
    readonly common = new Map<Uint8Array, Map<Uint8Array, number>>();
}

function listing(entries: readonly DirEntry[]): string {
    return entries.map(e => `${e.name}\t${e.kind}`).join('\n');
}

function holds(run: Run, o: Observation, project: Project): boolean {
    const root = run.job.root;
    const rel = o[1] === root ? '' : o[1].slice(root.length + 1);
    const kind = projectKind(project, rel);
    if (o[0] === 'absent') return kind === 0;
    if (o[0] === 'kind') return kind === o[2];
    if (o[0] === 'stat') return kind === o[2] && (kind !== 1 || project.get(rel)?.length === o[3]);
    return kind === 2 && listing(projectList(project, rel) ?? []) === o[2];
}

/** The snapshot furthest into its job, among `snapshots`, that fits `project`; null when none does. */
export function furthest(snapshots: Iterable<Snapshot>, project: Project): Snapshot | null {
    const memo = new FitMemo();
    for (const s of [...snapshots].toSorted((a, b) => b.cpu - a.cpu)) if (Run.fits(s, project, memo)) return s;
    return null;
}
