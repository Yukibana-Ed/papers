/** The engine module's memory, and copies of it that share what they have in common.
 *
 *  A memory image is a table of 4 KiB pages. Two images of the same run differ in the pages the run wrote between
 *  them, so an image holds references to the pages of the image before it wherever nothing changed: taking one costs
 *  the pages that changed, and putting one back writes only the pages that differ from what the memory holds.
 *
 *  Which pages a run wrote is known from the module itself: the build rewrites it so that every write first sets a
 *  byte in a table (`inc_dirty`, one byte per page; `src/dirty.mjs` of the pdftex-wasm package). A mark on page p
 *  stands for p and p + 1, since a write of a few bytes may reach into the next page. */

/** Bytes of a page: the unit of sharing between images. */
export const PAGE = 4096;
const WORDS = PAGE / 4;
const WASM_PAGE = 65536;
/** Pages of a chunk: an image is a list of chunks, so that images also share the tables of what did not change. */
const CHUNK = 256;
/** Bytes of the module's write-tracking table: a page of 4 KiB per byte, for a memory of at most 1 GiB. */
const TABLE = 1 << 18;

type Page = Uint32Array;
type Chunk = readonly Page[];
const ZERO: Page = new Uint32Array(WORDS);
const ZERO_CHUNK: Chunk = Array.from({ length: CHUNK }, () => ZERO);

/** A copy of the module's memory. Immutable. */
export interface MemoryImage {
    /** The pages, `CHUNK` to a chunk; a page of zeros is the one shared zero page. */
    readonly chunks: readonly Chunk[];
    /** Bytes: a multiple of the WebAssembly page size. */
    readonly size: number;
}

/** What a module of the pdftex-wasm package exports (its src/host.c and src/inc.c). Only pdfTeX can pause: a program
 *  that runs from start to end has no `inc_resume` and `inc_finish`. */
export interface EngineExports {
    readonly memory: WebAssembly.Memory;
    readonly _initialize: () => void;
    readonly inc_main: (argc: number, argv: number) => number;
    readonly inc_resume?: () => number;
    readonly inc_finish?: () => void;
    readonly inc_alloc: (bytes: number) => number;
    readonly inc_dirty: WebAssembly.Global<'i32'>;
    readonly emscripten_stack_get_current: () => number;
    readonly _emscripten_stack_restore: (sp: number) => void;
}

/** The functions a module imports, by import module and name. */
export type HostImports = Readonly<Record<string, Readonly<Record<string, (...args: never[]) => unknown>>>>;

/** Counters of a machine, for measurements. */
export interface MachineStats {
    captures: number;
    captureMs: number;
    restores: number;
    restoreMs: number;
    /** Pages copied out of the memory by captures. */
    pagesCopied: number;
    /** Pages written into the memory by restores. */
    pagesRestored: number;
}

function isExports(x: WebAssembly.Exports): x is WebAssembly.Exports & EngineExports {
    return x['memory'] instanceof WebAssembly.Memory && x['inc_dirty'] instanceof WebAssembly.Global && typeof x['inc_main'] === 'function';
}

/** One instance of the engine module, whose memory can be captured and put back.
 *
 *  Runs take turns on a machine: whoever calls `start` or `restore` owns it until the next such call. */
export class Machine {
    readonly stats: MachineStats = { captures: 0, captureMs: 0, restores: 0, restoreMs: 0, pagesCopied: 0, pagesRestored: 0 };
    readonly #module: WebAssembly.Module;
    readonly #verify: boolean;
    #owner: unknown = null;
    #host: HostImports | null = null;
    #exports: EngineExports | null = null;
    /** The image the memory equals, except in the pages marked written since. */
    #base: Chunk[] = [];
    /** The chunks of `#base` that no image refers to yet, and so may be changed in place, by their index. */
    #own = new Map<number, Page[]>();
    /** Whether the marks are not to be trusted: after a module started, before its first capture. */
    #all = true;
    #sp = 0;
    #table = 0;

