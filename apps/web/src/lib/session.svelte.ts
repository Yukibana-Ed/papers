import { changedLines } from '#lib/model/diff.ts';
import { findRoots, includedFiles, outline, type Heading } from '#lib/model/tex.ts';
import { addReply, findComment, setResolved } from '#lib/model/threads.ts';
import type { Anchor, Branch, Commit, Cursor, Lines, PlacedSuggestion, Presence, Thread, User } from '#lib/model/types.ts';

/** The data a session starts from: a repository at a branch, and its room. */
export interface SessionSeed {
    readonly repo: { readonly owner: string; readonly name: string };
    readonly me: string;
    readonly users: Readonly<Record<string, User>>;
    readonly files: Readonly<Record<string, string>>;
    readonly order: readonly string[];
    /** The files as last committed. */
    readonly base: Readonly<Record<string, string>>;
    readonly branches: Readonly<Record<string, Branch>>;
    readonly branch: string;
    readonly commits: readonly Commit[];
    readonly threads: readonly Thread[];
    readonly presence: readonly Presence[];
    /** Build inputs that are not text (images, fonts), for the compiler only. */
    readonly assets?: Readonly<Record<string, Uint8Array>>;
}

/** What a repository's session does that the demo does not. */
export interface SessionBackend {
    /** Commits `changes` as the user with `message` and returns the new commit's SHA; throws with a message to show
     *  when GitHub refuses. */
    commit(message: string, changes: readonly { path: string; text: string | null }[]): Promise<string>;
}

export interface FileChange {
    readonly file: string;
    readonly add: number;
    readonly del: number;
}

export type Panel = 'outline' | 'files' | 'comments';
export type Popover = 'commit' | 'log' | 'branch' | 'doc' | 'builder' | null;
export type ThemeChoice = 'light' | 'dark' | 'system';

export interface BuildState {
    readonly status: 'loading' | 'compiling' | 'idle';
    readonly ok: boolean;
    readonly pages: number;
    readonly ms: number;
    readonly errors: readonly { readonly file: string; readonly line: number; readonly message: string }[];
}

const short = (f: string): string => f.split('/').pop() ?? f;
const hex7 = (): string => Math.random().toString(16).slice(2, 9).padEnd(7, '0');

/** One user's session of a project: the files as the room has them, what is committed, the comments, and the state
 *  of the editor's chrome. Everything here is reactive; the components read it and call its methods. */
export class Session {
    get repo(): SessionSeed['repo'] {
        return this.seed.repo;
    }
    get me(): string {
        return this.seed.me;
    }
    get users(): Readonly<Record<string, User>> {
        return this.seed.users;
    }
    /** The project's files in the order the file list shows them. */
    get order(): readonly string[] {
        return this.seed.order;
    }
    get assets(): Readonly<Record<string, Uint8Array>> {
        return this.seed.assets ?? {};
    }

    files = $state<Record<string, string>>({});
    base = $state<Record<string, string>>({});
    branches = $state<Record<string, Branch>>({});
    branch = $state('main');
    commits = $state<Commit[]>([]);
    threads = $state<Thread[]>([]);
    presence = $state<Presence[]>([]);

    tabs = $state<string[]>([]);
    activeFile = $state('');
    cursor = $state<Cursor>({ file: '', line: 1, col: 1 });
    selection = $state<Lines | null>(null);
    /** The lines of a selection made in the preview, mirrored in the source. */
    mirror = $state<Lines | null>(null);
    anchors = $state<Record<string, Anchor>>({});
    suggestions = $state<PlacedSuggestion[]>([]);
    activeThread = $state<string | null>(null);
    suggestMode = $state(false);
    panel = $state<Panel | null>(null);
    popover = $state<Popover>(null);
    palette = $state(false);
    theme = $state<ThemeChoice>('system');
    pinnedRoot = $state<string | null>(null);
    zoom = $state(1);
    scale = $state(1);
    build = $state<BuildState>({ status: 'loading', ok: true, pages: 0, ms: 0, errors: [] });
    commitMessage = $state('');
    justCommitted = $state(false);
    incoming = $state(0);
    /** Who builds the preview: this tab (BusyTeX in the content frame) or this computer (`papers serve`, paired
     *  explicitly; never detected). */
    builder = $state<'browser' | 'computer'>('browser');
    /** What `papers serve` builds with, once paired. */
    computer = $state<{ sandbox: string; toolchain: string } | null>(null);
    narrowPane = $state<'source' | 'preview'>('source');
    commentFilter = $state<'all' | 'team' | 'github'>('all');
    showResolved = $state(false);
    toast = $state<{ text: string; key: number } | null>(null);
    /** The file whose root was last compiled, kept when the active file belongs to no document. */
    private lastRoot = $state('');

