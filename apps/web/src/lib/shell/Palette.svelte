<script lang="ts">
    import type { Command } from './commands.ts';

    /** Ctrl+K: every command and every file, filtered by what is typed. */
    let { commands, onClose }: { commands: readonly Command[]; onClose: () => void } = $props();
    let q = $state('');
    let i = $state(0);
    const list = $derived(commands.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())));

    function run(c: Command): void {
        onClose();
        setTimeout(c.run, 0);
    }

    function key(e: KeyboardEvent): void {
        if (e.key === 'Escape') onClose();
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

<div class="palette-back" role="presentation" onmousedown={onClose}>
    <div class="palette" role="dialog" aria-label="Commands" tabindex="-1" onmousedown={(e) => e.stopPropagation()}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
            autofocus
            class="palette-input"
            placeholder="Command or file"
            aria-label="Command or file"
            value={q}
            oninput={(e) => {
                q = e.currentTarget.value;
                i = 0;
            }}
            onkeydown={key}
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
