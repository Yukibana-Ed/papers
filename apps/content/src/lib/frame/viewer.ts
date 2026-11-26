import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentLoadingTask, type PDFPageProxy } from 'pdfjs-dist';
// Vite's `?url` import: the worker's own URL, emitted as an asset. The import plugin cannot see Vite's default export.
// oxlint-disable-next-line import/default
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PreviewMark, PreviewPresence, SourceLines, SourcePoint } from '@yukibana/papers-frame-protocol';
import { mergeLineRects, type Rect } from '#lib/rects.ts';
import type { PageText, SourceMap } from '#lib/sourcemap.ts';
import type { PageBox } from '@yukibana/papers-tex';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Space left of and right of the pages, in CSS pixels, together: room for the locator bar and the presence dots. */
const GUTTER = 76;
/** Fitting never scales a page beyond this, so a wide pane does not blow a page up. */
const MAX_FIT = 1.6;

/** What the viewer tells the frame. */
export interface ViewerEvents {
    readonly scale: (scale: number) => void;
    /** A click without a selection, at a source position; `word` is the word under the pointer. */
    readonly jump: (at: SourcePoint, word: string | null) => void;
    /** The selection changed. `anchor` is where its toolbar goes, in the scroller's content coordinates (top centre of
     *  the selection's first line); null with `lines` null when nothing is selected. */
    readonly selection: (lines: SourceLines | null, text: string, anchor: { x: number; y: number } | null) => void;
}

interface PageView {
    readonly el: HTMLDivElement;
    readonly marks: HTMLDivElement;
    readonly sel: HTMLDivElement;
    readonly decor: HTMLDivElement;
    canvas: HTMLCanvasElement;
    text: HTMLDivElement;
    proxy: PDFPageProxy;
    /** Size at scale 1, in PDF points (CSS pixels at 100%). */
    width: number;
    height: number;
    /** The scale the canvas was last drawn at, or 0 when it shows an older build. */
    drawn: number;
    rendering: Promise<void> | null;
}

/** Draws a PDF's pages in a scroller, with PDF.js's text layer for selecting and copying, and the overlays that tie
 *  the pages to the source through SyncTeX: comment and selection highlights, the cursor's locator bar, a flash, and the
 *  others' presence dots.
 *
 *  Pages fit the scroller's width (minus a gutter, at most `MAX_FIT`), times the user's zoom. Only pages near the view
 *  are drawn; the rest keep their size and draw when they scroll in. A new build replaces the canvases of visible pages
 *  in place once drawn, so the view neither flickers nor jumps. */
export class Viewer {
    readonly #scroller: HTMLElement;
    readonly #column: HTMLDivElement;
    readonly #events: ViewerEvents;
    /** The shown build's loading task, which owns its document. */
    #task: PDFDocumentLoadingTask | null = null;
    #sync: SourceMap | null = null;
    #pages: PageView[] = [];
    #zoom = 1;
    #fit = 1;
    #resize: ResizeObserver;
    #marks: readonly PreviewMark[] = [];
    #mirror: SourceLines | null = null;
    #presence: readonly PreviewPresence[] = [];
    #cursor: SourcePoint | null = null;
    #renderTimer = 0;
    #selFrame = 0;
    #pointerDown: { x: number; y: number } | null = null;

