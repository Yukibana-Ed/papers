<script lang="ts">
    import { dialogFocus } from '#lib/ui/focus.ts';
    import { keepInView } from '#lib/ui/place.ts';
    import { pair } from '#lib/runner/client.ts';
    import type { Session } from '#lib/session.svelte.ts';
    import { buildSettings } from './settings.svelte.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';

    /** Where the preview is built: this tab, or this computer through `papers serve` (paired with the code it prints). */
    let { session: s, onPaired }: { session: Session; onPaired: (token: string) => void } = $props();

    let code = $state('');
    let failure = $state<string | null>(null);
    let busy = $state(false);

    async function connect(): Promise<void> {
        busy = true;
        failure = null;
        try {
            onPaired(await pair(code));
            code = '';
        } catch (e) {
            failure = e instanceof Error ? e.message : 'Pairing failed';
        } finally {
            busy = false;
        }
    }
</script>

<div class="popover pop-builder" role="dialog" {@attach keepInView} {@attach dialogFocus} aria-label="Build">
    <button
        type="button"
        class="row-btn"
        class:is-current={s.builder === 'browser'}
        onclick={() => {
            s.builder = 'browser';
            s.popover = null;
        }}
        {...tip('This tab', null, 'TeX Live 2026 in the browser')}
    >
        <Icon name="globe" size={14} />
        Browser
    </button>
    <button
        type="button"
        class="row-btn"
        aria-pressed={buildSettings.incremental}
        onclick={() => buildSettings.toggle()}
        {...tip('Incremental', null, buildSettings.incremental ? 'each build goes on from the last' : 'every build starts again')}
    >
        <span style:visibility={buildSettings.incremental ? 'visible' : 'hidden'}><Icon name="check" size={14} /></span>
        Incremental
    </button>
    <button type="button" class="row-btn" class:is-current={s.builder === 'computer'} disabled={s.computer === null} onclick={() => (s.builder = 'computer')} {...tip('This computer', null, 'papers serve, sandboxed')}>
        <Icon name="doc" size={14} />
        This computer
        {#if s.computer}<span class="grow"></span><span class="muted mono">{s.computer.sandbox}</span>{/if}
    </button>
    {#if s.computer === null}
        <div class="pop-sep"></div>
        <form
            class="pop-row"
            onsubmit={(e) => {
                e.preventDefault();
                void connect();
            }}
        >
            <input class="yk-input mono" placeholder="code from papers serve" aria-label="Pairing code" bind:value={code} autocomplete="off" spellcheck="false" />
            <button type="submit" class="yk-btn yk-btn--primary btn-sm" disabled={busy || code.trim().length < 4} {...tip('Pair', 'Enter')}>Pair</button>
        </form>
        {#if failure}<span class="muted pop-failure">{failure}</span>{/if}
    {/if}
</div>
