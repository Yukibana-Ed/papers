/** A SyncTeX reader: enough for forward search (source line → boxes on pages) and backward search (point on a page →
 *  source line).
 *
 *  Coordinates in the file are absolute scaled points (times `Unit:`) from the page's top-left corner; this module
 *  converts them to PDF points (65,781.76 sp each), also from the top-left. Adding TeX's 1-inch origin a second time is
 *  the classic mistake: the offsets in the file already include it. */

const SP_PER_BP = 65781.76;

/** The record kinds kept: `[` vbox, `(` hbox, `h` void hbox, `x` current position, `k` kern, `g` glue, `$` math. */
export type RecordKind = '[' | '(' | 'h' | 'x' | 'k' | 'g' | '$' | 'v';

export interface SyncRecord {
    readonly kind: RecordKind;
    /** 1-based page number. */
    readonly page: number;
    /** The input's tag (`Input:<tag>:<path>`). */
    readonly tag: number;
    readonly line: number;
    /** Position in PDF points from the page's top-left; `y` is the baseline. */
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    /** The index in `records` of the box this record is in, or -1 at the top of a page. */
    readonly parent: number;
}

export interface SyncTex {
    /** Tag → the input's path as TeX opened it (e.g. `./sections/intro.tex`). */
    readonly inputs: ReadonlyMap<number, string>;
    readonly records: readonly SyncRecord[];
}

/** The result of a backward search: the source line, its file as a project path (`inputPath`), and the path exactly
 *  as the engine wrote it (absolute, or relative to the folder it ran in), for callers that resolve it themselves. */
export interface BackwardHit {
    readonly file: string;
    readonly line: number;
    readonly input: string;
}

