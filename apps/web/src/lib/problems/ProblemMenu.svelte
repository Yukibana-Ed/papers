<script lang="ts">
    import { dialogFocus } from '#lib/ui/focus.ts';
    import { MARGIN } from '#lib/ui/place.ts';
    import type { Problem } from './model.ts';
    import { copyProblem, type MenuAt } from './row.ts';

    /** A problem's menu at a point: go to its source, or copy it. Closes itself (`onClose`) after a choice, on Escape,
     *  and when anything outside it is pressed; focus then returns to where it was. */
    let { at, onOpen, onClose }: { at: MenuAt; onOpen: (p: Problem) => void; onClose: () => void } = $props();
    let menu = $state<HTMLElement>();

    /** Shows the menu in the top layer at its point, moved back inside the viewport if it would stick out. */
    function show(el: HTMLElement): void {
        el.showPopover();
        const r = el.getBoundingClientRect();
        el.style.left = `${Math.max(MARGIN, Math.min(at.x, window.innerWidth - MARGIN - r.width))}px`;
        el.style.top = `${Math.max(MARGIN, Math.min(at.y, window.innerHeight - MARGIN - r.height))}px`;
    }

    /** Closes the menu, then does `act` with the problem it was for (read first: closing takes `at` away). */
    function choose(act: (p: Problem) => void): void {
        const p = at.problem;
        onClose();
        act(p);
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
</script>

<svelte:window
    onpointerdowncapture={(e) => {
        if (!(e.target instanceof Node && menu?.contains(e.target))) onClose();
    }}
    onkeydowncapture={onKey}
    onblur={onClose}
    onresize={onClose}
/>

<div class="ctx-menu" popover="manual" role="menu" tabindex="-1" aria-label="Problem" bind:this={menu} {@attach show} {@attach dialogFocus}>
    <button type="button" class="row-btn" role="menuitem" onclick={() => choose(onOpen)}>
        Go to source
        <span class="grow"></span>
        <span class="tip-kbd">Enter</span>
    </button>
    <div class="pop-sep"></div>
    <button type="button" class="row-btn" role="menuitem" onclick={() => choose((p) => copyProblem(p, false))}>
        Copy message
        <span class="grow"></span>
        <span class="tip-kbd">Ctrl+C</span>
    </button>
    <button type="button" class="row-btn" role="menuitem" onclick={() => choose((p) => copyProblem(p, true))}>
        Copy with location
    </button>
</div>
