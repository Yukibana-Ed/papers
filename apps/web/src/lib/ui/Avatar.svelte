<script lang="ts">
    import type { User } from '#lib/model/types.ts';

    let { user, size = 20 }: { user: User | undefined; size?: number } = $props();
</script>

<span class="avatar" role="img" style:--hue={user?.hue ?? 0} style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.42}px" aria-label={user?.name ?? 'Unknown'}>
    {user?.initials ?? '?'}
</span>
