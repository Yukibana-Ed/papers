<script lang="ts">
    import { dialogFocus } from '#lib/ui/focus.ts';
    import type { Command } from './commands.ts';

    /** Ctrl+K: every command and every file, filtered by what is typed. While it is open the keyboard is its own:
     *  focus goes to its field whatever had it (the editor does not give it up to `autofocus`), comes back to the field
     *  if anything else takes it, and returns to where it was when the palette closes. */
    let { commands, onClose }: { commands: readonly Command[]; onClose: () => void } = $props();
    let q = $state('');
    let i = $state(0);
    let input = $state<HTMLInputElement>();
    const list = $derived(commands.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())));

    function run(c: Command): void {
        onClose();
        setTimeout(c.run, 0);
    }

    /** Keeps focus in the palette: whatever takes it while the palette is open gives it back to the field. */
    function keepFocus(e: FocusEvent & { currentTarget: HTMLElement }): void {
        const dialog = e.currentTarget;
        if (e.relatedTarget instanceof Node && dialog.contains(e.relatedTarget)) return;
        queueMicrotask(() => {
            if (dialog.isConnected && !dialog.contains(document.activeElement)) input?.focus();
        });
    }

    function key(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        } else if (e.key === 'Tab') e.preventDefault();
        else if (e.key === 'ArrowDown') {
            e.preventDefault();
            i = Math.min(list.length - 1, i + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            i = Math.max(0, i - 1);
        } else if (e.key === 'Enter') {
            const c = list[i];
            if (c) run(c);
        }
    }
</script>

<svelte:window onkeydowncapture={key} />

<div class="palette-back" role="presentation" onmousedown={onClose}>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Commands" tabindex="-1" onmousedown={(e) => e.stopPropagation()} onfocusout={keepFocus} {@attach dialogFocus}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
            autofocus
            bind:this={input}
            class="palette-input"
            placeholder="Command or file"
            aria-label="Command or file"
            value={q}
            oninput={(e) => {
                q = e.currentTarget.value;
                i = 0;
            }}
        />
        <ul class="palette-list">
            {#each list as c, j (c.id)}
                <li>
                    <button type="button" class="row-btn" class:is-current={j === i} onmouseenter={() => (i = j)} onclick={() => run(c)}>
                        <span class:mono={c.kind === 'file'}>{c.name}</span>
                        <span class="grow"></span>
                        {#if c.kbd}<kbd class="tip-kbd">{c.kbd}</kbd>{/if}
                    </button>
                </li>
            {/each}
            {#if list.length === 0}<li class="empty-mini">No match</li>{/if}
        </ul>
    </div>
</div>
