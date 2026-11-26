<script lang="ts">
    import type { Session } from '#lib/session.svelte.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import type { IconName } from '#lib/ui/icons.ts';
    import { tip } from '#lib/ui/tooltip.ts';
    import { byFile, type Problem, type Severity } from './model.ts';
    import ProblemMenu from './ProblemMenu.svelte';
    import { problemRow, type MenuAt } from './row.ts';

    /** Every problem of the document: the build's and the language servers', grouped by file, errors first. Notes (over-
     *  and underfull boxes) only when asked for. The build's log is one toggle away. A row's text can be selected; a
     *  click goes to its place, a right click offers that and copying. */
    let { session: s, onOpen }: { session: Session; onOpen: (p: Problem) => void } = $props();

    let menu = $state<MenuAt | null>(null);
    let hidden = $state<Record<Severity, boolean>>({ error: false, warning: false, info: true });
    const shown = $derived(s.problems.filter((p) => !hidden[p.severity] && (p.severity !== 'info' || s.showNotes)));
    const groups = $derived(byFile(shown));
    const short = (f: string): string => f.split('/').pop() ?? f;
    const ICON: Record<Severity, IconName> = { error: 'alert', warning: 'warning', info: 'info' };

    function toggle(sev: Severity): void {
        hidden = { ...hidden, [sev]: !hidden[sev] };
        if (sev === 'info') s.showNotes = !hidden.info;
    }
</script>

<div class="panel-head">
    <span>Problems</span>
    <span class="grow"></span>
    <div class="prob-filter" role="group" aria-label="Show">
        <button type="button" class="prob-toggle sev-error" aria-pressed={!hidden.error} onclick={() => toggle('error')} {...tip('Errors')}>
            <Icon name="alert" size={12} />{s.problemCounts.error}
        </button>
        <button type="button" class="prob-toggle sev-warning" aria-pressed={!hidden.warning} onclick={() => toggle('warning')} {...tip('Warnings')}>
            <Icon name="warning" size={12} />{s.problemCounts.warning}
        </button>
        <button type="button" class="prob-toggle sev-info" aria-pressed={!hidden.info} onclick={() => toggle('info')} {...tip('Notes', null, 'over- and underfull boxes')}>
            <Icon name="info" size={12} />{s.problemCounts.info}
        </button>
    </div>
    <button type="button" class="yk-btn yk-btn--ghost btn-xs" aria-pressed={s.showLog} onclick={() => (s.showLog = !s.showLog)} {...tip('Show log', null, "the engine's full log")}>Log</button>
</div>
{#if s.showLog}
    <pre class="prob-log mono">{s.shownBuild.log || s.build.log || '—'}</pre>
{:else}
    <div class="prob-list">
        {#if groups.length === 0}
            <div class="empty-mini">No problems</div>
        {/if}
        {#each groups as g (g.file)}
            <div class="prob-file mono">
                {short(g.file)}
                <span class="muted">{g.problems.length}</span>
            </div>
            <ul>
                {#each g.problems as p (p.id)}
                    <li>
                        <div class="row-btn prob-row sev-{p.severity}" {...problemRow(p, onOpen, (at) => (menu = at))} {...tip(`${p.file}:${p.line}`, 'Enter', p.raw ?? null)}>
                            <Icon name={ICON[p.severity]} size={13} />
                            <span class="prob-msg">{p.message}</span>
                            <span class="grow"></span>
                            <span class="muted mono">{p.line}{p.column === undefined ? '' : `:${p.column}`}</span>
                        </div>
                    </li>
                {/each}
            </ul>
        {/each}
    </div>
{/if}
{#if menu}<ProblemMenu at={menu} {onOpen} onClose={() => (menu = null)} />{/if}
