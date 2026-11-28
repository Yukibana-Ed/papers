import type { FileContents } from '@yukibana/papers-frame-protocol';

/** What the frame sends the worker that keeps a LaTeX document built (latex-worker.ts). */
export type ToLatexWorker =
    /** The project is now what it was with `changes` applied (`contents` null: the file is gone), and `root` is the
     *  document: build it. Replaces any build still running. */
    | { readonly type: 'build'; readonly id: number; readonly changes: readonly (readonly [path: string, contents: FileContents | null])[]; readonly root: string }
    /** Stop working on the current build: another one is about to be asked for. */
    | { readonly type: 'stop' };

/** What the worker sends back. */
export type FromLatexWorker =
    /** The engine, the format and TeX Live's file database are loaded. */
    | { readonly type: 'ready'; readonly ms: number }
    /** They could not be loaded: the worker builds nothing. */
    | { readonly type: 'unavailable'; readonly detail: string }
    /** A pass of build `id` finished. `settled`: no further pass follows. */
    | {
          readonly type: 'pass';
          readonly id: number;
          readonly ok: boolean;
          readonly pdf: Uint8Array | null;
          /** The SyncTeX of `pdf`, as text. */
          readonly synctex: string | null;
          readonly log: string;
          readonly pass: number;
          readonly settled: boolean;
          readonly ms: number;
      }
    /** Build `id` ended without a pass finishing: a file of TeX Live could not be fetched, or the engine broke. */
    | { readonly type: 'failed'; readonly id: number; readonly message: string };