    constructor(private readonly seed: SessionSeed) {
        this.files = { ...seed.files };
        this.base = { ...seed.base };
        this.branches = { ...seed.branches };
        this.branch = seed.branch;
        this.commits = [...seed.commits];
        this.threads = [...seed.threads];
        this.presence = [...seed.presence];
        const roots = findRoots(seed.files, seed.order);
        const first = roots[0] ?? seed.order[0] ?? '';
        const second = includedFiles(first, seed.files)[1] ?? first;
        this.tabs = second === first ? [first] : [first, second];
        this.activeFile = second;
        this.cursor = { file: second, line: 1, col: 1 };
        this.lastRoot = first;
    }

    // --- derived ---------------------------------------------------------------------------------------------------------

    roots = $derived(findRoots(this.files, this.order));
    includes = $derived(Object.fromEntries(this.roots.map(r => [r, includedFiles(r, this.files)])) as Record<string, string[]>);

    /** The document the preview shows: the pinned one, else the one the active file belongs to, else the last one. */
    root = $derived.by(() => {
        if (this.pinnedRoot !== null) return this.pinnedRoot;
        if (this.roots.includes(this.activeFile)) return this.activeFile;
        return this.roots.find(r => this.includes[r]?.includes(this.activeFile)) ?? (this.lastRoot || (this.roots[0] ?? ''));
    });

    headings = $derived<Heading[]>(this.root ? outline(this.root, this.files) : []);

    currentHeading = $derived.by(() => {
        const order = this.includes[this.root] ?? [];
        const rank = (f: string, l: number): number => order.indexOf(f) * 1e6 + l;
        if (!order.includes(this.cursor.file)) return null;
        const at = rank(this.cursor.file, this.cursor.line);
        let best: Heading | null = null;
        for (const h of this.headings) if (rank(h.file, h.line) <= at) best = h;
        return best;
    });

    changes = $derived.by((): FileChange[] => {
        const out: FileChange[] = [];
        for (const f of this.order) {
            const a = this.base[f] ?? '';
            const b = this.files[f] ?? '';
            if (a !== b) out.push({ file: f, ...changedLines(a, b) });
        }
        return out;
    });

    uncommitted = $derived(this.changes.reduce((n, c) => n + Math.max(c.add, c.del), 0));
    defaultCommitMessage = $derived(this.changes.length ? `Update ${this.changes.map(c => short(c.file)).join(', ')}` : '');
    currentBranch = $derived(this.branches[this.branch] ?? { name: this.branch, users: [], pr: null });
    pr = $derived(this.currentBranch.pr);
    head = $derived(this.commits[0] ?? { hash: '0000000', author: '', when: '', msg: '' });
    others = $derived(this.currentBranch.users.filter(u => u !== this.me));

    /** Threads of this branch: the room's, and the pull request's review threads when there is one. */
    visibleThreads = $derived(this.threads.filter(t => t.source !== 'github' || (t.branch === this.branch && this.pr !== null)));
    openCount = $derived(this.visibleThreads.filter(t => !t.root.resolved && !t.draft).length + this.suggestions.length);
    resolvedCount = $derived(this.visibleThreads.filter(t => t.root.resolved).length);

    /** The comments panel's items, in document order. */
    items = $derived.by(() => {
        const pos = (file: string, line = 0, col = 0): number => this.order.indexOf(file) * 1e6 + line * 1e3 + col;
        const threads = this.visibleThreads
            .filter(t => this.commentFilter === 'all' || (this.commentFilter === 'github' ? t.source === 'github' : t.source === 'team'))
            .filter(t => this.showResolved || !t.root.resolved || t.id === this.activeThread)
            .map(t => ({ kind: 'thread' as const, id: t.id, file: t.file, thread: t, pos: pos(t.file, this.anchors[t.id]?.startLine, this.anchors[t.id]?.startColumn) }));
        const suggs =
            this.commentFilter === 'github'
                ? []
                : this.suggestions.map(s => ({ kind: 'suggestion' as const, id: s.id, file: s.file, suggestion: s, pos: pos(s.file, s.line, s.col) }));
        return [...threads, ...suggs].toSorted((a, b) => a.pos - b.pos);
    });

    branchNames = $derived(Object.keys(this.branches));
    /** Whether the system asks for dark; the workbench keeps it current. */
    systemDark = $state(false);
    dark = $derived(this.theme === 'dark' || (this.theme === 'system' && this.systemDark));

    // --- actions -------------------------------------------------------------------------------------------------------

    flash(text: string): void {
        this.toast = { text, key: Date.now() };
        const key = this.toast.key;
        setTimeout(() => {
            if (this.toast?.key === key) this.toast = null;
        }, 3000);
    }

    edit(file: string, text: string): void {
        this.files[file] = text;
    }

