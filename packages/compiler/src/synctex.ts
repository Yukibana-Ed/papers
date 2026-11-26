import { gunzipSync } from 'node:zlib';

/** A minimal SyncTeX reader for the local tools (forward: line → boxes, inverse: point → line). The browser has its
 *  own reader in the content frame; both follow the format's rule that coordinates are absolute scaled points from
 *  the page's top-left corner (65,781.76 sp per PDF point). */

interface SyncRecord {
    readonly kind: string;
    readonly page: number;
    readonly tag: number;
    readonly line: number;
    /** In PDF points from the page's top-left corner. */
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly d: number;
}

export interface SyncTex {
    /** Input tag → the file's path as the engine wrote it. */
    readonly inputs: ReadonlyMap<number, string>;
    readonly records: readonly SyncRecord[];
}

/** A box on a page, in PDF points from the top-left corner. */
export interface SyncBox {
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** The SyncTeX data in `data`: the `.synctex.gz` bytes, or the uncompressed text. */
export function parseSynctex(data: Uint8Array | string): SyncTex {
    const text = typeof data === 'string' ? data : data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data).toString('utf8') : Buffer.from(data).toString('utf8');
    const inputs = new Map<number, string>();
    const raw: Omit<SyncRecord, 'x' | 'y' | 'w' | 'h' | 'd'>[] = [];
    const nums: number[][] = [];
    let unit = 1;
    let mag = 1000;
    let xoff = 0;
    let yoff = 0;
    let page = 0;
    for (const line of text.split('\n')) {
        if (!line) continue;
        if (line.startsWith('Input:')) {
            const i = line.indexOf(':', 6);
            inputs.set(Number(line.slice(6, i)), line.slice(i + 1));
        } else if (line.startsWith('Unit:')) unit = Number(line.slice(5));
        else if (line.startsWith('X Offset:')) xoff = Number(line.slice(9));
        else if (line.startsWith('Y Offset:')) yoff = Number(line.slice(9));
        else if (line.startsWith('Magnification:')) mag = Number(line.slice(14));
        else if (line[0] === '{') page = Number(line.slice(1));
        else if ('[(hxkg$v'.includes(line[0] ?? '')) {
            const m = /^.(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(line);
            if (!m) continue;
            raw.push({ kind: line[0] ?? '', page, tag: Number(m[1]), line: Number(m[2]) });
            nums.push([Number(m[3]), Number(m[4]), Number(m[5] ?? 0), Number(m[6] ?? 0), Number(m[7] ?? 0)]);
        }
    }
    const k = (unit / 65781.76) * (mag / 1000);
    const records: SyncRecord[] = [];
    raw.forEach((r, i) => {
        const [x = 0, y = 0, w = 0, h = 0, d = 0] = nums[i] ?? [];
        records.push({ kind: r.kind, page: r.page, tag: r.tag, line: r.line, x: (x + xoff) * k, y: (y + yoff) * k, w: w * k, h: h * k, d: d * k });
    });
    return { inputs, records };
}

/** The tag of the input whose path ends with `file` (a project path), or null. */
function tagOf(sync: SyncTex, file: string): number | null {
    const want = file.replace(/\\/g, '/');
    for (const [tag, path] of sync.inputs) {
        const p = path.replace(/\\/g, '/').replace(/\/\.\//g, '/');
        if (p === want || p.endsWith(`/${want}`) || p === `./${want}`) return tag;
    }
    return null;
}

/** The boxes that `line` of `file` produced, horizontal boxes first; empty when it produced none. */
export function forwardSearch(sync: SyncTex, file: string, line: number): SyncBox[] {
    const tag = tagOf(sync, file);
    if (tag === null) return [];
    let hits = sync.records.filter(r => r.tag === tag && r.line === line && (r.kind === '(' || r.kind === 'h' || r.kind === 'x'));
    if (!hits.length) hits = sync.records.filter(r => r.tag === tag && r.line === line);
    return hits.map(r => ({ page: r.page, x: r.x, y: r.y - r.h, width: r.w, height: r.h + r.d }));
}

/** The source line under the point (`x`, `y` in PDF points from the top-left corner of `page`): the last position
 *  record on the text line under the point, else the smallest box around it, else the nearest record. Null for a
 *  page with no records. `file` is the path as the engine wrote it. */
export function inverseSearch(sync: SyncTex, page: number, x: number, y: number): { file: string; line: number } | null {
    const at = (r: SyncRecord): { file: string; line: number } => ({ file: sync.inputs.get(r.tag) ?? '', line: r.line });
    let pos: SyncRecord | null = null;
    for (const r of sync.records) {
        if (r.page !== page || !'xkg$'.includes(r.kind)) continue;
        if (r.y < y - 1 || r.y > y + 9 || r.x > x + 1) continue;
        if (!pos || r.y < pos.y - 0.5 || (Math.abs(r.y - pos.y) <= 0.5 && r.x > pos.x)) pos = r;
    }
    if (pos) return at(pos);
    let best: { area: number; r: SyncRecord } | null = null;
    for (const r of sync.records) {
        if (r.page !== page || (r.kind !== '(' && r.kind !== '[' && r.kind !== 'h')) continue;
        if (x >= r.x && x <= r.x + r.w && y >= r.y - r.h && y <= r.y + r.d) {
            const area = r.w * (r.h + r.d);
            if (!best || area < best.area) best = { area, r };
        }
    }
    if (best) return at(best.r);
    let near: { dist: number; r: SyncRecord } | null = null;
    for (const r of sync.records) {
        if (r.page !== page) continue;
        const dist = Math.abs(r.y - y) * 4 + Math.abs(r.x - x);
        if (!near || dist < near.dist) near = { dist, r };
    }
    return near ? at(near.r) : null;
}