/** A box on a page, in PDF points from the top-left. */
export interface PageBox {
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

const KINDS: readonly RecordKind[] = ['[', '(', 'h', 'x', 'k', 'g', '$', 'v'];

function isKind(c: string): c is RecordKind {
    return KINDS.some(k => k === c);
}
const RECORD = /^.(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

/** Parses an uncompressed .synctex text. Promises: records are in file order; lines it does not understand are skipped. */
export function parseSynctex(text: string): SyncTex {
    const inputs = new Map<number, string>();
    let unit = 1;
    let xoff = 0;
    let yoff = 0;
    let mag = 1000;
    let page = 0;
    const raw: { kind: RecordKind; page: number; tag: number; line: number; x: number; y: number; w: number; h: number; d: number; parent: number }[] = [];
    // The open boxes, as indices into `raw`; a box whose record did not parse is -1.
    const open: number[] = [];
    for (const line of text.split('\n')) {
        if (line === '') continue;
        if (line.startsWith('Input:')) {
            const i = line.indexOf(':', 6);
            if (i > 6) inputs.set(Number(line.slice(6, i)), line.slice(i + 1).trimEnd());
            continue;
        }
        if (line.startsWith('Unit:')) unit = Number(line.slice(5));
        else if (line.startsWith('X Offset:')) xoff = Number(line.slice(9));
        else if (line.startsWith('Y Offset:')) yoff = Number(line.slice(9));
        else if (line.startsWith('Magnification:')) mag = Number(line.slice(14));
        else if (line.startsWith('{')) {
            page = Number(line.slice(1));
            open.length = 0;
        } else if (line.startsWith(']') || line.startsWith(')')) open.pop();
        else {
            const c = line[0] ?? '';
            if (!isKind(c)) continue;
            const m = RECORD.exec(line);
            if (m === null) {
                if (c === '[' || c === '(') open.push(-1);
                continue;
            }
            raw.push({
                kind: c,
                page,
                tag: Number(m[1]),
                line: Number(m[2]),
                x: Number(m[3]),
                y: Number(m[4]),
                w: m[5] === undefined ? 0 : Number(m[5]),
                h: m[6] === undefined ? 0 : Number(m[6]),
                d: m[7] === undefined ? 0 : Number(m[7]),
                parent: open.at(-1) ?? -1,
            });
            if (c === '[' || c === '(') open.push(raw.length - 1);
        }
    }
    const k = (unit / SP_PER_BP) * (mag / 1000);
    const records = raw.map(r => ({
        kind: r.kind,
        page: r.page,
        tag: r.tag,
        line: r.line,
        x: (r.x + xoff) * k,
        y: (r.y + yoff) * k,
        width: r.w * k,
        height: r.h * k,
        depth: r.d * k,
        parent: r.parent,
    }));
    return { inputs, records };
}

/** `./a/b.tex` → `a/b.tex`; also strips a leading `/`-rooted build directory prefix ending in `/./`. */
export function inputPath(path: string): string {
    let p = path.replace(/\\/g, '/');
    const dot = p.lastIndexOf('/./');
    if (dot >= 0) p = p.slice(dot + 3);
    while (p.startsWith('./')) p = p.slice(2);
    return p;
}

/** The tag of the input whose path (after `inputPath`) is `file`, or of the one that ends in `/file`. */
function tagOf(sync: SyncTex, file: string): number | null {
    let suffix: number | null = null;
    for (const [tag, path] of sync.inputs) {
        const p = inputPath(path);
        if (p === file) return tag;
        if (suffix === null && p.endsWith('/' + file)) suffix = tag;
    }
    return suffix;
}

/** Forward search: the boxes that show `file`'s `line`, horizontal boxes preferred, in page order. Empty when SyncTeX
 *  has nothing for that line; `nearestForward` falls back to the closest line that has something. */
export function forward(sync: SyncTex, file: string, line: number): PageBox[] {
    const tag = tagOf(sync, file);
    if (tag === null) return [];
    const on = sync.records.filter(r => r.tag === tag && r.line === line);
    const boxes = on.filter(r => r.kind === '(' || r.kind === 'h');
    const points = on.filter(r => r.kind === 'x' || r.kind === 'g' || r.kind === 'k' || r.kind === '$');
    if (boxes.length > 0) return boxes.map(toBox);
    // A line with only position records (e.g. inside a paragraph) is shown as the text line around those points.
    return points.map(r => ({ page: r.page, x: r.x, y: r.y - 8, width: Math.max(r.width, 6), height: 10 }));
}

/** Forward search that never comes back empty while the file has any record: the boxes of `line`, else of the nearest
 *  line before it that has some, else after it. */
export function nearestForward(sync: SyncTex, file: string, line: number): PageBox[] {
    const exact = forward(sync, file, line);
    if (exact.length > 0) return exact;
    const tag = tagOf(sync, file);
    if (tag === null) return [];
    let before = -1;
    let after = Number.POSITIVE_INFINITY;
    for (const r of sync.records) {
        if (r.tag !== tag) continue;
        if (r.line < line && r.line > before) before = r.line;
        if (r.line > line && r.line < after) after = r.line;
    }
    if (before > 0) return forward(sync, file, before);
    if (Number.isFinite(after)) return forward(sync, file, after);
    return [];
}

function toBox(r: SyncRecord): PageBox {
    return { page: r.page, x: r.x, y: r.y - r.height, width: r.width, height: r.height + r.depth };
}

/** Backward search for the point (`x`, `y`) in PDF points from the top-left of `page`: on the text line under the point,
 *  the last kern or glue record at or left of `x` (of two at the same place, the later one in the file: the input
 *  that starts there), else the line's first one to the right of it; else the smallest box
 *  that contains the point; else the nearest record. Returns null only when the page has no records.
 *
 *  Kerns and glue carry the source line they were read on. pdfTeX gives a line's first character record (`x`) and its
 *  box the line where the paragraph ended instead, so those decide only when a line has nothing else. */
export function backward(sync: SyncTex, page: number, x: number, y: number): BackwardHit | null {
    const at = (r: SyncRecord): BackwardHit => {
        const input = sync.inputs.get(r.tag) ?? '';
        return { file: inputPath(input), line: r.line, input };
    };
    const onLine = (r: SyncRecord): boolean => r.page === page && r.y >= y - 1 && r.y <= y + 9;
    const pick = (kinds: readonly string[]): SyncRecord | null => {
        let left: SyncRecord | null = null;
        let right: SyncRecord | null = null;
        for (const r of sync.records) {
            if (!kinds.includes(r.kind) || !onLine(r)) continue;
            if (r.x <= x + 1) {
                if (left === null || r.y < left.y - 0.5 || (Math.abs(r.y - left.y) <= 0.5 && r.x >= left.x)) left = r;
            } else if (right === null || r.y < right.y - 0.5 || (Math.abs(r.y - right.y) <= 0.5 && r.x < right.x)) right = r;
        }
        return left ?? right;
    };
    const pos = pick(['k', 'g', '$']) ?? pick(['x']);
    if (pos !== null) return at(pos);
    let best: { area: number; r: SyncRecord } | null = null;
    for (const r of sync.records) {
        if (r.page !== page || !(r.kind === '(' || r.kind === '[' || r.kind === 'h')) continue;
        if (x >= r.x && x <= r.x + r.width && y >= r.y - r.height && y <= r.y + r.depth) {
            const area = r.width * (r.height + r.depth);
            if (best === null || area < best.area) best = { area, r };
        }
    }
    if (best !== null) return at(best.r);
    let near: { dist: number; r: SyncRecord } | null = null;
    for (const r of sync.records) {
        if (r.page !== page) continue;
        const dist = Math.abs(r.y - y) * 4 + Math.abs(r.x - x);
        if (near === null || dist < near.dist) near = { dist, r };
    }
    return near === null ? null : at(near.r);
}

/** The parts of typeset lines that show `file`'s `line`: for each horizontal box holding records of that line, from
 *  where the line's first record is (the box's left edge when it is the box's first record) to where the next record of
 *  another line starts (the box's right edge when there is none). That covers a source line's own words inside a
 *  paragraph, which a whole-box search cannot: one typeset line of a paragraph mixes several source lines.
 *  Falls back to `nearestForward` when no box holds such records, unless `fallback` is false (a range highlight, where a
 *  blank line must not light up its neighbour). Promises: in page, then top-to-bottom order. */
export function lineSegments(sync: SyncTex, file: string, line: number, fallback = true): PageBox[] {
    const tag = tagOf(sync, file);
    if (tag === null) return [];
    const out: PageBox[] = [];
    for (const [p, kids] of hboxChildren(sync)) {
        if (!kids.some(r => r.tag === tag && r.line === line)) continue;
        const box = sync.records[p];
        if (box === undefined) continue;
        // pdfTeX gives a line's first character record the box's line (where the paragraph ended): not a word of it.
        const sorted = kids.filter(r => !(r.kind === 'x' && r.line === box.line && box.line !== line)).toSorted((a, b) => a.x - b.x);
        let start: number | null = null;
        const close = (end: number): void => {
            if (start !== null && end > start + 0.5) out.push({ page: box.page, x: start, y: box.y - box.height, width: end - start, height: box.height + box.depth });
            start = null;
        };
        sorted.forEach((r, i) => {
            const mine = r.tag === tag && r.line === line;
            if (mine && start === null) start = i === 0 ? box.x : r.x;
            else if (!mine && start !== null) close(r.x);
        });
        close(box.x + box.width);
    }
    if (out.length === 0) return fallback ? nearestForward(sync, file, line) : forward(sync, file, line);
    return out.toSorted((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

const childrenCache = new WeakMap<SyncTex, Map<number, SyncRecord[]>>();

/** Horizontal box index → its direct children, computed once per parsed file. */
function hboxChildren(sync: SyncTex): Map<number, SyncRecord[]> {
    const cached = childrenCache.get(sync);
    if (cached !== undefined) return cached;
    const map = new Map<number, SyncRecord[]>();
    for (const r of sync.records) {
        if (r.parent < 0 || sync.records[r.parent]?.kind !== '(') continue;
        let list = map.get(r.parent);
        if (list === undefined) {
            list = [];
            map.set(r.parent, list);
        }
        list.push(r);
    }
    childrenCache.set(sync, map);
    return map;
}
