<script lang="ts">
    import { dialogFocus } from '#lib/ui/focus.ts';
    import { keepInView } from '#lib/ui/place.ts';
    import { chooseTheme, readTheme } from '@yukibana/design/theme';
    import type { FrameMessage, SelectionAction, SourceLines, SourcePoint } from '@yukibana/papers-frame-protocol';
    import { onDestroy, onMount } from 'svelte';
    import type { CommentOps } from '#lib/comments/ops.ts';
    import type { SourceEditor } from '#lib/editor/source-editor.ts';
    import BuilderMenu from '#lib/preview/BuilderMenu.svelte';
    import { nextProblem, type Problem } from '#lib/problems/model.ts';
    import PreviewErrors from '#lib/problems/PreviewErrors.svelte';
    import ProblemsPanel from '#lib/problems/ProblemsPanel.svelte';
    import ServiceState from '#lib/problems/ServiceState.svelte';
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
        // The page's theme is the one source of truth (the editor follows it by itself); the session mirrors it for the
        // chrome and the preview, whoever changes it.
        const themeObserver = new MutationObserver(() => (s.theme = readTheme()));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
            // Browser tests read the editor's state through this; nothing else does.
            if (navigator.webdriver) Reflect.set(window, '__papersTest', { editor: ed, session: s });
        });
        return () => {
            disposed = true;
            media.removeEventListener('change', onMedia);
            themeObserver.disconnect();
            ed?.dispose();
        };
    });

    // The editor follows the session.
    $effect(() => editor?.show(s.activeFile));
    $effect(() => editor?.setThreads(s.visibleThreads, s.activeThread));
    $effect(() => editor?.setSuggestMode(s.suggestMode));
    $effect(() => editor?.setPresence(s.presence, s.users));
    $effect(() => editor?.setMirror(s.mirror));
    $effect(() => editor?.setProjectPaths([...Object.keys(s.files), ...Object.keys(s.assets)]));
    $effect(() => editor?.setHover(s.hover));
    // The settled build's problems (language servers mark their own); notes only when the Problems panel shows them.
    $effect(() =>
        editor?.setDiagnostics(
            s.problems.filter((p) => p.sources.includes('build') && (p.severity !== 'info' || s.showNotes)).map((p) => ({ file: p.file, line: p.line, severity: p.severity, message: p.message })),
        ),
    );
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
    let lspStarts = $state(0);

    /** Starts tinymist in the frame and its client here. The status shown is the client's, told by the frame when the
     *  server fails (missing files, a crash), and "the preview frame cannot be reached" when the frame never said a word. */
    function startTypstServer(p: NonNullable<typeof preview>): void {
        // Disposing before the modules have loaded cancels the start: no server, no client.
        let cancelled = false;
        let c: { dispose(): void } | null = null;
        languageClient = {
            dispose: () => {
                cancelled = true;
                c?.dispose();
            },
        };
        s.languageServer = { status: 'starting', detail: '' };
        void Promise.all([import('#lib/lsp/client.ts'), import('#lib/lsp/tinymist.ts')]).then(([{ LanguageClient }, { tinymistProfile }]) => {
            if (cancelled) return;
            let client: InstanceType<typeof LanguageClient> | null = null;
            let heard = false;
            // The server first, then the client, whose first message (initialize) must find it.
            p.startServer(
                'tinymist',
                (m) => client?.receive(m as Parameters<InstanceType<typeof LanguageClient>['receive']>[0]),
                (status, detail) => {
                    heard = true;
                    if (status === 'failed') client?.fail(detail);
                },
                // A reloaded frame lost the server: a new client, whose initialize the new server answers.
                retryLanguageServer,
            );
            client = new LanguageClient('typst', 'tinymist', (m) => p.lspSend('tinymist', m), tinymistProfile(), (st) => {
                if (cancelled) return;
                if (st.status === 'unavailable') s.languageServer = { status: 'failed', detail: heard ? st.detail : 'the preview frame cannot be reached' };
                else s.languageServer = { status: st.status, detail: '' };
            }, (file, items) => s.setLanguageProblems('tinymist', file, items));
            c = client;
        });
    }

    /** Stops the Typst language server and starts it again. */
    function retryLanguageServer(): void {
        const p = preview;
        if (!p) return;
        languageClient?.dispose();
        languageClient = null;
        p.stopServer('tinymist');
        lspStarts++;
    }

    $effect(() => {
        void lspStarts;
        const p = preview;
        if (!editor || !p || languageClient || !Object.keys(s.files).some((f) => f.endsWith('.typ'))) return;
        startTypstServer(p);
    });
    onDestroy(() => languageClient?.dispose());

    // A repository's session: every file of the room bound to its model, and files others open bound as they come.
    $effect(() => {
        const ed = editor;
        if (!ed || !room) return;
        const files = room.files;
        for (const [path, text] of files) ed.bind(path, text);
        // Only paths that got a (new) text: edits inside a text do not reach this observer, and a deleted path has none.
        const onFiles = (e: { changes: { keys: Map<string, { action: 'add' | 'update' | 'delete' }> } }): void => {
            for (const [path, change] of e.changes.keys) {
                if (change.action === 'delete') continue;
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
        discussSuggestion(id, body) {
            const place = editor?.suggestionPlace(id);
            if (place) s.comment(place.file, place.quote, place.range, body);
        },
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
            // With the column: the preview flashes the word the cursor is in, where it can place it.
            preview?.show({ file: s.cursor.file, line: s.cursor.line, column: s.cursor.col });
            preview?.focus();
        }
    }

    /** A click in the preview: open its source at the word clicked, selected. */
    function onJump(at: SourcePoint, word: string | null): void {
        // The frame may point into files the build made (paper.bbl): only project files open.
        if (!(at.file in s.files)) return;
        if (narrow()) s.narrowPane = 'source';
        s.openFile(at.file);
        // A column from the frame is exact, to the character the click was on: the caret goes there.
        if (at.column !== undefined) {
            const column = at.column;
            setTimeout(() => editor?.reveal(at.file, at.line, column), 0);
            return;
        }
        // Only the line is known: the first place the clicked word appears on it.
        const text = editor?.lineText(at.file, at.line) ?? '';
        const i = word ? text.indexOf(word) : -1;
        const col = i >= 0 ? i + 1 : 1;
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
        { id: 'close-tab', name: 'Close tab', kbd: 'Ctrl+Alt+W', run: () => s.activeFile && s.closeTab(s.activeFile) },
        { id: 'new', name: 'New paper', run: () => location.assign('/new') },
        { id: 'suggest', name: s.suggestMode ? 'Stop suggesting' : 'Suggest edits', kbd: 'Ctrl+Alt+S', run: () => (s.suggestMode = !s.suggestMode) },
        { id: 'comment', name: 'Comment on selection', kbd: 'Ctrl+Alt+M', run: newComment },
        { id: 'jump', name: 'Jump to the other side', kbd: 'Ctrl+J', run: () => void jumpOther() },
        { id: 'outline', name: 'Outline', kbd: 'Ctrl+Shift+O', run: () => s.togglePanel('outline') },
        { id: 'files', name: 'Files', kbd: 'Ctrl+Shift+E', run: () => s.togglePanel('files') },
        { id: 'comments', name: 'Comments', kbd: 'Ctrl+Shift+M', run: () => s.togglePanel('comments') },
        { id: 'problems', name: 'Problems', kbd: 'Ctrl+Shift+Y', run: () => s.togglePanel('problems') },
        { id: 'problem-next', name: 'Next problem', kbd: 'F8', run: () => stepProblem(1) },
        { id: 'problem-prev', name: 'Previous problem', kbd: 'Shift+F8', run: () => stepProblem(-1) },
        { id: 'build-log', name: 'Show build log', run: showLog },
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
        if (k.key === 'F8' && !k.ctrl && !k.alt) return k.shift ? 'problem-prev' : 'problem-next';
        if (!k.ctrl) return null;
        if (!k.shift && !k.alt && key === 'k') return 'palette';
        if (k.shift && key === 'p') return 'palette';
        if (!k.shift && !k.alt && key === 's') return 'commit';
        if (k.alt && k.code === 'KeyS') return 'suggest';
        if (k.alt && k.code === 'KeyM') return 'comment';
        if (!k.shift && key === 'j') return 'jump';
        // Ctrl+W is the browser's own in most of them, which never pass it on; Ctrl+Alt+W always reaches the page.
        if (!k.shift && k.code === 'KeyW') return 'close-tab';
        if (k.shift && key === 'o') return 'outline';
        if (k.shift && key === 'e') return 'files';
        if (k.shift && key === 'm') return 'comments';
        if (k.shift && key === 'y') return 'problems';
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

    /** The tab list's keys: the arrows (and Home, End) move to another tab and open it; Delete closes the current one. */
    function onTabKey(e: KeyboardEvent): void {
        const tabs = s.tabs;
        const at = tabs.indexOf(s.activeFile);
        if (at < 0 || !tabs.length) return;
        let next: number;
        if (e.key === 'ArrowRight') next = (at + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        else if (e.key === 'Delete') {
            e.preventDefault();
            s.closeTab(s.activeFile);
            return;
        } else return;
        e.preventDefault();
        const f = tabs[next];
        if (f === undefined) return;
        s.activeFile = f;
        document.getElementById(`file-tab-${next}`)?.focus();
    }

    /** The shortcuts the content frame may forward: the frame runs untrusted content, so a forwarded key can only open
     *  or move things, never commit, accept, delete or change the document. */
    const FRAME_SAFE: ReadonlySet<string> = new Set(['palette', 'jump', 'outline', 'files', 'comments', 'zoomin', 'zoomout']);

    function onFrameKey(m: Extract<FrameMessage, { type: 'key' }>): void {
        const id = commandFor(m);
        if (id && FRAME_SAFE.has(id)) runKey(id);
        // Ctrl+S from the preview opens the commit popover; committing takes a key press in the app itself.
        else if (id === 'commit' && s.popover !== 'commit' && s.uncommitted) s.popover = 'commit';
    }

    function onMousedown(e: MouseEvent): void {
        if (s.popover && e.target instanceof Element && !e.target.closest('.popover, [data-popover-anchor]')) s.popover = null;
    }

    function onEscape(e: KeyboardEvent): void {
        if (e.key === 'Escape' && s.popover) s.popover = null;
    }

    const rail: readonly { id: 'outline' | 'files' | 'comments' | 'problems'; icon: IconName; name: string; kbd: string }[] = [
        { id: 'outline', icon: 'outline', name: 'Outline', kbd: 'Ctrl+Shift+O' },
        { id: 'files', icon: 'files', name: 'Files', kbd: 'Ctrl+Shift+E' },
        { id: 'comments', icon: 'comment', name: 'Comments', kbd: 'Ctrl+Shift+M' },
        { id: 'problems', icon: 'alert', name: 'Problems', kbd: 'Ctrl+Shift+Y' },
    ];

    /** Opens a problem's place in the source. */
    function openProblem(p: Problem): void {
        openFile(p.file, p.line, p.column ?? 1);
    }

    /** F8 / Shift+F8: the next or previous problem from the cursor, in document order. */
    function stepProblem(dir: 1 | -1): void {
        const p = nextProblem(s.problems, s.order, s.cursor.file, s.cursor.line, dir);
        if (p) openProblem(p);
    }

    function showLog(): void {
        s.showLog = true;
        s.panel = 'problems';
    }

    /** Problems by file, for the file list's marks. */
    const problemFiles = $derived.by(() => {
        const m = new Map<string, 'error' | 'warning'>();
        for (const p of s.problems) {
            if (p.severity === 'error') m.set(p.file, 'error');
            else if (p.severity === 'warning' && !m.has(p.file)) m.set(p.file, 'warning');
        }
        return m;
    });
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
                {#if r.id === 'problems' && s.problemCounts.error > 0}<span class="rail-badge rail-badge-error">{s.problemCounts.error}</span>
                {:else if r.id === 'problems' && s.problemCounts.warning > 0}<span class="rail-dot rail-dot-warning"></span>{/if}
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
                                {#if problemFiles.get(f) === 'error'}<span class="file-problem sev-error" {...tip('Errors')}><Icon name="alert" size={12} /></span>
                                {:else if problemFiles.get(f) === 'warning'}<span class="file-problem sev-warning" {...tip('Warnings')}><Icon name="warning" size={12} /></span>{/if}
                                {#if s.changes.some((c) => c.file === f)}<span class="mod" role="img" aria-label="uncommitted">M</span>{/if}
                            </button>
                        </li>
                    {/each}
                </ul>
            {:else if s.panel === 'problems'}
                <ProblemsPanel session={s} onOpen={openProblem} />
            {:else}
                {#await import('#lib/comments/CommentsPanel.svelte') then { default: CommentsPanel }}
                    <CommentsPanel {ops} />
                {/await}
            {/if}
        </aside>
    {/if}

    <section class="pane pane-source" aria-label="Source">
        <div class="yk-dock" role="tablist" tabindex="-1" aria-label="Open files" data-focused="" onkeydown={onTabKey}>
            {#each s.tabs as f, i (f)}
                {@const dirty = s.changes.some((c) => c.file === f)}
                <button
                    type="button"
                    role="tab"
                    id="file-tab-{i}"
                    class="yk-dock-tab"
                    aria-selected={f === s.activeFile}
                    aria-controls="file-panel"
                    tabindex={f === s.activeFile ? 0 : -1}
                    onclick={() => (s.activeFile = f)}
                    onauxclick={(e) => e.button === 1 && s.closeTab(f)}
                    {...tip(f, null, dirty ? 'uncommitted edits' : null)}
                >
                    {short(f)}
                    {#if dirty}<span class="tab-dot"></span>{/if}
                </button>
                <!-- A sibling of its tab, not inside it: a button may not hold another. Out of the tab order, like the tabs
                     the arrow keys reach; the keyboard closes with Ctrl+Alt+W. -->
                <button type="button" tabindex="-1" class="tab-x" onclick={() => s.closeTab(f)} {...tip(`Close ${short(f)}`, 'Ctrl+Alt+W')}>
                    <Icon name="x" size={12} />
                </button>
            {/each}
            <div class="yk-dock-actions">
                {#if s.languageServer && s.languageServer.status === 'starting'}
                    <span class="lsp-state" role="status" data-lsp="starting" {...tip('Typst language server', null, 'starting')}><span class="yk-spinner lsp-spin"></span></span>
                {:else if s.languageServer && s.languageServer.status === 'failed'}
                    <button type="button" class="lsp-state is-failed" data-lsp="failed" onclick={retryLanguageServer} {...tip('Typst language server', null, `${s.languageServer.detail} · retry`)}>
                        <Icon name="alert" size={13} />
                    </button>
                {/if}
                {#if s.suggestMode}
                    <span class="yk-chip yk-chip--violet" {...tip('Suggesting', 'Ctrl+Alt+S', 'your edits wait for review')}><Icon name="suggest" />Suggesting</span>
                {/if}
            </div>
        </div>
        <div class="editor-host-wrap" id="file-panel" role="tabpanel" aria-labelledby={s.tabs.includes(s.activeFile) ? `file-tab-${s.tabs.indexOf(s.activeFile)}` : undefined} aria-label={s.tabs.includes(s.activeFile) ? undefined : 'Editor'}>
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
            {#if s.problemCounts.error > 0}
                <button type="button" class="pv-count sev-error" onclick={() => (s.panel = 'problems')} {...tip('Problems', 'Ctrl+Shift+Y', `${s.problemCounts.error} ${s.problemCounts.error === 1 ? 'error' : 'errors'}`)}>
                    <Icon name="alert" size={13} />{s.problemCounts.error}
                </button>
            {/if}
            {#if s.problemCounts.warning > 0}
                <button type="button" class="pv-count sev-warning" onclick={() => (s.panel = 'problems')} {...tip('Problems', 'Ctrl+Shift+Y', `${s.problemCounts.warning} ${s.problemCounts.warning === 1 ? 'warning' : 'warnings'}`)}>
                    <Icon name="warning" size={13} />{s.problemCounts.warning}
                </button>
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
                <div class="popover pop-doc" role="dialog" {@attach keepInView} {@attach dialogFocus} aria-label="Document">
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
        <!-- The preview's states: a service failure fills it; errors list themselves at its top, over the last good PDF
             (dimmed, still scrollable and clickable) or, without one, filling it. -->
        <div class="pv-body" class:has-errors={!s.service && s.buildErrors.length > 0} class:no-pdf={s.service !== null || (s.buildErrors.length > 0 && s.shownBuild.pages === 0)}>
            {#if s.service}
                <ServiceState failure={s.service} onRetry={() => preview?.retry()} />
            {:else}
                <PreviewErrors session={s} onOpen={openProblem} onLog={showLog} />
            {/if}
            <Preview bind:this={preview} session={s} {contentOrigin} {onJump} {onAction} onKey={onFrameKey} />
        </div>
    </section>

    {#if s.palette}<Palette {commands} onClose={() => (s.palette = false)} />{/if}
    <TooltipLayer />
    {#if s.toast}
        {#key s.toast.key}
            <div class="yk-toast" role="status"><span>{s.toast.text}</span></div>
        {/key}
    {/if}
</div>