    /** A machine for `module`, the engine with write tracking. With `verify`, every capture and restore also checks
     *  the whole memory against what the marks say, which finds a write the module did not mark (slow: for tests). */
    constructor(module: WebAssembly.Module, options: { readonly verify?: boolean } = {}) {
        this.#module = module;
        this.#verify = options.verify ?? false;
    }

    /** Who called `start` or `restore` last. */
    get owner(): unknown {
        return this.#owner;
    }

    /** The module's exports. Precondition: `start` or `restore` was called. */
    get exports(): EngineExports {
        if (this.#exports === null) throw new Error('the machine has not started');
        return this.#exports;
    }

    /** The module's memory as bytes. The view is invalid once the memory grows, which a call into the module may do. */
    bytes(): Uint8Array {
        return new Uint8Array(this.exports.memory.buffer);
    }

    #instantiate(): EngineExports {
        const imports: Record<string, Record<string, (...args: never[]) => unknown>> = {};
        for (const i of WebAssembly.Module.imports(this.#module)) {
            if (i.kind !== 'function') throw new Error(`the module imports a ${i.kind}`);
            (imports[i.module] ??= {})[i.name] = (...args: never[]): unknown => {
                const f = this.#host?.[i.module]?.[i.name];
                if (f === undefined) throw new Error(`the module called ${i.module}.${i.name}, which the host does not have`);
                return f(...args);
            };
        }
        const x = new WebAssembly.Instance(this.#module, imports).exports;
        if (!isExports(x)) throw new Error('not the engine module');
        this.#exports = x;
        this.#base = [];
        this.#own = new Map();
        this.#all = true;
        // The module's start-up already calls the host, which marks what it writes: the table is found first.
        this.#table = x.inc_dirty.value;
        if (this.#table === 0 || this.#table % PAGE !== 0) throw new Error('the write-tracking table is not on a page boundary');
        x._initialize();
        this.#sp = x.emscripten_stack_get_current();
        return x;
    }

    /** Makes the memory a new module's, for a run from its start, with `host` answering its imports. */
    start(owner: unknown, host: HostImports): void {
        this.#owner = owner;
        this.#host = host;
        this.#instantiate();
    }

    /** Notes that the host wrote `length` bytes at `address`. */
    mark(address: number, length: number): void {
        if (length <= 0) return;
        const table = new Uint8Array(this.exports.memory.buffer, this.#table, TABLE);
        for (let p = address >>> 12, e = (address + length - 1) >>> 12; p <= e; p++) table[p] = 1;
    }

    /** Whether page `p` belongs to the write-tracking table, which is no part of an image. */
    #tracking(p: number): boolean {
        const t = this.#table / PAGE;
        return p >= t && p < t + TABLE / PAGE;
    }

    /** The pages below `pages` that may differ from `#base`, ascending, and clears the marks. */
    #written(pages: number): number[] {
        const buffer = this.exports.memory.buffer;
        const out: number[] = [];
        if (this.#all) {
            for (let p = 0; p < pages; p++) if (!this.#tracking(p)) out.push(p);
        } else {
            const table = new Uint8Array(buffer, this.#table, TABLE);
            const words = new Uint32Array(buffer, this.#table, (pages + 3) >> 2);
            let last = -1;
            for (let i = 0; i < words.length; i++) {
                if (words[i] === 0) continue;
                for (let p = i * 4; p < i * 4 + 4; p++) {
                    if (table[p] === 0) continue;
                    if (p > last && !this.#tracking(p)) out.push(p);
                    if (p + 1 < pages && !this.#tracking(p + 1)) out.push(p + 1);
                    last = p + 1;
                }
            }
        }
        new Uint8Array(buffer, this.#table, TABLE).fill(0);
        this.#all = false;
        return out;
    }

    #basePage(p: number): Page {
        return this.#base[(p / CHUNK) | 0]?.[p % CHUNK] ?? ZERO;
    }

    #setBasePage(p: number, page: Page): void {
        const c = (p / CHUNK) | 0;
        while (this.#base.length <= c) this.#base.push(ZERO_CHUNK);
        let chunk = this.#own.get(c);
        if (chunk === undefined) {
            chunk = (this.#base[c] ?? ZERO_CHUNK).slice();
            this.#base[c] = chunk;
            this.#own.set(c, chunk);
        }
        chunk[p % CHUNK] = page;
    }

    /** With `verify`: throws unless the memory equals `#base` everywhere outside the tracking table. */
    #check(what: string): void {
        if (!this.#verify) return;
        const memory = new Uint32Array(this.exports.memory.buffer);
        for (let p = 0; p < memory.length / WORDS; p++) {
            if (!this.#tracking(p) && !same(memory, p, this.#basePage(p))) throw new Error(`${what}: page ${p} was written without a mark`);
        }
    }

    /** The memory as an image. Costs the pages written since the last capture or restore. */
    capture(): MemoryImage {
        const t0 = performance.now();
        const memory = new Uint32Array(this.exports.memory.buffer);
        const size = memory.byteLength;
        for (const p of this.#written(size / PAGE)) {
            if (same(memory, p, this.#basePage(p))) continue;
            this.#setBasePage(p, zero(memory, p) ? ZERO : memory.slice(p * WORDS, (p + 1) * WORDS));
            this.stats.pagesCopied++;
        }
        while (this.#base.length < size / PAGE / CHUNK) this.#base.push(ZERO_CHUNK);
        this.#own.clear();
        this.stats.captures++;
        this.stats.captureMs += performance.now() - t0;
        this.#check('capture');
        return { chunks: this.#base.slice(), size };
    }

    /** Makes the memory equal to `image`, with `host` answering the module's imports from now on. Pages the memory has
     *  beyond the image's size become zero, as they are in a memory that has just grown. */
    restore(owner: unknown, host: HostImports, image: MemoryImage): void {
        const t0 = performance.now();
        this.#owner = owner;
        this.#host = host;
        const x = this.#exports ?? this.#instantiate();
        if (x.memory.buffer.byteLength < image.size) x.memory.grow((image.size - x.memory.buffer.byteLength) / WASM_PAGE);
        const memory = new Uint32Array(x.memory.buffer);
        const pages = memory.length / WORDS;
        const want = (p: number): Page => image.chunks[(p / CHUNK) | 0]?.[p % CHUNK] ?? ZERO;
        const put = (p: number): void => {
            memory.set(want(p), p * WORDS);
            this.stats.pagesRestored++;
        };
        // What ran since the last capture or restore is undone, and what the two images do not share is written.
        const written = this.#written(pages);
        for (const p of written) put(p);
        for (let c = 0; c < pages / CHUNK; c++) {
            const have = this.#base[c] ?? ZERO_CHUNK;
            const chunk = image.chunks[c] ?? ZERO_CHUNK;
            if (have === chunk) continue;
            for (let i = 0; i < CHUNK; i++) if (have[i] !== chunk[i] && !this.#tracking(c * CHUNK + i)) put(c * CHUNK + i);
        }
        this.#base = image.chunks.slice();
        while (this.#base.length < pages / CHUNK) this.#base.push(ZERO_CHUNK);
        this.#own.clear();
        x._emscripten_stack_restore(this.#sp);
        this.stats.restores++;
        this.stats.restoreMs += performance.now() - t0;
        this.#check('restore');
    }
}

function same(memory: Uint32Array, p: number, page: Page): boolean {
    const at = p * WORDS;
    for (let i = 0; i < WORDS; i++) if (memory[at + i] !== page[i]) return false;
    return true;
}

function zero(memory: Uint32Array, p: number): boolean {
    const at = p * WORDS;
    for (let i = 0; i < WORDS; i++) if (memory[at + i] !== 0) return false;
    return true;
}

/** Bytes held by `images` together, counting a page they share once. */
export function heldBytes(images: Iterable<MemoryImage>): number {
    const seen = new Set<Page>();
    const chunks = new Set<Chunk>();
    for (const image of images) {
        for (const chunk of image.chunks) {
            if (chunk === ZERO_CHUNK || chunks.has(chunk)) continue;
            chunks.add(chunk);
            for (const page of chunk) if (page !== ZERO) seen.add(page);
        }
    }
    return seen.size * PAGE + chunks.size * CHUNK * 8;
}
