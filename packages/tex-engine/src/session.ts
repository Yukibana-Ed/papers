/** A job that is run again and again while its project is edited, each time from the furthest snapshot that still
 *  fits, with the snapshots kept within a memory budget. */
import type { Project } from './files.ts';
import { heldBytes, Machine } from './memory.ts';
import { FitMemo, Run, type JobSettings, type Snapshot, type Stop } from './run.ts';

export interface SessionOptions {
    /** The engine, compiled. */
    readonly module: WebAssembly.Module;
    readonly job: JobSettings;
    /** Milliseconds of engine time between snapshots. Default 30. */
    readonly snapshotEvery?: number;
    /** Bytes the snapshots may hold together. Default 256 MiB. */
    readonly budget?: number;
    readonly now?: () => number;
    /** Check the engine's write tracking at every capture and restore (slow: for tests). */
    readonly verify?: boolean;
}

/** What `Session.edit` found. */
export interface Resumption {
    /** Engine time of the snapshot the new run goes on from; 0 when it starts the job again. */
    readonly from: number;
    /** Pages that were shipped out before that snapshot: they are as in the run it was taken from. */
    readonly pages: number;
}

export class Session {
    readonly machine: Machine;
    readonly job: JobSettings;
    readonly #every: number;
    readonly #budget: number;
    readonly #now: (() => number) | undefined;
    /** Every snapshot kept, with whether it fits the current project. */
    readonly #kept = new Map<Snapshot, boolean>();
    #run: Run | null = null;
    /** How many of the current run's snapshots are in `#kept`. */
    #taken = 0;

    constructor(options: SessionOptions) {
        this.machine = new Machine(options.module, { verify: options.verify ?? false });
        this.job = options.job;
        this.#every = options.snapshotEvery ?? 30;
        this.#budget = options.budget ?? 256 * 2 ** 20;
        this.#now = options.now;
    }

    /** The run of the current project. Precondition: `edit` was called. */
    get run(): Run {
        if (this.#run === null) throw new Error('the session has no project yet');
        return this.#run;
    }

    /** Bytes the kept snapshots hold. */
    get held(): number {
        return heldBytes([...this.#kept.keys()].map(s => s.memory));
    }

    /** How many snapshots are kept. */
    get snapshots(): number {
        return this.#kept.size;
    }

    /** Makes `project` the current project: its run goes on from the furthest kept snapshot that fits it, or starts
     *  the job when none does. The run is not advanced. */
    edit(project: Project): Resumption {
        this.#collect();
        const memo = new FitMemo();
        let from: Snapshot | null = null;
        for (const s of this.#kept.keys()) {
            const fits = Run.fits(s, project, memo);
            this.#kept.set(s, fits);
            if (fits && (from === null || s.cpu > from.cpu)) from = s;
        }
        this.#prune(from);
        this.#run = new Run({
            machine: this.machine,
            job: this.job,
            project,
            snapshotEvery: this.#every,
            ...(from === null ? {} : { from }),
            ...(this.#now === undefined ? {} : { now: this.#now }),
        });
        this.#taken = 0;
        return { from: from?.cpu ?? 0, pages: from?.pages ?? 0 };
    }

    /** Advances the current run: see `Run.go`. Precondition: `edit` was called and the run has not ended. */
    advance(limits: { readonly untilPage?: number; readonly deadline?: number } = {}): Stop {
        const stop = this.run.go(limits);
        this.#collect();
        this.#prune(this.run.last);
        return stop;
    }

    #collect(): void {
        const run = this.#run;
        if (run === null) return;
        for (const s of run.snapshots.slice(this.#taken)) this.#kept.set(s, true);
        this.#taken = run.snapshots.length;
    }

    /** Drops snapshots until the rest is within the budget: first those that do not fit the current project, oldest
     *  run first; then, of those that fit, every second one in job order. `keep` is never dropped. */
    #prune(keep: Snapshot | null): void {
        if (this.held <= this.#budget) return;
        for (const [s, fits] of this.#kept) {
            if (fits || s === keep) continue;
            this.#kept.delete(s);
        }
        while (this.held > this.#budget) {
            const order = [...this.#kept.keys()].filter(s => s !== keep).toSorted((a, b) => a.cpu - b.cpu);
            if (order.length === 0) return;
            // The first snapshots of a job are the ones every edit can use: thinning starts from the far end.
            for (let i = order.length - 1; i >= 0; i -= 2) {
                const s = order[i];
                if (s !== undefined) this.#kept.delete(s);
            }
        }
    }
}
