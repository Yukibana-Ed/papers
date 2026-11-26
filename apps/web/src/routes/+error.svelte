<script lang="ts">
    import { page } from '$app/state';

    /** Any page that failed: its status and message in the app's own look, and the way back to the start. */
</script>

<svelte:head><title>{page.status} · Yukibana Papers</title></svelte:head>

<main class="failed">
    <img src="/logo.svg" alt="" width="36" height="36" />
    <h1>{page.status}</h1>
    <p>{page.error?.message ?? 'Something went wrong'}</p>
    <a class="yk-btn yk-btn--secondary" href="/">Yukibana Papers</a>
</main>

<style>
    .failed {
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 10px;
        height: 100%;
        padding: 16px;
        background: var(--yk-bg);
        text-align: center;
    }
    h1 {
        margin: 4px 0 0;
        font-family: var(--yk-font-family-heading);
        font-size: 28px;
        letter-spacing: -0.02em;
    }
    p {
        margin: 0 0 8px;
        color: var(--yk-soft);
    }
</style>
