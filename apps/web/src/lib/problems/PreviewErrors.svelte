<script lang="ts">
    import type { Session } from '#lib/session.svelte.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import type { Problem } from './model.ts';
    import ProblemMenu from './ProblemMenu.svelte';
    import { problemRow, type MenuAt } from './row.ts';

    /** The build's errors at the top of the preview pane, there by themselves once a failed build has settled: the first
     *  with its source line, each a button to its place, with text that can be selected and a right-click menu to copy it. Nothing takes focus or
     *  moves the caret. */
    let { session: s, onOpen, onLog }: { session: Session; onOpen: (p: Problem) => void; onLog: () => void } = $props();

    let menu = $state<MenuAt | null>(null);
    const short = (f: string): string => f.split('/').pop() ?? f;
    const errors = $derived(s.buildErrors);
    const first = $derived(errors[0]);
    /** The source line the first error is on, as the project has it now. */
    const sourceLine = $derived(first ? ((s.files[first.file] ?? '').split('\n')[first.line - 1] ?? '') : '');
</script>

{#if first}
    <section class="pv-errors" aria-label="Errors">
        <div class="pv-errors-head">
            <Icon name="alert" size={14} />
            <span>{errors.length} {errors.length === 1 ? 'error' : 'errors'}</span>
            <span class="grow"></span>
            <button type="button" class="yk-btn yk-btn--ghost btn-xs" onclick={onLog} {...tip('Show log', null, "the engine's full log")}>Log</button>
        </div>
        <div class="pv-error first" {...problemRow(first, onOpen, (at) => (menu = at))} {...tip(`${first.file}:${first.line}`, 'Enter', 'go to the source')}>
            <span class="pv-error-msg">{first.message}</span>
            <span class="pv-error-where mono">{short(first.file)}:{first.line}</span>
            {#if sourceLine.trim()}<code class="pv-error-line">{sourceLine.trim()}</code>{/if}
            {#if first.raw}<span class="pv-error-raw mono">{first.raw}</span>{/if}
        </div>
        {#each errors.slice(1) as p (p.id)}
            <div class="pv-error" {...problemRow(p, onOpen, (at) => (menu = at))} {...tip(`${p.file}:${p.line}`, 'Enter', 'go to the source')}>
                <span class="pv-error-msg">{p.message}</span>
                <span class="pv-error-where mono">{short(p.file)}:{p.line}</span>
            </div>
        {/each}
    </section>
{/if}
{#if menu}<ProblemMenu at={menu} {onOpen} onClose={() => (menu = null)} />{/if}
