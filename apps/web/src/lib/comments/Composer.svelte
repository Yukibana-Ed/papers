<script lang="ts">
    import type { EditorView } from 'prosemirror-view';
    import { untrack } from 'svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import type { IconName } from '#lib/ui/icons.ts';
    import { tip } from '#lib/ui/tooltip.ts';
    import { commands, createRichEditor, isActive, type CommandName } from './editor.ts';
    import { commentSettings } from './settings.svelte.ts';

    /** Writes one comment, in the rich editor or as Markdown (`commentSettings.mode`); sends its Markdown. */
    let {
        placeholder,
        onSend,
        onCancel,
        autofocus = false,
        target = $bindable<'team' | 'github'>('team'),
        allowTarget = false,
    }: {
        placeholder: string;
        onSend: (markdown: string) => void;
        onCancel?: () => void;
        autofocus?: boolean;
        target?: 'team' | 'github';
        allowTarget?: boolean;
    } = $props();

    let markdown = $state('');
    let view = $state<EditorView | null>(null);
    let tick = $state(0);
    let textarea = $state<HTMLTextAreaElement | null>(null);

    const TOOLS: readonly { name: CommandName; icon: IconName; label: string; kbd?: string }[] = [
        { name: 'bold', icon: 'bold', label: 'Bold', kbd: 'Ctrl+B' },
        { name: 'italic', icon: 'italic', label: 'Italic', kbd: 'Ctrl+I' },
        { name: 'code', icon: 'code', label: 'Code', kbd: 'Ctrl+E' },
        { name: 'link', icon: 'link', label: 'Link', kbd: 'Ctrl+K' },
        { name: 'bullets', icon: 'list', label: 'List' },
        { name: 'quote', icon: 'quote', label: 'Quote' },
    ];

    function send(): void {
        const text = markdown.trim();
        if (!text) return;
        onSend(text);
        markdown = '';
        if (view) {
            const v = view;
            v.dispatch(v.state.tr.delete(0, v.state.doc.content.size));
        }
    }

    /** Creates the rich editor once for `host`. The view owns its document and selection: it reports Markdown out
     *  (`markdown`) and is never rebuilt from it. Everything read here is read untracked, since an attachment re-runs
     *  when what it reads changes: reading `markdown` made every keystroke rebuild the editor with the caret at the
     *  start, so typing came out backwards. */
    function mount(host: HTMLElement): () => void {
        return untrack(() => mountOnce(host));
    }

    function mountOnce(host: HTMLElement): () => void {
        const v = createRichEditor(host, {
            markdown,
            placeholder,
            onSubmit: send,
            onCancel: () => onCancel?.(),
            onChange: (m) => {
                markdown = m;
                tick++;
            },
        });
        // Selection changes move the toolbar's pressed states.
        const update = (): void => {
            tick++;
        };
        host.addEventListener('keyup', update);
        host.addEventListener('mouseup', update);
        view = v;
        if (autofocus) v.focus();
        return () => {
            host.removeEventListener('keyup', update);
            host.removeEventListener('mouseup', update);
            v.destroy();
            view = null;
        };
    }

    /** The rich editor's view while it is mounted, for tests that type into it as the browser does. */
    export function editorView(): EditorView | null {
        return view;
    }

    function run(name: CommandName): void {
        if (!view) return;
        commands[name](view.state, view.dispatch, view);
        view.focus();
        tick++;
    }

    function pressed(name: CommandName): boolean {
        void tick;
        return view ? isActive(view.state, name) : false;
    }

    $effect(() => {
        if (commentSettings.mode === 'markdown' && autofocus) textarea?.focus();
    });
</script>

<!-- Clicks and keys stay in the composer: the card around it would take them as "make this thread current". -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="composer" role="group" aria-label={placeholder} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    {#if commentSettings.mode === 'rich'}
        <div class="composer-field rich" {@attach mount}></div>
    {:else}
        <textarea
            bind:this={textarea}
            bind:value={markdown}
            class="composer-field md"
            rows="1"
            {placeholder}
            aria-label={placeholder}
            onkeydown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
                if (e.key === 'Escape') onCancel?.();
            }}
        ></textarea>
    {/if}
    <div class="composer-row">
        {#if commentSettings.mode === 'rich'}
            {#each TOOLS as t (t.name)}
                <button type="button" class="yk-icon-btn icon-xxs" aria-pressed={pressed(t.name)} onmousedown={(e) => e.preventDefault()} onclick={() => run(t.name)} {...tip(t.label, t.kbd)}>
                    <Icon name={t.icon} size={13} />
                </button>
            {/each}
        {/if}
        <button
            type="button"
            class="yk-icon-btn icon-xxs"
            aria-pressed={commentSettings.mode === 'markdown'}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => commentSettings.toggle()}
            {...tip(commentSettings.mode === 'markdown' ? 'Rich text' : 'Markdown', null, 'for every comment')}
        >
            <Icon name="markdown" size={14} />
        </button>
        <div class="composer-send">
        {#if allowTarget}
            <div class="yk-segmented seg-xs" role="group" aria-label="Post to">
                <button type="button" aria-pressed={target === 'team'} onclick={() => (target = 'team')} {...tip('Team note', null, 'stays in Yukibana')}>Team</button>
                <button type="button" aria-pressed={target === 'github'} onclick={() => (target = 'github')} {...tip('PR review', null, 'adds to your pending review')}>PR</button>
            </div>
        {/if}
        {#if onCancel}
            <button type="button" class="yk-btn yk-btn--ghost btn-xs" onclick={() => onCancel?.()} {...tip('Cancel', 'Esc')}>Cancel</button>
        {/if}
        <button type="button" class="yk-btn yk-btn--primary btn-xs" disabled={!markdown.trim()} onclick={send} {...tip('Send', 'Ctrl+Enter')}>Send</button>
        </div>
    </div>
</div>
