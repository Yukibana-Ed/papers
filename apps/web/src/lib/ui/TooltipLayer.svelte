<script lang="ts">
    import { place, type Rect, type Side } from './place.ts';

    /** One tooltip for the whole page, in one fixed shape: name, shortcut, at most one short clause. A control opts in
     *  with `tip()`'s attributes. The first tooltip waits a moment; moving between controls swaps at once.
     *
     *  The tip lives in the top layer (a manual popover), so no ancestor's overflow or stacking can clip it, and it is
     *  placed against the viewport once it has a size: on the preferred side if there is room, else flipped, and
     *  shifted along that side to stay inside (a control at the bottom of the page gets its tip above). */
    interface Shown {
        name: string;
        kbd: string | undefined;
        hint: string | undefined;
        anchor: Rect;
        prefer: Side;
    }
    let shown = $state<Shown | null>(null);
    let el = $state<HTMLDivElement | null>(null);
    let timer = 0;
    let current: Element | null = null;

    function show(target: HTMLElement): void {
        const r = target.getBoundingClientRect();
        const where = target.dataset['tipPlace'];
        const prefer: Side = where === 'right' || where === 'above' || where === 'left' ? where : 'below';
        shown = { name: target.dataset['tip'] ?? '', kbd: target.dataset['kbd'], hint: target.dataset['hint'], anchor: { left: r.left, top: r.top, width: r.width, height: r.height }, prefer };
    }

    function over(e: MouseEvent): void {
        const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null;
        if (target === current) return;
        current = target;
        clearTimeout(timer);
        if (!target) {
            shown = null;
            return;
        }
        if (shown) show(target);
        else timer = window.setTimeout(() => show(target), 450);
    }
    function focus(e: FocusEvent): void {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const target = t.closest<HTMLElement>('[data-tip]');
        if (target && t.matches(':focus-visible')) {
            current = target;
            show(target);
        }
    }
    function hide(): void {
        clearTimeout(timer);
        current = null;
        shown = null;
    }

    // Into the top layer, then placed once it has a size.
    $effect(() => {
        const s = shown;
        if (!el || !s) return;
        if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) el.showPopover();
        const r = el.getBoundingClientRect();
        const p = place(s.anchor, { width: r.width, height: r.height }, s.prefer, window.innerWidth, window.innerHeight);
        el.style.left = `${p.left}px`;
        el.style.top = `${p.top}px`;
        el.dataset['side'] = p.side;
        el.style.visibility = 'visible';
    });
</script>

<svelte:document onmouseover={over} onfocusin={focus} onfocusout={hide} onmousedowncapture={hide} onkeydowncapture={hide} />

{#if shown}
    <div bind:this={el} class="tip" role="tooltip" popover="manual" style:visibility="hidden">
        <div class="tip-row">
            <span class="tip-name">{shown.name}</span>
            {#if shown.kbd}<kbd class="tip-kbd">{shown.kbd}</kbd>{/if}
        </div>
        {#if shown.hint}<div class="tip-hint">{shown.hint}</div>{/if}
    </div>
{/if}
