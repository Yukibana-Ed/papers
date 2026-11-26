<script lang="ts">
    import type { FrameMessage, LanguageServer, PreviewMark, SelectionAction, SourceLines, SourcePoint } from '@yukibana/papers-frame-protocol';
    import type { Session } from '#lib/session.svelte.ts';
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

    function handle(m: FrameMessage): void {
        switch (m.type) {
            case 'built':
                session.build = {
                    status: 'idle',
                    ok: m.ok,
                    pages: m.pages,
                    ms: m.ms,
                    errors: m.diagnostics.filter((d) => d.severity === 'error').map((d) => ({ file: String(d.file), line: Number(d.line), message: String(d.message) })),
                };
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
                session.languageServer = { status: m.status, detail: m.detail ?? '' };
                break;
        }
    }

    function sendAll(): void {
        if (!client) return;
        sent = { ...session.files };
        client.send({ type: 'project', files: { ...session.assets, ...sent }, root: session.root, engine: engineOf(session.root) });
        client.send({ type: 'theme', dark: session.dark });
        client.send({ type: 'zoom', zoom: session.zoom });
        client.send({ type: 'builder', builder: session.builder === 'computer' ? 'external' : 'browser' });
    }

    $effect(() => {
        if (!frame) return;
        const c = new FrameClient(frame, contentOrigin, handle, sendAll);
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
        if (root) client?.send({ type: 'root', root, engine: engineOf(root) });
    });

    // The preview follows the cursor, gliding only when the spot is off-screen.
    $effect(() => {
        const c = session.cursor;
        if (c.file) client?.send({ type: 'reveal', at: { file: c.file, line: c.line, column: c.col }, mode: 'follow' });
    });

    $effect(() => {
        client?.send({ type: 'mirror', lines: $state.snapshot(session.selection) });
    });

    $effect(() => {
        const marks: PreviewMark[] = [];
        for (const t of session.visibleThreads) {
            const a = session.anchors[t.id];
            if (!a || t.root.resolved) continue;
            marks.push({ id: t.id, file: t.file, startLine: a.startLine, endLine: a.endLine, kind: t.id === session.activeThread ? 'active' : 'comment' });
        }
        for (const s of session.suggestions) marks.push({ id: s.id, file: s.file, startLine: s.line, endLine: s.line, kind: s.id === session.activeThread ? 'active' : 'suggestion' });
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

    /** Connects to `papers serve` with a paired token; the builder menu calls it. */
    export function connectComputer(token: string): void {
        runner?.close();
        runner = new RunnerClient(token, {
            ready: (info) => {
                session.computer = info;
                session.builder = 'computer';
            },
            status: () => (session.build = { ...session.build, status: 'compiling' }),
            built: (b) => {
                client?.send({ type: 'output', ok: b.ok, pdf: b.pdf, synctex: b.synctex, ms: b.ms, diagnostics: b.diagnostics.map((d) => ({ file: d.file ?? session.root, line: d.line ?? 1, severity: d.severity === 'error' ? 'error' : 'warning', message: d.message })) });
            },
            closed: (reason) => {
                runner = null;
                session.computer = null;
                session.builder = 'browser';
                session.flash(reason);
            },
        });
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

    export function focus(): void {
        frame?.focus();
    }

    // --- language servers, which run in the frame ------------------------------------------------------------------------

    const lspListeners = new Map<LanguageServer, (message: unknown) => void>();

    /** Starts `server` in the frame; its messages go to `listener`. */
    export function startServer(server: LanguageServer, listener: (message: unknown) => void): void {
        lspListeners.set(server, listener);
        client?.send({ type: 'lsp-start', server });
    }

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