    constructor(scroller: HTMLElement, events: ViewerEvents) {
        this.#scroller = scroller;
        this.#events = events;
        this.#column = document.createElement('div');
        this.#column.className = 'pv-pages';
        scroller.append(this.#column);
        // Visibility by geometry on scroll, not an IntersectionObserver: an observer does not report while the frame's
        // page is hidden (a background tab), which left a new build undrawn until the next scroll.
        scroller.addEventListener('scroll', () => this.#scheduleRender(40), { passive: true });
        this.#resize = new ResizeObserver(() => this.#relayout());
        this.#resize.observe(scroller);
        scroller.addEventListener('pointerdown', this.#onPointerDown);
        scroller.addEventListener('click', this.#onClick);
        document.addEventListener('selectionchange', this.#onSelectionChange);
    }

    /** Replaces the source map of the shown build (a Typst build's, made from the text layer after `show`). */
    setSourceMap(map: SourceMap | null): void {
        this.#sync = map;
        this.#drawOverlays();
    }

    /** The text runs of every page of the shown build, in PDF points from each page's top-left, reading order. */
    async pageTexts(): Promise<PageText[]> {
        const out: PageText[] = [];
        for (const [i, p] of this.#pages.entries()) {
            const content = await p.proxy.getTextContent();
            for (const item of content.items) {
                if (!('str' in item) || !item.str) continue;
                const transform: unknown[] = item.transform;
                const e = Number(transform[4] ?? 0);
                const f = Number(transform[5] ?? 0);
                out.push({ page: i + 1, str: item.str, x: e, y: p.height - f, width: item.width, height: item.height });
            }
        }
        return out;
    }

    get pageCount(): number {
        return this.#pages.length;
    }

    get scale(): number {
        return this.#fit * this.#zoom;
    }

    /** Shows a new build. Precondition: `pdf` is a complete PDF. Resolves once the new pages are laid out
     *  and SyncTeX is in use; the pages in view draw after that. */
    async show(pdf: Uint8Array, sync: SourceMap | null): Promise<void> {
        const task = getDocument({ data: pdf.slice() });
        const doc = await task.promise;
        const proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
        const old = this.#task;
        this.#task = task;
        this.#sync = sync;
        // Reuse the page elements that exist; add or remove the difference.
        while (this.#pages.length > proxies.length) {
            const gone = this.#pages.pop();
            if (gone === undefined) break;
            gone.el.remove();
        }
        proxies.forEach((proxy, i) => {
            const vp = proxy.getViewport({ scale: 1 });
            const existing = this.#pages[i];
            if (existing !== undefined) {
                existing.proxy = proxy;
                existing.width = vp.width;
                existing.height = vp.height;
                existing.drawn = 0;
                return;
            }
            const view = this.#createPage(proxy, vp.width, vp.height, i + 1);
            this.#pages.push(view);
            this.#column.append(view.el);
        });
        this.#relayout();
        this.#drawOverlays();
        // Not awaited: PDF.js draws in animation frames, which a hidden page does not get, and the build's result must
        // not wait for the page to be seen. The old document goes once the new pages are drawn.
        void this.#renderVisible().then(() => old?.destroy());
    }

    #createPage(proxy: PDFPageProxy, width: number, height: number, n: number): PageView {
        const el = document.createElement('div');
        el.className = 'pv-page';
        el.dataset['page'] = String(n);
        const canvas = document.createElement('canvas');
        const marks = document.createElement('div');
        marks.className = 'pv-layer pv-marks';
        const sel = document.createElement('div');
        sel.className = 'pv-layer pv-sel';
        const text = document.createElement('div');
        text.className = 'textLayer';
        const decor = document.createElement('div');
        decor.className = 'pv-decor';
        el.append(canvas, marks, sel, text, decor);
        return { el, canvas, marks, sel, text, decor, proxy, width, height, drawn: 0, rendering: null };
    }

    /** The user's zoom on top of fitting the width, clamped to 0.5–2. */
    setZoom(zoom: number): void {
        this.#zoom = Math.min(2, Math.max(0.5, zoom));
        this.#relayout();
    }

    #relayout(): void {
        const first = this.#pages[0];
        const avail = Math.max(100, this.#scroller.clientWidth - GUTTER);
        const fit = first === undefined ? 1 : Math.min(MAX_FIT, avail / first.width);
        const before = this.scale;
        // The point in the middle of the view, as a fraction of the content, kept in the middle across the change.
        const scrollable = this.#scroller.scrollHeight > this.#scroller.clientHeight + 1;
        const anchor = scrollable ? (this.#scroller.scrollTop + this.#scroller.clientHeight / 2) / this.#scroller.scrollHeight : null;
        this.#fit = fit;
        const s = this.scale;
        for (const p of this.#pages) {
            p.el.style.width = `${p.width * s}px`;
            p.el.style.height = `${p.height * s}px`;
            p.el.style.setProperty('--scale-factor', String(s));
            p.el.style.setProperty('--total-scale-factor', String(s));
        }
        if (Math.abs(before - s) > 1e-6) {
            if (anchor !== null) this.#scroller.scrollTop = anchor * this.#scroller.scrollHeight - this.#scroller.clientHeight / 2;
            this.#events.scale(s);
            this.#drawOverlays();
            // The text layers are about to be redrawn at the new scale, which would leave the selection pointing into
            // removed nodes: it goes, as it does in a PDF viewer when zooming.
            if (this.#hasSelection()) window.getSelection()?.removeAllRanges();
        }
        this.#scheduleRender(120);
    }

    #scheduleRender(delay: number): void {
        clearTimeout(this.#renderTimer);
        this.#renderTimer = window.setTimeout(() => void this.#renderVisible(), delay);
    }

    async #renderVisible(): Promise<void> {
        const s = this.scale;
        // The pages within one view's height above or below the view.
        const top = this.#scroller.scrollTop - this.#scroller.clientHeight;
        const bottom = this.#scroller.scrollTop + this.#scroller.clientHeight * 2;
        const todo = this.#pages.filter(p => p.drawn !== s && p.el.offsetTop < bottom && p.el.offsetTop + p.el.offsetHeight > top);
        await Promise.all(todo.map(p => this.#render(p, s)));
    }

    /** Draws `view` at `scale` into a fresh canvas and text layer, then swaps them in. */
    #render(view: PageView, scale: number): Promise<void> {
        const run = (async (): Promise<void> => {
            await view.rendering?.catch(() => undefined);
            if (view.drawn === scale) return;
            const proxy = view.proxy;
            const vp = proxy.getViewport({ scale });
            const dpr = window.devicePixelRatio || 1;
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(vp.width * dpr);
            canvas.height = Math.floor(vp.height * dpr);
            await proxy.render({ canvas, viewport: vp, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
            const text = document.createElement('div');
            text.className = 'textLayer';
            const layer = new TextLayer({ textContentSource: await proxy.getTextContent(), container: text, viewport: vp });
            await layer.render();
            const end = document.createElement('div');
            end.className = 'endOfContent';
            text.append(end);
            // A newer build may have replaced the page meanwhile; it draws itself.
            if (view.proxy !== proxy) return;
            view.canvas.replaceWith(canvas);
            view.canvas = canvas;
            const selecting = view.text.classList.contains('selecting');
            view.text.replaceWith(text);
            view.text = text;
            if (selecting) text.classList.add('selecting');
            view.drawn = scale;
        })();
        view.rendering = run;
        return run.catch(() => undefined);
    }

    // --- overlays ------------------------------------------------------------------------------------------------------

    setMarks(marks: readonly PreviewMark[]): void {
        this.#marks = marks;
        this.#drawOverlays();
    }

    setMirror(lines: SourceLines | null): void {
        this.#mirror = lines;
        this.#drawOverlays();
    }

    setPresence(presence: readonly PreviewPresence[]): void {
        this.#presence = presence;
        this.#drawOverlays();
    }

    /** The boxes of a range of source lines, merged per typeset line, grouped by page number. */
    #linesBoxes(lines: SourceLines): Map<number, Rect[]> {
        const out = new Map<number, Rect[]>();
        if (this.#sync === null) return out;
        const first = Math.min(lines.startLine, lines.endLine);
        const last = Math.min(Math.max(lines.startLine, lines.endLine), first + 400);
        for (let l = first; l <= last; l++) {
            for (const b of this.#sync.segments(lines.file, l, first === last)) {
                const list = out.get(b.page) ?? [];
                list.push(b);
                out.set(b.page, list);
            }
        }
        for (const [page, rects] of out) out.set(page, mergeLineRects(rects));
        return out;
    }

    #drawOverlays(): void {
        for (const p of this.#pages) {
            p.marks.replaceChildren();
            p.decor.replaceChildren();
        }
        const s = this.scale;
        const paint = (lines: SourceLines, cls: string): void => {
            for (const [n, rects] of this.#linesBoxes(lines)) {
                const page = this.#pages[n - 1];
                if (page === undefined) continue;
                for (const r of rects) page.marks.append(box(r, s, `pv-hl ${cls}`, 1.5));
            }
        };
        for (const m of this.#marks) paint(m, `pv-hl-${m.kind}`);
        if (this.#mirror !== null) paint(this.#mirror, 'pv-hl-mirror');
        if (this.#cursor !== null) {
            const at = this.#firstBox(this.#cursor);
            const page = at === null ? undefined : this.#pages[at.page - 1];
            if (at !== null && page !== undefined) {
                const bar = document.createElement('div');
                bar.className = 'pv-locator';
                bar.style.top = `${at.y * s}px`;
                bar.style.height = `${Math.max(6, at.height * s)}px`;
                page.decor.append(bar);
            }
        }
        for (const who of this.#presence) {
            const at = this.#firstBox(who);
            const page = at === null ? undefined : this.#pages[at.page - 1];
            if (at === null || page === undefined) continue;
            const dot = document.createElement('div');
            dot.className = 'pv-presence';
            dot.textContent = who.initial;
            dot.style.top = `${at.y * s + (at.height * s) / 2}px`;
            dot.style.setProperty('--hue', String(who.hue));
            dot.dataset['tip'] = who.user;
            page.decor.append(dot);
        }
    }

    #firstBox(at: SourcePoint): PageBox | null {
        if (this.#sync === null) return null;
        return this.#sync.segments(at.file, at.line)[0] ?? null;
    }

    // --- navigation ----------------------------------------------------------------------------------------------------

    /** Shows `at`. `follow` scrolls only when its line is outside the view; `jump` always brings it to a third of the
     *  view's height, and flashes it. Either way the locator bar moves there. */
    reveal(at: SourcePoint, mode: 'follow' | 'jump'): void {
        this.#cursor = at;
        this.#drawOverlays();
        const b = this.#firstBox(at);
        const page = b === null ? undefined : this.#pages[b.page - 1];
        if (b === null || page === undefined) return;
        const s = this.scale;
        const top = page.el.offsetTop + b.y * s;
        const bottom = top + b.height * s;
        const view = this.#scroller;
        const inView = top >= view.scrollTop + 24 && bottom <= view.scrollTop + view.clientHeight - 24;
        // A glide only when someone can see it: a hidden page gets no animation frames to glide in.
        const behavior = document.visibilityState === 'visible' ? 'smooth' : 'instant';
        if (mode === 'jump' || !inView) view.scrollTo({ top: top - view.clientHeight / 3, behavior });
        if (mode === 'jump' && this.#sync !== null) {
            for (const seg of this.#sync.segments(at.file, at.line)) {
                const p = this.#pages[seg.page - 1];
                if (p === undefined) continue;
                const f = box(seg, s, 'pv-flash', 3);
                p.decor.append(f);
                f.addEventListener('animationend', () => f.remove());
            }
        }
    }

    /** The source position of what is in the middle of the view. */
    centre(): SourcePoint | null {
        if (this.#sync === null) return null;
        const y = this.#scroller.scrollTop + this.#scroller.clientHeight / 2;
        // The page under the middle, or the nearest one when the middle is in the gap between two.
        const distance = (p: PageView): number => Math.max(0, p.el.offsetTop - y, y - (p.el.offsetTop + p.el.offsetHeight));
        const page = this.#pages.reduce<PageView | undefined>((best, p) => (best === undefined || distance(p) < distance(best) ? p : best), undefined);
        if (page === undefined) return null;
        const s = this.scale;
        const hit = this.#sync.backward(this.#pages.indexOf(page) + 1, page.width / 2, (y - page.el.offsetTop) / s);
        return hit === null ? null : { file: hit.file, line: hit.line };
    }

    // --- pointer and selection -----------------------------------------------------------------------------------------

    #onPointerDown = (e: PointerEvent): void => {
        this.#pointerDown = { x: e.clientX, y: e.clientY };
        const text = e.target instanceof Element ? e.target.closest('.textLayer') : null;
        if (text instanceof HTMLElement) {
            text.classList.add('selecting');
            this.#dragging = true;
            this.#prevRange = null;
            const up = (): void => {
                this.#dragging = false;
                for (const p of this.#pages) {
                    p.text.classList.remove('selecting');
                    const end = p.text.querySelector<HTMLElement>(':scope .endOfContent');
                    if (end !== null) {
                        p.text.append(end);
                        end.style.userSelect = '';
                    }
                }
                window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointerup', up);
        }
    };

    #dragging = false;
    #prevRange: Range | null = null;

    /** While dragging, keeps the text layer's end-of-content block right after the text the selection ends in, as
     *  PDF.js's own viewer does: the pointer over a gap between text runs then extends the selection to the nearest run
     *  instead of to the end of the page. */
    #followSelectionEnd = (): void => {
        if (!this.#dragging) return;
        const selection = document.getSelection();
        if (selection === null || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const prev = this.#prevRange;
        const modifyStart = prev !== null && (range.compareBoundaryPoints(Range.END_TO_END, prev) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prev) === 0);
        let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
        if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
        if (!modifyStart && range.endOffset === 0 && anchor !== null) {
            // The selection ends at the start of a run: anchor on the last run before it that has text.
            let n: Node | null = anchor;
            do {
                while (n !== null && n.previousSibling === null) n = n.parentNode;
                n = n?.previousSibling ?? null;
            } while (n !== null && n.childNodes.length === 0);
            anchor = n;
        }
        const span = anchor instanceof Element ? anchor : null;
        const layer = span?.parentElement?.closest('.textLayer') ?? null;
        const end = layer?.querySelector<HTMLElement>(':scope .endOfContent') ?? null;
        if (span !== null && end !== null && span.parentElement !== null && span !== end) {
            end.style.userSelect = 'text';
            span.parentElement.insertBefore(end, modifyStart ? span : span.nextSibling);
        }
        this.#prevRange = range.cloneRange();
    };

    #onClick = (e: MouseEvent): void => {
        const down = this.#pointerDown;
        this.#pointerDown = null;
        if (down !== null && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        const selection = window.getSelection();
        if (selection !== null && !selection.isCollapsed) return;
        const target = e.target instanceof Element ? e.target : null;
        if (this.#sync === null || target === null || target.closest('.pv-toolbar') !== null) return;
        const pageEl = target.closest('.pv-page');
        if (!(pageEl instanceof HTMLElement)) return;
        const n = Number(pageEl.dataset['page']);
        const rect = pageEl.getBoundingClientRect();
        const s = this.scale;
        const hit = this.#sync.backward(n, (e.clientX - rect.left) / s, (e.clientY - rect.top) / s);
        if (hit === null) return;
        this.#events.jump({ file: hit.file, line: hit.line }, wordAt(e.clientX, e.clientY));
    };

    #onSelectionChange = (): void => {
        this.#followSelectionEnd();
        cancelAnimationFrame(this.#selFrame);
        this.#selFrame = requestAnimationFrame(() => this.#redrawSelection());
    };

    #hasSelection(): boolean {
        const selection = window.getSelection();
        return selection !== null && !selection.isCollapsed && selection.rangeCount > 0 && this.#column.contains(selection.getRangeAt(0).commonAncestorContainer);
    }

    #redrawSelection(): void {
        for (const p of this.#pages) p.sel.replaceChildren();
        const selection = window.getSelection();
        const range = selection === null || selection.isCollapsed || selection.rangeCount === 0 ? null : selection.getRangeAt(0);
        if (range === null || !this.#column.contains(range.commonAncestorContainer)) {
            this.#events.selection(null, '', null);
            return;
        }
        const byPage = new Map<PageView, Rect[]>();
        const boxes = this.#pages.map(p => ({ p, r: p.el.getBoundingClientRect() }));
        for (const r of range.getClientRects()) {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = boxes.find(b => cx >= b.r.left && cx <= b.r.right && cy >= b.r.top && cy <= b.r.bottom);
            if (hit === undefined) continue;
            const list = byPage.get(hit.p) ?? [];
            list.push({ x: r.left - hit.r.left, y: r.top - hit.r.top, width: r.width, height: r.height });
            byPage.set(hit.p, list);
        }
        let first: { page: PageView; rect: Rect } | null = null;
        let last: { page: PageView; rect: Rect } | null = null;
        for (const p of this.#pages) {
            const rects = byPage.get(p);
            if (rects === undefined) continue;
            for (const r of mergeLineRects(rects, 1)) {
                p.sel.append(box(r, 1, 'pv-sel-rect', 0));
                first ??= { page: p, rect: r };
                last = { page: p, rect: r };
            }
        }
        if (first === null || last === null) {
            this.#events.selection(null, '', null);
            return;
        }
        const lines = this.#linesOf(first, last);
        const anchor = { x: first.page.el.offsetLeft + first.rect.x + first.rect.width / 2, y: first.page.el.offsetTop + first.rect.y };
        this.#events.selection(lines, selection?.toString() ?? '', anchor);
    }

    /** The source lines between the first and the last line of a selection, by backward search at each one's middle. */
    #linesOf(first: { page: PageView; rect: Rect }, last: { page: PageView; rect: Rect }): SourceLines | null {
        const sync = this.#sync;
        if (sync === null) return null;
        const s = this.scale;
        const at = (e: { page: PageView; rect: Rect }, edge: 'start' | 'end'): { file: string; line: number } | null =>
            sync.backward(this.#pages.indexOf(e.page) + 1, (edge === 'start' ? e.rect.x + 4 : e.rect.x + e.rect.width - 4) / s, (e.rect.y + e.rect.height * 0.7) / s);
        const a = at(first, 'start');
        const b = at(last, 'end');
        if (a === null) return null;
        if (b === null || b.file !== a.file) return { file: a.file, startLine: a.line, endLine: a.line };
        return { file: a.file, startLine: Math.min(a.line, b.line), endLine: Math.max(a.line, b.line) };
    }

    /** The current selection's source lines, if it is in the pages. */
    selectionLines(): { lines: SourceLines; text: string } | null {
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed) return null;
        const firstPage = this.#pages.find(p => p.sel.firstElementChild !== null);
        const lastPage = this.#pages.toReversed().find(p => p.sel.lastElementChild !== null);
        const rectOf = (el: Element | null): Rect | null => {
            if (!(el instanceof HTMLElement)) return null;
            return { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
        };
        const a = rectOf(firstPage?.sel.firstElementChild ?? null);
        const b = rectOf(lastPage?.sel.lastElementChild ?? null);
        if (firstPage === undefined || lastPage === undefined || a === null || b === null) return null;
        const lines = this.#linesOf({ page: firstPage, rect: a }, { page: lastPage, rect: b });
        return lines === null ? null : { lines, text: selection.toString() };
    }

    dispose(): void {
        this.#resize.disconnect();
        document.removeEventListener('selectionchange', this.#onSelectionChange);
        void this.#task?.destroy();
    }
}

/** An absolutely placed element over `r` (in page units times `scale`), grown by `pad` CSS pixels on every side. */
function box(r: Rect, scale: number, cls: string, pad: number): HTMLDivElement {
    const el = document.createElement('div');
    el.className = cls;
    el.style.left = `${r.x * scale - pad}px`;
    el.style.top = `${r.y * scale - pad}px`;
    el.style.width = `${r.width * scale + pad * 2}px`;
    el.style.height = `${r.height * scale + pad * 2}px`;
    return el;
}

/** The word (letters and digits) under a viewport point, from the text layer, or null. */
function wordAt(x: number, y: number): string | null {
    const caret = document.caretPositionFromPoint?.(x, y);
    const node = caret?.offsetNode;
    if (node === undefined || node === null || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent ?? '';
    let a = caret?.offset ?? 0;
    let b = a;
    while (a > 0 && /[\p{L}\p{N}]/u.test(text[a - 1] ?? '')) a--;
    while (b < text.length && /[\p{L}\p{N}]/u.test(text[b] ?? '')) b++;
    const w = text.slice(a, b);
    return w === '' ? null : w;
}
