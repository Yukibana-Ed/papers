<script lang="ts">
    import '@yukibana/design/tokens.css';
    import '@yukibana/design/fonts.css';
    import '@yukibana/design/base.css';
    import './frame.css';
    import { onMount } from 'svelte';
    import type { SelectionAction } from '@yukibana/papers-frame-protocol';
    import { Frame, type ToolbarState } from '#lib/frame/frame.ts';

    let { data }: { data: { appOrigin: string } } = $props();

    let scroller: HTMLDivElement | undefined = $state();
    let toolbar: ToolbarState | null = $state(null);
    let frame: Frame | null = null;

    onMount(() => {
        if (scroller === undefined) return;
        frame = new Frame(scroller, data.appOrigin, (t) => (toolbar = t));
        return () => frame?.dispose();
    });

    function act(action: SelectionAction): void {
        frame?.act(action);
    }

    const ACTIONS: readonly { action: SelectionAction; tip: string; path: string }[] = [
        { action: 'comment', tip: 'Comment · on this text', path: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' },
        { action: 'suggest', tip: 'Suggest · an edit to this text', path: 'M12 20h9M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z' },
        { action: 'source', tip: 'Source · show it in the editor', path: 'm16 18 6-6-6-6M8 6l-6 6 6 6' },
    ];
</script>

<div class="pv-scroll" bind:this={scroller} data-frame-ready>
    {#if toolbar !== null}
        <div class="pv-toolbar" role="toolbar" aria-label="Selection" style:left="{toolbar.x}px" style:top="{toolbar.y}px">
            {#each ACTIONS as a (a.action)}
                <button type="button" class="pv-tool" aria-label={a.tip.split(' · ')[0]} data-tip={a.tip} onmousedown={(e) => e.preventDefault()} onclick={() => act(a.action)}>
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d={a.path} /></svg>
                </button>
            {/each}
        </div>
    {/if}
</div>
