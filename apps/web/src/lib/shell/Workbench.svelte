<script lang="ts">
    import { dialogFocus } from '#lib/ui/focus.ts';
    import { commandFor } from './commands.ts';
    import { keepInView } from '#lib/ui/place.ts';
    import { chooseTheme, readTheme } from '@yukibana/design/theme';
    import type { FrameMessage, SelectionAction, SourceLines, SourcePoint } from '@yukibana/papers-frame-protocol';
    import { onDestroy, onMount, untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { allFolders, foldersOf, treeRows } from '#lib/model/filetree.ts';
    import { sortPaths } from '#lib/project/load.ts';
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
    import { createDock, type Dock, type Front } from './dock.svelte.ts';
    import Header from './Header.svelte';
    import Palette from './Palette.svelte';

    /** The editor: header, rail and panels, source, preview. */
    let { session: s, contentOrigin, room = null }: { session: Session; contentOrigin: string; room?: RoomClient | null } = $props();

    let host = $state<HTMLDivElement | null>(null);
    let dockEl = $state<HTMLDivElement | null>(null);
    let dock = $state<Dock | null>(null);
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
        // The layout first: the editor is made in the part of it that `host` is.
        const made = dockEl === null ? null : createDock(dockEl, s, { editor: editorPart, preview: previewPart, fileTab, before, after });
        dock = made;
        void import('#lib/editor/source-editor.ts').then(({ SourceEditor }) => {
            if (disposed || !host) return;
            ed = new SourceEditor(host, s.files, s.activeFile, s.me, {
                change: (f, text) => s.edit(f, text),
                cursor: (c) => s.setCursor(c),
                selection: (sel) => {
                    s.selectionFrom = fromPreview ? 'preview' : 'source';
                    if (!fromPreview) previewSelected = false;
                    s.selection = sel;
                },
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
            made?.dispose();
        };
    });

    // The layout follows the session's tabs and the file in front.
    $effect(() => dock?.sync());

    // The editor follows the session.
    $effect(() => editor?.show(s.activeFile));
    $effect(() => editor?.setThreads(s.visibleThreads, s.activeThread));
    $effect(() => editor?.setSuggestMode(s.suggestMode));
    $effect(() => editor?.setReadOnly(s.readOnly));
    $effect(() => editor?.setPresence(s.presence, s.users));
    // One selection: text selected in the preview is the source editor's selection, and goes when the preview's does.
    $effect(() => {
        const lines = s.mirror;
        const ed = editor;
        if (!ed) return;
        untrack(() => {
            if (lines !== null && Object.hasOwn(s.files, lines.file)) {
                asPreview(() => ed.selectLines(lines, false));
                previewSelected = true;
            } else if (previewSelected) {
                previewSelected = false;
                asPreview(() => ed.collapseSelection());
            }
        });
    });
    $effect(() => editor?.setProjectPaths([...Object.keys(s.files), ...Object.keys(s.assets)]));
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
            client = new LanguageClient('typst', 'tinymist', (m) => p.lspSend('tinymist', m), tinymistProfile((path) => s.assets[path]), (st) => {
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
        // Only once Typst is in use (its document or a Typst file open): the server is 8.5 MB, which a LaTeX paper
        // would load for nothing on its first visit.
        if (!editor || !p || languageClient || !(s.root.endsWith('.typ') || s.activeFile.endsWith('.typ'))) return;
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
    /** The editor takes the keyboard a moment after a click in the preview has shown the source, unless the click
     *  became a double or triple click there (which selects in the preview, and must keep the focus to finish). */
    let focusAfterJump = 0;
    const JUMP_FOCUS_MS = 300;
    $effect(() => {
        if (s.mirror !== null) clearTimeout(focusAfterJump);
    });

    /** True while the editor's selection is being set from the preview: the editor's news of it says so. */
    let fromPreview = false;
    /** True while the editor's selection is the one made in the preview. */
    let previewSelected = false;
    function asPreview(run: () => void): void {
        fromPreview = true;
        try {
            run();
        } finally {
            fromPreview = false;
        }
    }

    function onJump(at: SourcePoint, word: string | null): void {
        // The frame may point into files the build made (paper.bbl): only project files open.
        if (!Object.hasOwn(s.files, at.file)) return;
        if (narrow()) s.narrowPane = 'source';
        s.openFile(at.file);
        clearTimeout(focusAfterJump);
        focusAfterJump = window.setTimeout(() => editor?.focus(), JUMP_FOCUS_MS);
        // A column from the frame is exact, to the character the click was on: the caret goes there at once.
        if (at.column !== undefined) {
            const column = at.column;
            // The click cleared the preview's own selection and highlight: the caret is not news to it.
            setTimeout(() => asPreview(() => editor?.reveal(at.file, at.line, column, { focus: false })), 0);
            return;
        }
        // Only the line is known: the first place the clicked word appears on it.
        const text = editor?.lineText(at.file, at.line) ?? '';
        const i = word ? text.indexOf(word) : -1;
        const col = i >= 0 ? i + 1 : 1;
        setTimeout(() => {
            if (word && i >= 0) editor?.reveal(at.file, at.line, col, { focus: false, select: { startLineNumber: at.line, startColumn: col, endLineNumber: at.line, endColumn: col + word.length } });
            else editor?.reveal(at.file, at.line, col, { focus: false });
        }, 0);
    }

    /** The preview selection's toolbar. */
    function onAction(action: SelectionAction, lines: SourceLines, text: string): void {
        if (!Object.hasOwn(s.files, lines.file)) return;
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
        { id: 'commit', name: 'Commit', kbd: 'Ctrl+S', run: () => void (s.readOnly || (s.popover = 'commit')) },
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

    const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

    function runKey(id: string): void {
        if (id === 'palette') s.palette = !s.palette;
        else if (id === 'commit') {
            if (s.popover === 'commit') void s.commit();
            else if (s.uncommitted && !s.readOnly) s.popover = 'commit';
        } else commands.find((c) => c.id === id)?.run();
    }

    function onKeydown(e: KeyboardEvent): void {
        // AltGr is Ctrl+Alt to the browser on Windows: it types a character, it is no shortcut.
        if (e.getModifierState('AltGraph')) return;
        const id = commandFor({ key: e.key, code: e.code, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, mac: MAC });
        if (!id) return;
        // In a comment's editor Ctrl+K makes a link; the palette is Ctrl+Shift+P there.
        if (id === 'palette' && !e.shiftKey && e.target instanceof Element && e.target.closest('.ProseMirror')) return;
        e.preventDefault();
        e.stopPropagation();
        runKey(id);
    }

    /** The shortcuts the content frame may forward: the frame runs untrusted content, so a forwarded key can only open
     *  or move things, never commit, accept, delete or change the document. */
    const FRAME_SAFE: ReadonlySet<string> = new Set(['palette', 'jump', 'outline', 'files', 'comments', 'zoomin', 'zoomout']);

    function onFrameKey(m: Extract<FrameMessage, { type: 'key' }>): void {
        const id = commandFor({ ...m, mac: MAC });
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

    // --- the file list: folders open and close ------------------------------------------------------------------------
    /** Every file the list shows: all of the repository's, those the editor does not open too. */
    const listed = $derived([...new Set([...s.order, ...Object.keys(s.unread), ...s.otherFiles])].toSorted(sortPaths));
    /** The closed folders, kept per project in this browser. Until one is toggled, a large project has its folders
     *  closed and a small one has them open. */
    const foldersKey = untrack(() => `papers.folders.${s.repo.owner}/${s.repo.name}`);
    function keptFolders(): string[] | null {
        try {
            const kept: unknown = JSON.parse(localStorage.getItem(foldersKey) ?? 'null');
            return Array.isArray(kept) ? kept.filter((k): k is string => typeof k === 'string') : null;
        } catch {
            return null;
        }
    }
    const closedFolders = new SvelteSet<string>(untrack(() => keptFolders() ?? (listed.length > 40 ? allFolders(listed) : [])));
    const fileRows = $derived(treeRows(listed, closedFolders));
    // The folders of the file in the editor are open: the list always shows where one is.
    $effect(() => {
        for (const folder of foldersOf(s.activeFile)) closedFolders.delete(folder);
    });
    function setFolder(path: string, open: boolean): void {
        if (open) closedFolders.delete(path);
        else closedFolders.add(path);
        try {
            localStorage.setItem(foldersKey, JSON.stringify([...closedFolders]));
        } catch {
            // Without storage the folders are as they are until the page is left.
        }
    }
    /** The list by the keyboard, as a tree: Up and Down move between rows, Left closes a folder and Right opens it. */
    function onFilesKey(e: KeyboardEvent): void {
        const row = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('.row-btn') : null;
        const list = row?.closest('.filelist');
        if (row === null || list == null || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const rows = [...list.querySelectorAll<HTMLElement>('button.row-btn')];
            rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && row.dataset['folder'] !== undefined) setFolder(row.dataset['folder'], e.key === 'ArrowRight');
        else return;
        e.preventDefault();
    }
    /** The worst problem in the files of `folder`, which a closed folder shows for them. */
    function folderProblem(folder: string): 'error' | 'warning' | undefined {
        let worst: 'error' | 'warning' | undefined;
        for (const [file, severity] of problemFiles) {
            if (!file.startsWith(`${folder}/`)) continue;
            if (severity === 'error') return 'error';
            if (severity === 'warning') worst = 'warning';
        }
        return worst;
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

{#snippet fileTab(f: string)}
    {@const dirty = s.changes.some((c) => c.file === f)}
    <!-- Out of the tab order, like the tab itself (the dock's keys reach it); the keyboard closes with Ctrl+Alt+W. -->
    <span class="file-tab" role="presentation" data-file={f} onauxclick={(e) => e.button === 1 && s.closeTab(f)} {...tip(f, null, dirty ? 'uncommitted edits' : null)}>
        <span class="file-tab-name">{short(f)}</span>
        {#if dirty}<span class="tab-dot"></span>{/if}
    </span>
    <button
        type="button"
        tabindex="-1"
        class="tab-x"
        onpointerdown={(e) => e.stopPropagation()}
        onmousedown={(e) => e.stopPropagation()}
        onclick={(e) => {
            e.stopPropagation();
            s.closeTab(f);
        }}
        {...tip(`Close ${short(f)}`, 'Ctrl+Alt+W')}
    >
        <Icon name="x" size={12} />
    </button>
{/snippet}

{#snippet editorPart(_: null)}
    <div class="editor-host-wrap">
        <div class="editor-host" bind:this={host}></div>
        {#if selButton !== null}
            <button type="button" class="sel-comment yk-icon-btn" style:top="{selButton}px" onmousedown={(e) => e.preventDefault()} onclick={newComment} {...tip('Comment', 'Ctrl+Alt+M', null, 'right')}>
                <Icon name="comment" />
            </button>
        {/if}
    </div>
{/snippet}

{#snippet before(front: Front)}
    {#if front === 'preview'}
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
    {/if}
{/snippet}

{#snippet after(front: Front)}
    {#if front === 'preview'}
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
    {:else if front === 'file'}
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
    {/if}
{/snippet}

{#snippet previewPart(_: null)}
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
{/snippet}

<svelte:window onkeydowncapture={onKeydown} onmousedown={onMousedown} onkeydown={onEscape} />

<div class="app narrow-{s.narrowPane}" class:rail-open={s.panel !== null}>
    <Header
        session={s}
        onOpenFile={(f) => openFile(f)}
        onGoTo={(f, line, col) => openFile(f, line, col)}
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
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <ul class="filelist" onkeydown={onFilesKey}>
                    {#each fileRows as row (`${row.kind}:${row.path}`)}
                        {#if row.kind === 'folder'}
                            {@const worst = row.open ? undefined : folderProblem(row.path)}
                            <li>
                                <button
                                    type="button"
                                    class="row-btn folder"
                                    class:is-closed={!row.open}
                                    aria-expanded={row.open}
                                    style:padding-left="{10 + row.depth * 14}px"
                                    data-folder={row.path}
                                    onclick={() => setFolder(row.path, !row.open)}
                                    {...tip(row.path)}
                                >
                                    <Icon name="chevron" size={14} />
                                    <span>{row.name}</span>
                                    <span class="grow"></span>
                                    {#if worst === 'error'}<span class="file-problem sev-error" {...tip('Errors')}><Icon name="alert" size={12} /></span>
                                    {:else if worst === 'warning'}<span class="file-problem sev-warning" {...tip('Warnings')}><Icon name="warning" size={12} /></span>{/if}
                                </button>
                            </li>
                        {:else if s.files[row.path] === undefined}
                            {@const why = s.unread[row.path]}
                            <li>
                                <span class="row-btn is-unread" style:padding-left="{10 + row.depth * 14}px" {...tip(row.path, null, why === undefined ? 'not text' : `not loaded: ${why}`)}>
                                    <Icon name="files" size={14} />
                                    <span>{row.name}</span>
                                </span>
                            </li>
                        {:else}
                            {@const f = row.path}
                            {@const isRoot = s.roots.includes(f)}
                            <li>
                                <button
                                    type="button"
                                    class="row-btn"
                                    class:is-current={f === s.activeFile}
                                    style:padding-left="{10 + row.depth * 14}px"
                                    onclick={() => openFile(f)}
                                    {...isRoot ? tip(f, null, 'compiles by itself') : tip(f)}
                                >
                                    <Icon name={isRoot ? 'doc' : 'files'} size={14} />
                                    <span class:strong={row.depth === 0}>{row.name}</span>
                                    <span class="grow"></span>
                                    {#if problemFiles.get(f) === 'error'}<span class="file-problem sev-error" {...tip('Errors')}><Icon name="alert" size={12} /></span>
                                    {:else if problemFiles.get(f) === 'warning'}<span class="file-problem sev-warning" {...tip('Warnings')}><Icon name="warning" size={12} /></span>{/if}
                                    {#if s.changes.some((c) => c.file === f)}<span class="mod" role="img" aria-label="uncommitted">M</span>{/if}
                                </button>
                            </li>
                        {/if}
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

    <div class="dock" bind:this={dockEl}></div>

    {#if s.palette}<Palette {commands} onClose={() => (s.palette = false)} />{/if}
    <TooltipLayer />
    {#if s.toast}
        {#key s.toast.key}
            <div class="yk-toast" role="status"><span>{s.toast.text}</span></div>
        {/key}
    {/if}
</div>
