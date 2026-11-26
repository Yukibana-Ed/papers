<script lang="ts">
    import type { ServiceState } from '#lib/session.svelte.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';

    /** A part of the build service did not load: said as such (not as a problem with the paper), with what failed and
     *  a way to try again. */
    let { failure, onRetry }: { failure: ServiceState; onRetry: () => void } = $props();

    const NAMES: Record<ServiceState['what'], string> = {
        'tex-engine': 'The TeX engine did not load',
        'typst-compiler': 'The Typst compiler did not load',
        texlive: 'TeX Live did not load',
    };
</script>

<section class="pv-service" role="status" aria-label="Build service">
    <Icon name="globe" size={18} />
    <strong>{NAMES[failure.what]}</strong>
    <span class="mono pv-service-detail">{failure.detail}</span>
    <button type="button" class="yk-btn yk-btn--primary btn-sm" onclick={onRetry} {...tip('Retry', null, 'load it again and build')}>Retry</button>
</section>