    openFile(file: string): void {
        if (!this.tabs.includes(file)) this.tabs.push(file);
        this.activeFile = file;
    }

    closeTab(file: string): void {
        if (this.tabs.length === 1) return;
        const i = this.tabs.indexOf(file);
        if (i < 0) return;
        this.tabs.splice(i, 1);
        if (this.activeFile === file) this.activeFile = this.tabs[Math.min(i, this.tabs.length - 1)] ?? this.tabs[0] ?? file;
    }

    setCursor(c: Cursor): void {
        this.cursor = c;
        this.mirror = null;
        if (this.root) this.lastRoot = this.root;
    }

    togglePanel(p: Panel): void {
        this.panel = this.panel === p ? null : p;
    }

    togglePopover(p: Exclude<Popover, null>): void {
        this.popover = this.popover === p ? null : p;
    }

    /** Commits every uncommitted change with the message typed, or the default one. */
    /** Commits every uncommitted change with the message typed, or the default one: through `backend` when the
     *  session is a repository's, else locally (the demo). A refused commit leaves everything uncommitted. */
    async commit(): Promise<void> {
        if (!this.uncommitted || this.committing) return;
        const msg = this.commitMessage.trim() || this.defaultCommitMessage;
        const changes = this.changes.map(c => ({ path: c.file, text: this.files[c.file] ?? null }));
        this.committing = true;
        try {
            const hash = this.backend ? await this.backend.commit(msg, changes) : hex7();
            this.commits.unshift({ hash: hash.slice(0, 7), author: this.me, when: 'just now', msg });
            this.base = { ...this.base, ...Object.fromEntries(changes.map(c => [c.path, c.text ?? ''])) };
            this.commitMessage = '';
            this.popover = null;
            this.justCommitted = true;
            setTimeout(() => (this.justCommitted = false), 2000);
        } catch (e) {
            this.flash(e instanceof Error ? e.message : 'Commit failed');
        } finally {
            this.committing = false;
        }
    }

    /** Where commits go for a repository's session; null in the demo. */
    backend: SessionBackend | null = null;
    committing = $state(false);

    switchBranch(name: string): void {
        this.branch = name;
        this.popover = null;
        this.flash(`On ${name}`);
    }

    newBranch(name: string): void {
        if (!name || this.branches[name]) return;
        this.branches[name] = { name, users: [this.me], pr: null };
        this.switchBranch(name);
    }

    /** Starts a draft thread on `quote` in `file`, and opens the comments panel on it. */
    startThread(file: string, quote: string, range: Thread['range']): void {
        const id = `n${hex7()}`;
        const q = quote.length > 80 ? `${quote.slice(0, 80)}…` : quote;
        this.threads.push({
            id,
            source: 'team',
            file,
            quote: q,
            ...(range ? { range } : {}),
            draft: true,
            root: { id: `${id}r`, author: this.me, when: 'now', resolved: false, body: '', replies: [] },
        });
        this.activeThread = id;
        this.panel = 'comments';
    }

    private updateThread(id: string, fn: (t: Thread) => Thread): void {
        const i = this.threads.findIndex(t => t.id === id);
        const t = this.threads[i];
        if (t) this.threads[i] = fn(t);
    }

    resolve(threadId: string, commentId: string, resolved: boolean): void {
        this.updateThread(threadId, t => ({ ...t, root: setResolved(t.root, commentId, resolved) }));
    }

    reply(threadId: string, commentId: string, body: string): void {
        this.updateThread(threadId, t => ({ ...t, root: addReply(t.root, commentId, { id: hex7(), author: this.me, when: 'now', resolved: false, body, replies: [] }) }));
    }

    post(threadId: string, body: string, target: 'team' | 'github'): void {
        this.updateThread(threadId, t => {
            const { draft: _, ...rest } = t;
            return { ...rest, source: target, branch: this.branch, root: { ...t.root, body } };
        });
    }

    cancelDraft(threadId: string): void {
        this.threads = this.threads.filter(t => t.id !== threadId);
        if (this.activeThread === threadId) this.activeThread = null;
    }

    /** The replacement a comment offers, or null. */
    replacementOf(threadId: string, commentId: string): string | null {
        const t = this.threads.find(x => x.id === threadId);
        return (t && findComment(t.root, commentId)?.replacement) ?? null;
    }

    /** After the editor applied a comment's replacement: the thread's quote is the new text, the comment resolved. */
    replacementAccepted(threadId: string, commentId: string, text: string): void {
        this.updateThread(threadId, t => ({ ...t, quote: text, root: setResolved(t.root, commentId, true) }));
    }

    zoomBy(delta: number): void {
        this.zoom = Math.min(2, Math.max(0.5, Math.round((this.zoom + delta) * 10) / 10));
    }
}
