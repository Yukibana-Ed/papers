<script lang="ts">
    import { chooseTheme, readTheme } from '@yukibana/design/theme';
    import type { FrameMessage, SelectionAction, SourceLines, SourcePoint } from '@yukibana/papers-frame-protocol';
    import { onMount } from 'svelte';
    import type { CommentOps } from '#lib/comments/ops.ts';
    import type { SourceEditor } from '#lib/editor/source-editor.ts';
    import BuilderMenu from '#lib/preview/BuilderMenu.svelte';
    import Preview from '#lib/preview/Preview.svelte';
    import type { RoomClient } from '#lib/room/client.ts';
    import type { Session } from '#lib/session.svelte.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import type { IconName } from '#lib/ui/icons.ts';
    import TooltipLayer from '#lib/ui/TooltipLayer.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import type { Command } from './commands.ts';
    import Header from './Header.svelte';
    import Palette from './Palette.svelte';

    /** The editor: header, rail and panels, source, preview. */
    let { session: s, contentOrigin, room = null }: { session: Session; contentOrigin: string; room?: RoomClient | null } = $props();

    let host = $state<HTMLDivElement | null>(null);
    let editor = $state<SourceEditor | null>(null);
    let preview = $state<ReturnType<typeof Preview> | null>(null);
    let selButton = $state<number | null>(null);
    const short = (f: string): string => f.split('/').pop() ?? f;
    const narrow = (): boolean => matchMedia('(max-width: 900px)').matches;

    onMount(() => {
        s.theme = readTheme();
        const media = matchMedia('(prefers-color-scheme: dark)');
        const onMedia = (): void => {
            s.systemDark = media.matches;
        };
        onMedia();
        media.addEventListener('change', onMedia);
        let disposed = false;
        let ed: SourceEditor | null = null;
        void import('#lib/editor/source-editor.ts').then(({ SourceEditor }) => {
            if (disposed || !host) return;
            ed = new SourceEditor(host, s.files, s.activeFile, s.me, {
                change: (f, text) => s.edit(f, text),
                cursor: (c) => s.setCursor(c),
                selection: (sel) => (s.selection = sel),
                openThread: (id, opts) => focusItem(id, opts),
                anchors: (a) => (s.anchors = { ...a }),
                suggestions: (list) => (s.suggestions = [...list]),
                selectionButton: (top) => (selButton = top),
            });
            editor = ed;
        });
        return () => {
            disposed = true;
            media.removeEventListener('change', onMedia);
            ed?.dispose();
        };
    });

    // The editor follows the session.
    $effect(() => editor?.show(s.activeFile));
    $effect(() => editor?.setThreads(s.visibleThreads, s.activeThread));
    $effect(() => editor?.setSuggestMode(s.suggestMode));
    $effect(() => editor?.setPresence(s.presence, s.users));
    $effect(() => editor?.setMirror(s.mirror));
    $effect(() => editor?.setDiagnostics(s.build.errors.map((e) => ({ ...e, severity: 'error' as const }))));
    $effect(() => {
        const dark = s.dark;
        // After data-theme has changed on <html>, which the token colours resolve against.
        const id = requestAnimationFrame(() => editor?.setTheme(dark));
        return () => cancelAnimationFrame(id);
    });
    let seeded = false;
    $effect(() => {
        if (editor && !seeded && !room) {
            seeded = true;
            void import('#lib/demo/project.ts').then(({ SUGGESTIONS }) => editor?.addSuggestions(SUGGESTIONS, s.users));
        }
    });

    // Typst projects get tinymist, which runs in the content frame: started once the editor's models exist, so they open
    // on it at once.
    let languageClient: { dispose(): void } | null = null;
    $effect(() => {
        const p = preview;
        if (!editor || !p || languageClient || !Object.keys(s.files).some((f) => f.endsWith('.typ'))) return;
        languageClient = { dispose: () => {} };
        void Promise.all([import('#lib/lsp/client.ts'), import('#lib/lsp/tinymist.ts')]).then(([{ LanguageClient }, { tinymistProfile }]) => {
            // The server first, then the client, whose first message (initialize) must find it.
            let c: InstanceType<typeof LanguageClient> | null = null;
            p.startServer('tinymist', (m) => c?.receive(m as Parameters<InstanceType<typeof LanguageClient>['receive']>[0]));
            c = new LanguageClient('typst', 'tinymist', (m) => p.lspSend('tinymist', m), tinymistProfile());
            languageClient = c;
        });
        return () => languageClient?.dispose();
    });

    // A repository's session: every file of the room bound to its model, and files others open bound as they come.
    $effect(() => {
        const ed = editor;
        if (!ed || !room) return;
        const files = room.files;
        for (const [path, text] of files) ed.bind(path, text);
        const onFiles = (e: { keysChanged: Set<string> }): void => {
            for (const path of e.keysChanged) {
                const text = files.get(path);
                if (text) ed.bind(path, text);
            }
        };
        files.observe(onFiles);
        return () => files.unobserve(onFiles);
    });

    function setTheme(t: 'light' | 'dark' | 'system'): void {
        chooseTheme(t);
        s.theme = t;
    }

    // --- actions -----------------------------------------------------------------------------------------------------

    function openFile(f: string, line?: number, col = 1): void {
        s.openFile(f);
        if (line !== undefined) setTimeout(() => editor?.reveal(f, line, col), 0);
    }

    function focusItem(id: string, opts: { open?: boolean; fromText?: boolean } = {}): void {
        s.activeThread = id;
        if (opts.open) s.panel = 'comments';
        if (opts.fromText) return;
        const file = s.threads.find((t) => t.id === id)?.file ?? s.suggestions.find((x) => x.id === id)?.file;
        if (file) s.openFile(file);
        setTimeout(() => editor?.revealItem(id), 0);
    }

    function newComment(): void {
        const sel = editor?.selection();
        if (!sel) return s.flash('Select text first');
        s.startThread(sel.file, sel.quote, sel.range);
    }

    const ops: CommentOps = {
        get session() {
            return s;
        },
        focusItem,
        newComment,
        acceptReplacement(threadId, commentId) {
            const text = s.replacementOf(threadId, commentId);
            if (text === null) return;
            editor?.replaceAnchor(threadId, text);
            s.replacementAccepted(threadId, commentId, text);
        },
        acceptSuggestion: (id) => editor?.acceptSuggestion(id),
        rejectSuggestion: (id) => editor?.rejectSuggestion(id),
    };

    async function jumpOther(): Promise<void> {
        if (narrow()) {
            s.narrowPane = s.narrowPane === 'source' ? 'preview' : 'source';
            preview?.show({ file: s.cursor.file, line: s.cursor.line });
            return;
        }
        if (document.activeElement?.matches('[data-pane="preview"]')) {
            const at = await preview?.centre();
            if (at) openFile(at.file, at.line);
        } else {
            preview?.show({ file: s.cursor.file, line: s.cursor.line });
            preview?.focus();
        }
    }

    /** A click in the preview: open its source at the word clicked, selected. */
    function onJump(at: SourcePoint, word: string | null): void {
        // The frame may point into files the build made (paper.bbl): only project files open.
        if (!(at.file in s.files)) return;
        if (narrow()) s.narrowPane = 'source';
        const text = editor?.lineText(at.file, at.line) ?? '';
        const i = word ? text.indexOf(word) : -1;
        const col = i >= 0 ? i + 1 : (at.column ?? 1);
        s.openFile(at.file);
        setTimeout(() => {
            if (word && i >= 0) editor?.reveal(at.file, at.line, col, { select: { startLineNumber: at.line, startColumn: col, endLineNumber: at.line, endColumn: col + word.length } });
            else editor?.reveal(at.file, at.line, col);
        }, 0);
    }

    /** The preview selection's toolbar. */
    function onAction(action: SelectionAction, lines: SourceLines, text: string): void {
        if (!(lines.file in s.files)) return;
        s.openFile(lines.file);
        setTimeout(() => {
            editor?.selectLines(lines);
            if (action === 'comment') {
                const sel = editor?.selection();
                if (sel) s.startThread(sel.file, text || sel.quote, sel.range);
            } else if (action === 'suggest') {
                s.suggestMode = true;
            }
        }, 0);
    }

    // --- commands and shortcuts --------------------------------------------------------------------------------------

    const commands = $derived<Command[]>([
        { id: 'commit', name: 'Commit', kbd: 'Ctrl+S', run: () => (s.popover = 'commit') },
        { id: 'suggest', name: s.suggestMode ? 'Stop suggesting' : 'Suggest edits', kbd: 'Ctrl+Alt+S', run: () => (s.suggestMode = !s.suggestMode) },
        { id: 'comment', name: 'Comment on selection', kbd: 'Ctrl+Alt+M', run: newComment },
        { id: 'jump', name: 'Jump to the other side', kbd: 'Ctrl+J', run: () => void jumpOther() },
        { id: 'outline', name: 'Outline', kbd: 'Ctrl+Shift+O', run: () => s.togglePanel('outline') },
        { id: 'files', name: 'Files', kbd: 'Ctrl+Shift+E', run: () => s.togglePanel('files') },
        { id: 'comments', name: 'Comments', kbd: 'Ctrl+Shift+M', run: () => s.togglePanel('comments') },
        { id: 'log', name: 'Show log', run: () => (s.popover = 'log') },
        ...s.branchNames.filter((b) => b !== s.branch).map((b) => ({ id: `br-${b}`, name: `Switch to ${b}`, run: () => s.switchBranch(b) })),
        { id: 'newbranch', name: 'New branch', run: () => (s.popover = 'branch') },
        ...s.order.map((f) => ({ id: `f-${f}`, name: f, kind: 'file' as const, run: () => openFile(f) })),
        { id: 'zoomin', name: 'Zoom in', kbd: 'Ctrl+=', run: () => s.zoomBy(0.1) },
        { id: 'zoomout', name: 'Zoom out', kbd: 'Ctrl+-', run: () => s.zoomBy(-0.1) },
        { id: 'theme-light', name: 'Light theme', run: () => setTheme('light') },
        { id: 'theme-dark', name: 'Dark theme', run: () => setTheme('dark') },
        { id: 'theme-system', name: 'System theme', run: () => setTheme('system') },
    ]);

    /** The command for a key, as the header's tooltips name them; null for keys that are not ours. */
    function commandFor(k: { key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean }): string | null {
        const key = k.key.toLowerCase();
        if (!k.ctrl) return null;
        if (!k.shift && !k.alt && key === 'k') return 'palette';
        if (k.shift && key === 'p') return 'palette';
        if (!k.shift && !k.alt && key === 's') return 'commit';
        if (k.alt && k.code === 'KeyS') return 'suggest';
        if (k.alt && k.code === 'KeyM') return 'comment';
        if (!k.shift && key === 'j') return 'jump';
        if (k.shift && key === 'o') return 'outline';
        if (k.shift && key === 'e') return 'files';
        if (k.shift && key === 'm') return 'comments';
        if (key === '=' || key === '+') return 'zoomin';
        if (key === '-') return 'zoomout';
        return null;
    }

    function runKey(id: string): void {
        if (id === 'palette') s.palette = !s.palette;
        else if (id === 'commit') {
            if (s.popover === 'commit') void s.commit();
            else if (s.uncommitted) s.popover = 'commit';
        } else commands.find((c) => c.id === id)?.run();
    }

    function onKeydown(e: KeyboardEvent): void {
        const id = commandFor({ key: e.key, code: e.code, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        runKey(id);
    }

    function onFrameKey(m: Extract<FrameMessage, { type: 'key' }>): void {
        const id = commandFor(m);
        if (id) runKey(id);
    }

    function onMousedown(e: MouseEvent): void {
        if (s.popover && e.target instanceof Element && !e.target.closest('.popover, [data-popover-anchor]')) s.popover = null;
    }

    function onEscape(e: KeyboardEvent): void {
        if (e.key === 'Escape' && s.popover) s.popover = null;
    }

    const rail: readonly { id: 'outline' | 'files' | 'comments'; icon: IconName; name: string; kbd: string }[] = [
        { id: 'outline', icon: 'outline', name: 'Outline', kbd: 'Ctrl+Shift+O' },
        { id: 'files', icon: 'files', name: 'Files', kbd: 'Ctrl+Shift+E' },
        { id: 'comments', icon: 'comment', name: 'Comments', kbd: 'Ctrl+Shift+M' },
    ];
</script>

<svelte:window onkeydowncapture={onKeydown} onmousedown={onMousedown} onkeydown={onEscape} />

<div class="app narrow-{s.narrowPane}" class:rail-open={s.panel !== null}>
    <Header
        session={s}
        onOpenFile={(f) => openFile(f)}
        onPalette={() => (s.palette = true)}
        onShowReview={() => {
            s.commentFilter = 'github';
            s.panel = 'comments';
        }}
    />

    <nav class="rail" aria-label="Panels">
        {#each rail as r (r.id)}
            <button type="button" class="rail-btn" class:is-on={s.panel === r.id} aria-pressed={s.panel === r.id} onclick={() => s.togglePanel(r.id)} {...tip(r.name, r.kbd, null, 'right')}>
                <Icon name={r.icon} size={18} />
                {#if r.id === 'comments' && s.openCount > 0}<span class="rail-badge">{s.openCount}</span>{/if}
                {#if r.id === 'files' && s.changes.length > 0}<span class="rail-dot"></span>{/if}
            </button>
        {/each}
        <span class="grow"></span>
        <button type="button" class="rail-btn" onclick={() => setTheme(s.dark ? 'light' : 'dark')} {...tip(s.dark ? 'Light theme' : 'Dark theme', null, null, 'right')}>
            <Icon name={s.dark ? 'sun' : 'moon'} size={18} />
        </button>
    </nav>

    {#if s.panel}
        <aside class="panel panel-{s.panel}" aria-label={s.panel}>
            {#if s.panel === 'outline'}
                <div class="panel-head">
                    <span>Outline</span>
                    <span class="muted mono">{short(s.root)}</span>
                </div>
                <ul class="outline">
                    {#each s.headings as h (`${h.file}:${h.line}`)}
                        <li>
                            <button type="button" class="row-btn {h.kind}" class:is-current={h === s.currentHeading} onclick={() => openFile(h.file, h.line)}>
                                <span class="pv-num">{h.num}</span>
                                <span>{h.title}</span>
                            </button>
                        </li>
                    {/each}
                </ul>
            {:else if s.panel === 'files'}
                <div class="panel-head"><span>Files</span></div>
                <ul class="filelist">
                    {#each s.order as f (f)}
                        {@const isRoot = s.roots.includes(f)}
                        <li>
                            <button
                                type="button"
                                class="row-btn"
                                class:is-current={f === s.activeFile}
                                style:padding-left="{10 + (f.split('/').length - 1) * 14}px"
                                onclick={() => openFile(f)}
                                {...isRoot ? tip(short(f), null, 'compiles by itself') : {}}
                            >
                                <Icon name={isRoot ? 'doc' : 'files'} size={14} />
                                <span class:strong={!f.includes('/')}>{short(f)}</span>
                                <span class="grow"></span>
                                {#if s.changes.some((c) => c.file === f)}<span class="mod" aria-label="uncommitted">M</span>{/if}
                            </button>
                        </li>
                    {/each}
                </ul>
            {:else}
                {#await import('#lib/comments/CommentsPanel.svelte') then { default: CommentsPanel }}
                    <CommentsPanel {ops} />
                {/await}
            {/if}
        </aside>
    {/if}

    <section class="pane pane-source" aria-label="Source">
        <div class="yk-dock" role="tablist" data-focused="">
            {#each s.tabs as f (f)}
                {@const dirty = s.changes.some((c) => c.file === f)}
                <button
                    type="button"
                    role="tab"
                    class="yk-dock-tab"
                    aria-selected={f === s.activeFile}
                    onclick={() => (s.activeFile = f)}
                    onauxclick={(e) => e.button === 1 && s.closeTab(f)}
                    {...tip(f, null, dirty ? 'uncommitted edits' : null)}
                >
                    {short(f)}
                    {#if dirty}<span class="tab-dot"></span>{/if}
                    <span
                        role="button"
                        tabindex="-1"
                        class="tab-x"
                        onclick={(e) => {
                            e.stopPropagation();
                            s.closeTab(f);
                        }}
                        onkeydown={() => {}}
                        {...tip('Close', 'Ctrl+W')}
                    >
                        <Icon name="x" size={12} />
                    </span>
                </button>
            {/each}
            <div class="yk-dock-actions">
                {#if s.suggestMode}
                    <span class="yk-chip yk-chip--violet" {...tip('Suggesting', 'Ctrl+Alt+S', 'your edits wait for review')}><Icon name="suggest" />Suggesting</span>
                {/if}
            </div>
        </div>
        <div class="editor-host-wrap">
            <div class="editor-host" bind:this={host}></div>
            {#if selButton !== null}
                <button type="button" class="sel-comment yk-icon-btn" style:top="{selButton}px" onmousedown={(e) => e.preventDefault()} onclick={newComment} {...tip('Comment', 'Ctrl+Alt+M', null, 'right')}>
                    <Icon name="comment" />
                </button>
            {/if}
        </div>
    </section>

    <section class="pane pane-preview" aria-label="Preview">
        <div class="yk-dock pv-bar">
            {#if s.roots.length > 1}
                <button type="button" class="pv-doc" class:is-open={s.popover === 'doc'} data-popover-anchor onclick={() => s.togglePopover('doc')} {...tip('Document', null, s.pinnedRoot ? 'pinned' : 'follows the file you edit')}>
                    {#if s.pinnedRoot}<Icon name="pin" size={12} />{/if}
                    {short(s.root)}
                    <Icon name="chevron" size={12} />
                </button>
            {:else}
                <span class="pv-doc static">{short(s.root)}</span>
            {/if}
            {#if s.build.errors.length > 0}
                {@const e = s.build.errors[0]}
                {#if e}
                    <button type="button" class="pv-err" onclick={() => openFile(e.file, e.line)} {...tip(e.message, null, `${short(e.file)}:${e.line} · showing last good pages`)}>
                        <Icon name="alert" size={13} />{s.build.errors.length}
                        {s.build.errors.length === 1 ? 'error' : 'errors'}
                    </button>
                {/if}
            {/if}
            <div class="yk-dock-actions">
                {#if s.build.status !== 'idle'}
                    <span class="yk-spinner pv-spin" role="status" aria-label={s.build.status === 'loading' ? 'Loading TeX' : 'Compiling'}></span>
                {:else if s.build.pages > 0}
                    <span class="muted pv-pages-n" {...tip(`${s.build.pages} ${s.build.pages === 1 ? 'page' : 'pages'}`, null, `built in ${(s.build.ms / 1000).toFixed(1)} s`)}>{s.build.pages}p</span>
                {/if}
                <button type="button" class="yk-icon-btn icon-xs" onclick={() => s.zoomBy(-0.1)} {...tip('Zoom out', 'Ctrl+-')}><Icon name="minus" size={14} /></button>
                <span class="muted zoom-n">{Math.round(s.scale * 100)}%</span>
                <button type="button" class="yk-icon-btn icon-xs" onclick={() => s.zoomBy(0.1)} {...tip('Zoom in', 'Ctrl+=')}><Icon name="plus" size={14} /></button>
                <button
                    type="button"
                    class="backend"
                    class:is-open={s.popover === 'builder'}
                    data-popover-anchor
                    onclick={() => s.togglePopover('builder')}
                    {...tip(s.builder === 'computer' ? 'This computer' : 'Browser', null, s.builder === 'computer' ? 'papers serve, sandboxed' : 'TeX Live 2026, in this tab')}
                >
                    <Icon name={s.builder === 'computer' ? 'doc' : 'globe'} size={12} />
                    {s.builder === 'computer' ? 'Computer' : 'Browser'}
                </button>
            </div>
            {#if s.popover === 'builder'}
                <BuilderMenu session={s} onPaired={(token) => preview?.connectComputer(token)} />
            {/if}
            {#if s.popover === 'doc'}
                <div class="popover pop-doc" role="dialog" aria-label="Document">
                    {#each s.roots as r (r)}
                        <button
                            type="button"
                            class="row-btn"
                            class:is-current={r === s.root}
                            onclick={() => {
                                if (s.pinnedRoot) s.pinnedRoot = r;
                                else openFile(r);
                                s.popover = null;
                            }}
                        >
                            <Icon name="doc" size={14} />
                            {r}
                        </button>
                    {/each}
                    <div class="pop-sep"></div>
                    <button
                        type="button"
                        class="row-btn"
                        aria-pressed={s.pinnedRoot !== null}
                        onclick={() => {
                            s.pinnedRoot = s.pinnedRoot ? null : s.root;
                            s.popover = null;
                        }}
                        {...tip(s.pinnedRoot ? 'Unpin' : 'Pin', null, s.pinnedRoot ? 'follow the file you edit' : 'keep this document')}
                    >
                        <Icon name="pin" size={14} />
                        {s.pinnedRoot ? 'Unpin' : 'Pin'}
                    </button>
                </div>
            {/if}
        </div>
        <Preview bind:this={preview} session={s} {contentOrigin} {onJump} {onAction} onKey={onFrameKey} />
    </section>

    {#if s.palette}<Palette {commands} onClose={() => (s.palette = false)} />{/if}
    <TooltipLayer />
    {#if s.toast}
        {#key s.toast.key}
            <div class="yk-toast" role="status"><span>{s.toast.text}</span></div>
        {/key}
    {/if}
</div>
