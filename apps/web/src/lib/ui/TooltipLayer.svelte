<script lang="ts">
    /** One tooltip for the whole page, in one fixed shape: name, shortcut, at most one short clause. A control opts in
     *  with `tip()`'s attributes. The first tooltip waits a moment; moving between controls swaps at once. */
    interface Shown {
        name: string;
        kbd: string | undefined;
        hint: string | undefined;
        left: number;
        top: number;
        translate: string;
    }
    let shown = $state<Shown | null>(null);
    let el = $state<HTMLDivElement | null>(null);
    let timer = 0;
    let current: Element | null = null;

    function place(target: HTMLElement): void {
        const r = target.getBoundingClientRect();
        const where = target.dataset['tipPlace'] ?? 'below';
        const cx = Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8);
        const base = { name: target.dataset['tip'] ?? '', kbd: target.dataset['kbd'], hint: target.dataset['hint'] };
        if (where === 'right') shown = { ...base, left: r.right + 8, top: r.top + r.height / 2, translate: '0 -50%' };
        else if (where === 'above') shown = { ...base, left: cx, top: r.top - 8, translate: '-50% -100%' };
        else shown = { ...base, left: cx, top: r.bottom + 8, translate: '-50% 0' };
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
        if (shown) place(target);
        else timer = window.setTimeout(() => place(target), 450);
    }
    function focus(e: FocusEvent): void {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const target = t.closest<HTMLElement>('[data-tip]');
        if (target && t.matches(':focus-visible')) {
            current = target;
            place(target);
        }
    }
    function hide(): void {
        clearTimeout(timer);
        current = null;
        shown = null;
    }

    // Keep the tip inside the window once it has a size.
    $effect(() => {
        if (!el || !shown) return;
        el.style.marginLeft = '';
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) el.style.marginLeft = `${window.innerWidth - 8 - r.right}px`;
        else if (r.left < 8) el.style.marginLeft = `${8 - r.left}px`;
    });
</script>

<svelte:document onmouseover={over} onfocusin={focus} onfocusout={hide} onmousedowncapture={hide} onkeydowncapture={hide} />

{#if shown}
    <div bind:this={el} class="tip" role="tooltip" style:left="{shown.left}px" style:top="{shown.top}px" style:translate={shown.translate}>
        <div class="tip-row">
            <span class="tip-name">{shown.name}</span>
            {#if shown.kbd}<kbd class="tip-kbd">{shown.kbd}</kbd>{/if}
        </div>
        {#if shown.hint}<div class="tip-hint">{shown.hint}</div>{/if}
    </div>
{/if}
