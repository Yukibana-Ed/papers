<script lang="ts">
    import type { User } from '#lib/model/types.ts';

    /** A person, small: their picture when they have one and it loads, on top of their initials in their colour. */
    let { user, size = 20 }: { user: User | undefined; size?: number } = $props();
    let failed = $state(false);
</script>

<span class="avatar" role="img" style:--hue={user?.hue ?? 0} style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.42}px" aria-label={user?.name ?? 'Unknown'}>
    {user?.initials ?? '?'}
    {#if user?.picture !== undefined && !failed}
        <img src={user.picture} alt="" width={size} height={size} loading="lazy" referrerpolicy="no-referrer" onerror={() => (failed = true)} />
    {/if}
</span>
