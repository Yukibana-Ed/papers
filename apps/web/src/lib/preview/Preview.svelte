<script lang="ts">
    import type { FrameMessage, LanguageServer, PreviewMark, SelectionAction, SourceLines, SourcePoint } from '@yukibana/papers-frame-protocol';
    import type { Session } from '#lib/session.svelte.ts';
    import { onDestroy } from 'svelte';
    import { RunnerClient } from '#lib/runner/client.ts';
    import { FrameClient } from './frame-client.ts';

    /** The preview: the content frame, fed with the session's files and told where the cursor is. Everything it
     *  says back is untrusted (it runs user content) and only ever used as positions and plain text. */
    let {
        session,
        contentOrigin,
        onJump,
        onAction,
        onKey,
    }: {
        session: Session;
        contentOrigin: string;
        onJump: (at: SourcePoint, word: string | null) => void;
        onAction: (action: SelectionAction, lines: SourceLines, text: string) => void;
        onKey: (m: Extract<FrameMessage, { type: 'key' }>) => void;
    } = $props();

    let frame = $state<HTMLIFrameElement | null>(null);
    let client: FrameClient | null = null;
    let sent: Record<string, string> = {};
    let centreWaiter: ((at: SourcePoint | null) => void) | null = null;

    function engineOf(root: string): 'pdflatex' | 'xelatex' | 'lualatex' | 'typst' {
        if (root.endsWith('.typ')) return 'typst';
        // fontspec and friends need a Unicode engine; everything else builds fastest with pdfTeX.
        return /\\usepackage(\[[^\]]*\])?\{(fontspec|unicode-math|polyglossia)\}/.test(session.files[root] ?? '') ? 'xelatex' : 'pdflatex';
    }

    // The engine reads the root file, so it is recomputed on every edit of it, but it changes (and with it the effect
    // that sends `root`) only when the root file's packages do.
    const engine = $derived(engineOf(session.root));

    function handle(m: FrameMessage): void {
        switch (m.type) {
            case 'built':
                session.acceptBuild({
                    status: 'idle',
                    ok: m.ok,
                    pages: m.pages,
                    ms: m.ms,
                    // From user content: only ever shown as text and used as positions.
                    diagnostics: m.diagnostics.map((d) => ({
                        file: String(d.file),
                        line: Number(d.line) || 1,
                        severity: d.severity === 'warning' ? 'warning' : d.severity === 'info' ? 'info' : 'error',
                        message: String(d.message),
                        ...(d.endLine === undefined ? {} : { endLine: Number(d.endLine) }),
                        ...(d.excerpt === undefined ? {} : { excerpt: String(d.excerpt) }),
                    })),
                    log: typeof m.log === 'string' ? m.log : '',
                });
                break;
            case 'service':
                session.service = m.failure === null ? null : { what: m.failure.what, detail: String(m.failure.detail) };
                break;
            case 'status':
                session.build = { ...session.build, status: m.status };
                break;
            case 'jump':
                onJump(m.at, m.word);
                break;
            case 'selection':
                session.mirror = m.lines;
                break;
            case 'action':
                onAction(m.action, m.lines, m.text);
                break;
            case 'centre':
                centreWaiter?.(m.at);
                centreWaiter = null;
                break;
            case 'scale':
                session.scale = m.scale;
                break;
            case 'key':
                onKey(m);
                break;
            case 'lsp':
                lspListeners.get(m.server)?.(m.message);
                break;
            case 'lsp-status':
                lspStatusListeners.get(m.server)?.(m.status, m.detail ?? '');
                break;
        }
    }

    /** The whole state, to a frame that has just connected; a reloaded one has lost its language servers too. */
    function sendAll(reconnected: boolean): void {
        if (!client) return;
        sent = { ...session.files };
        client.send({ type: 'project', files: { ...session.assets, ...sent }, root: session.root, engine });
        client.send({ type: 'theme', dark: session.dark });
        client.send({ type: 'zoom', zoom: session.zoom });
        client.send({ type: 'builder', builder: session.builder === 'computer' ? 'external' : 'browser' });
        if (reconnected) for (const lost of lspLostListeners.values()) lost();
    }

    /** For browser tests only: with `?test-frame` in the page's address, the build results come from
     *  `window.papersTestFrame(message)` instead of the frame, so tests can show each preview state without a TeX engine.
     *  Harmless otherwise: it only feeds this page what its own script could set anyway. */
    const testFrame = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test-frame');
    const fromFrame = (m: FrameMessage): void => {
        if (testFrame && (m.type === 'built' || m.type === 'service' || m.type === 'status')) return;
        handle(m);
    };
    if (testFrame) Object.assign(window, { papersTestFrame: handle });

    $effect(() => {
        if (!frame) return;
        const c = new FrameClient(frame, contentOrigin, fromFrame, sendAll);
        client = c;
        return () => {
            c.dispose();
            client = null;
        };
    });

    // Every edit, as the files that changed since the last message.
    $effect(() => {
        const now = session.files;
        const changes: { path: string; contents: string | null }[] = [];
        for (const [path, text] of Object.entries(now)) if (sent[path] !== text) changes.push({ path, contents: text });
        for (const path of Object.keys(sent)) if (!(path in now)) changes.push({ path, contents: null });
        if (!changes.length || !client) return;
        sent = { ...now };
        client.send({ type: 'files', changes });
    });

    $effect(() => {
        const root = session.root;
        const e = engine;
        if (root) client?.send({ type: 'root', root, engine: e });
    });

    // The preview follows the cursor, gliding only when the spot is off-screen.
    $effect(() => {
        const c = session.cursor;
        if (c.file) client?.send({ type: 'reveal', at: { file: c.file, line: c.line, column: c.col }, mode: 'follow' });
    });

    $effect(() => {
        const lines = $state.snapshot(session.selection);
        // A selection the source took from the preview is the preview's own already.
        if (session.selectionFrom === 'source') client?.send({ type: 'mirror', lines });
    });

    $effect(() => {
        const marks: PreviewMark[] = [];
        for (const t of session.visibleThreads) {
            const a = session.anchors[t.id];
            if (!a || t.root.resolved) continue;
            // With columns: the preview marks the commented words, not their lines, where it can place them.
            const kind = t.id === session.activeThread ? 'active' : 'comment';
            marks.push({ id: t.id, file: t.file, startLine: a.startLine, endLine: a.endLine, startColumn: a.startColumn, endColumn: a.endColumn, kind });
        }
        for (const s of session.suggestions) {
            const kind = s.id === session.activeThread ? 'active' : 'suggestion';
            // The struck text, when it is on one line (an insertion marks the word it is in).
            const oneLine = !s.oldText.includes('\n');
            const columns = oneLine ? { startColumn: s.col, endColumn: s.col + Math.max(1, s.oldText.length) } : {};
            marks.push({ id: s.id, file: s.file, startLine: s.line, endLine: s.line, ...columns, kind });
        }
        client?.send({ type: 'marks', marks });
    });

    $effect(() => {
        const list = session.presence.map((p) => {
            const u = session.users[p.user];
            return { user: p.user, file: p.file, line: p.line, initial: u?.initials.slice(0, 1) ?? '?', hue: u?.hue ?? 0 };
        });
        client?.send({ type: 'presence', presence: list });
    });

    $effect(() => {
        client?.send({ type: 'zoom', zoom: session.zoom });
    });

    $effect(() => {
        client?.send({ type: 'theme', dark: session.dark });
    });

    // --- Build on this computer ---------------------------------------------------------------------------------------

    let runner: RunnerClient | null = null;
    let runnerTimer = 0;
    onDestroy(() => {
        clearTimeout(runnerTimer);
        runner?.close();
        runner = null;
    });

    /** Connects to `papers serve` with a paired token; the builder menu calls it. */
    export function connectComputer(token: string): void {
        runner?.close();
        const r = new RunnerClient(token, {
            ready: (info) => {
                session.computer = info;
                session.builder = 'computer';
            },
            status: () => (session.build = { ...session.build, status: 'compiling' }),
            built: (b) => {
                client?.send({ type: 'output', ok: b.ok, pdf: b.pdf, synctex: b.synctex, ms: b.ms, diagnostics: b.diagnostics.map((d) => ({ file: d.file ?? session.root, line: d.line ?? 1, severity: d.severity, message: d.message })) });
            },
            closed: (reason) => {
                if (runner !== r) return;
                runner = null;
                session.computer = null;
                session.builder = 'browser';
                session.flash(reason);
            },
        });
        runner = r;
    }

    $effect(() => {
        client?.send({ type: 'builder', builder: session.builder === 'computer' ? 'external' : 'browser' });
    });

    // On this computer: the files and a build, shortly after every change.
    $effect(() => {
        if (session.builder !== 'computer') return;
        const files = { ...session.assets, ...session.files };
        const root = session.root;
        clearTimeout(runnerTimer);
        runnerTimer = window.setTimeout(() => {
            if (!runner || !root) return;
            session.build = { ...session.build, status: 'compiling' };
            runner.build(files, root);
        }, 400);
    });

    /** Asks the frame to start whatever failed to load again, and build. */
    export function retry(): void {
        session.service = null;
        client?.send({ type: 'retry' });
    }

    /** Shows `at`, always, with a flash. */
    export function show(at: SourcePoint): void {
        client?.send({ type: 'reveal', at, mode: 'jump' });
    }

    /** The source line in the middle of the preview, or null. */
    export function centre(): Promise<SourcePoint | null> {
        return new Promise((resolve) => {
            centreWaiter = resolve;
            client?.send({ type: 'centre?' });
            setTimeout(() => {
                if (centreWaiter === resolve) {
                    centreWaiter = null;
                    resolve(null);
                }
            }, 500);
        });
    }

    /** Moves the keyboard focus into the preview frame. */
    export function focus(): void {
        frame?.focus();
    }

    // --- language servers, which run in the frame ------------------------------------------------------------------------

    const lspListeners = new Map<LanguageServer, (message: unknown) => void>();
    const lspStatusListeners = new Map<LanguageServer, (status: 'starting' | 'ready' | 'failed', detail: string) => void>();
    const lspLostListeners = new Map<LanguageServer, () => void>();

    /** Starts `server` in the frame; its messages go to `listener`, what the frame says of it to `onStatus`, and
     *  `onLost` is called when the frame reloaded and the server is gone (the caller starts it again, client and all). */
    export function startServer(
        server: LanguageServer,
        listener: (message: unknown) => void,
        onStatus: (status: 'starting' | 'ready' | 'failed', detail: string) => void,
        onLost: () => void,
    ): void {
        lspListeners.set(server, listener);
        lspStatusListeners.set(server, onStatus);
        lspLostListeners.set(server, onLost);
        client?.send({ type: 'lsp-start', server });
    }

    /** Stops `server` in the frame, for a retry. */
    export function stopServer(server: LanguageServer): void {
        lspListeners.delete(server);
        lspStatusListeners.delete(server);
        lspLostListeners.delete(server);
        client?.send({ type: 'lsp-stop', server });
    }

    /** Sends `message` to `server` in the frame, queued until the frame has connected. */
    export function lspSend(server: LanguageServer, message: unknown): void {
        client?.send({ type: 'lsp', server, message });
    }
</script>

<iframe
    bind:this={frame}
    class="pv-frame"
    title="Preview"
    src="{contentOrigin}/frame"
    allow="cross-origin-isolated; clipboard-write"
    sandbox="allow-scripts allow-same-origin allow-downloads"
    referrerpolicy="no-referrer"
    data-pane="preview"
></iframe>
