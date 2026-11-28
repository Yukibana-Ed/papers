import { findRoots, includedFiles, outline, type Heading } from '#lib/model/tex.ts';
import { addReply, findComment, setResolved } from '#lib/model/threads.ts';
import type { Anchor, Branch, Commit, Cursor, Lines, PlacedSuggestion, Presence, Thread, User } from '#lib/model/types.ts';
import { committedText, revertedText, reviewFile, textRuns, type FileReview } from '#lib/review/model.ts';
import type { ReviewSource } from '#lib/review/source.svelte.ts';
import { countProblems, mergeProblems, type Problem, type ProblemSource, type Reported } from '#lib/problems/model.ts';

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
    /** What the user may do in the repository (write when absent): with `comment`, the source cannot be edited. */
    readonly access?: 'write' | 'comment';
    /** Files of the repository that were not loaded (too large, over the project's limit): path → why, as a clause. */
    readonly unread?: Readonly<Record<string, string>>;
    /** The repository's other files, which the file list shows but the editor does not open: images and fonts (loaded
     *  for the build) and files no build reads. */
    readonly otherFiles?: readonly string[];
}

/** A file as one commit leaves it: its text, and the ids of its characters in the room (an encoded `IdSet`, empty
 *  when not known). */
export interface CommittedFile {
    readonly path: string;
    readonly text: string;
    readonly items: string;
}

/** What a repository's session does that the demo does not. */
export interface SessionBackend {
    /** Commits `files` as the user with `message` and returns the new commit's SHA; throws with a message to show
     *  when GitHub refuses. `coAuthors` (logins, never the user) get a `Co-authored-by` trailer each. */
    commit(message: string, files: readonly CommittedFile[], coAuthors: readonly string[]): Promise<string>;
}

export interface FileChange {
    readonly file: string;
    readonly add: number;
    readonly del: number;
    /** A file new since the commit, one gone since, or one changed. */
    readonly kind: 'added' | 'deleted' | 'modified';
}

export type Panel = 'outline' | 'files' | 'comments' | 'problems';
export type Popover = 'commit' | 'log' | 'branch' | 'doc' | 'builder' | null;
export type ThemeChoice = 'light' | 'dark' | 'system';

export interface BuildState {
    readonly status: 'loading' | 'compiling' | 'idle';
    readonly ok: boolean;
    /** Pages on screen: the last good build's when this one failed. */
    readonly pages: number;
    readonly ms: number;
    /** What the build reported. */
    readonly diagnostics: readonly Reported[];
    /** The engine's log, for "Show log". */
    readonly log: string;
}

/** A part of the build service that could not start (the frame's `service` message): not a problem with the paper. */
export interface ServiceState {
    readonly what: 'tex-engine' | 'typst-compiler' | 'texlive';
    readonly detail: string;
}

/** How long after the last keystroke a failed build may show its errors: never while someone is mid-word. */
export const SETTLE_MS = 900;

/** How long to wait before showing a build's errors, given the last edit at `lastEdit` and the time `now`. */
export function settleDelay(lastEdit: number, now: number, settle = SETTLE_MS): number {
    return Math.max(0, lastEdit + settle - now);
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
    /** The project's files in the order the file list shows them. */
    get order(): readonly string[] {
        return this.seed.order;
    }
    /** The repository's files that were not loaded: path → why. */
    get unread(): Readonly<Record<string, string>> {
        return this.seed.unread ?? {};
    }
    /** The repository's files that are listed but not opened here (`SessionSeed.otherFiles`). */
    get otherFiles(): readonly string[] {
        return this.seed.otherFiles ?? [];
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
    /** Everyone the session has met, by id: the seed's users, and whoever joined since (`meet`). */
    users = $state<Record<string, User>>({});
    /** Who is here now, once each, in the order they came: the others, and the user too while they have this branch
     *  open in another window. */
    present = $derived([...new Set(this.presence.map(p => p.user))]);

    tabs = $state<string[]>([]);
    activeFile = $state('');
    cursor = $state<Cursor>({ file: '', line: 1, col: 1 });
    /** The one selection, as the source editor holds it: made there, or taken from the preview (`selectionFrom`). */
    selection = $state<Lines | null>(null);
    /** Where `selection` was made. The preview is sent only a selection made in the source: it shows its own. */
    selectionFrom: 'source' | 'preview' = 'source';
    /** Where the cursor was last put from: in the source, or by a click or a selection in the preview. */
    cursorFrom: 'source' | 'preview' = 'source';
    /** The source lines of the text selected in the preview, which the source editor takes as its selection; null
     *  when nothing is selected there. */
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
    /** The latest build, as the frame reported it. */
    build = $state<BuildState>({ status: 'loading', ok: true, pages: 0, ms: 0, diagnostics: [], log: '' });
    /** The build whose problems are shown: the latest one once it has settled (see `acceptBuild`). */
    shownBuild = $state<BuildState>({ status: 'idle', ok: true, pages: 0, ms: 0, diagnostics: [], log: '' });
    /** A part of the build service that could not start, or null. */
    service = $state<ServiceState | null>(null);
    /** What the language servers report, by server, then file. */
    languageProblems = $state<Partial<Record<ProblemSource, Record<string, readonly Reported[]>>>>({});
    /** Whether the Problems panel lists notes (over- and underfull boxes). */
    showNotes = $state(false);
    /** Whether the Problems panel shows the build's log. */
    showLog = $state(false);
    #lastEdit = 0;
    #settleTimer = 0;
    commitMessage = $state('');
    justCommitted = $state(false);
    /** Who builds the preview: this tab (BusyTeX in the content frame) or this computer (`papers serve`, paired
     *  explicitly; never detected). */
    builder = $state<'browser' | 'computer'>('browser');
    /** The Typst language server's state, for the editor's status; null until a Typst file is open. */
    languageServer = $state<{ status: 'starting' | 'ready' | 'failed'; detail: string } | null>(null);
    /** What `papers serve` builds with, once paired. */
    computer = $state<{ sandbox: string; toolchain: string } | null>(null);
    /** How the session reaches the room: `live`, `batched` (the room asked for fewer messages), `paused` (the room's
     *  daily budget is spent; edits stay here until it is live again), `offline` (no connection; edits wait). Always
     *  `live` in the demo. */
    sync = $state<'live' | 'batched' | 'paused' | 'offline'>('live');
    narrowPane = $state<'source' | 'preview'>('source');
    commentFilter = $state<'all' | 'team' | 'github'>('all');
    showResolved = $state(false);
    toast = $state<{ text: string; key: number } | null>(null);
    /** The file whose root was last compiled, kept when the active file belongs to no document. */
    private lastRoot = $state('');

    /** Whether the user may only read and comment: no edits, suggestions or commits. */
    readonly readOnly: boolean;

    constructor(private readonly seed: SessionSeed) {
        this.readOnly = seed.access === 'comment';
        this.files = { ...seed.files };
        this.base = { ...seed.base };
        this.branches = { ...seed.branches };
        this.branch = seed.branch;
        this.commits = [...seed.commits];
        this.threads = [...seed.threads];
        this.presence = [...seed.presence];
        this.users = { ...seed.users };
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

    /** Where the commit review reads characters' ids and authors from: the room's documents (or the demo's). Null
     *  without one: texts are compared by lines, and every change counts as the user's. */
    source = $state.raw<ReviewSource | null>(null);
    #reviewCache = new Map<string, { base: string; now: string; version: number; review: FileReview }>();

    /** What changed in each file since its commit, in the file list's order; only files with something to show. */
    reviews = $derived.by((): ReadonlyMap<string, FileReview> => {
        const out = new Map<string, FileReview>();
        const source = this.source;
        const version = source?.version ?? 0;
        for (const f of this.order) {
            const a = this.base[f] ?? '';
            const b = this.files[f] ?? '';
            const cached = this.#reviewCache.get(f);
            let review: FileReview;
            if (cached && cached.base === a && cached.now === b && cached.version === version) review = cached.review;
            else {
                // Equal texts have nothing to show, whatever happened to the characters on the way.
                review = a === b ? reviewFile([], this.me) : reviewFile(source?.runs(f, a) ?? textRuns(a, b, () => this.me), this.me);
                this.#reviewCache.set(f, { base: a, now: b, version, review });
            }
            if (review.changes.length) out.set(f, review);
        }
        return out;
    });

    changes = $derived.by((): FileChange[] =>
        [...this.reviews].map(([file, r]) => ({
            file,
            add: r.add,
            del: r.del,
            kind: !(file in this.base) || this.base[file] === '' ? 'added' : this.files[file] === undefined ? 'deleted' : 'modified',
        })),
    );

    // --- the commit selection --------------------------------------------------------------------------------------------

    /** Ids (`Change.keys`) of changes left out of the next commit. A change is left out when any of its keys is: its
     *  keys grow as people keep typing in it, and a change that grew into one left out is left out too. */
    #excluded = new Set<string>();
    /** Keys seen in the last look at the changes: a change with none of them is new. */
    #known = new Set<string>();
    /** Whether everything was ticked at the last look: new changes join the selection only then. */
    #allIncluded = true;
    #selectionTick = $state(0);

    /** Per file with changes, per change: whether the next commit takes it. Everything is in at first; leaving changes
     *  out lasts until they are ticked again or committed, across opening and closing the review; a change that appears
     *  while everything is ticked is ticked, otherwise it is not. */
    included = $derived.by((): ReadonlyMap<string, readonly boolean[]> => {
        void this.#selectionTick;
        const out = new Map<string, boolean[]>();
        const seen = new Set<string>();
        let all = true;
        for (const [f, r] of this.reviews) {
            out.set(
                f,
                r.changes.map(c => {
                    const isNew = !c.keys.some(k => this.#known.has(k));
                    const left = c.keys.some(k => this.#excluded.has(k)) || (isNew && !this.#allIncluded);
                    for (const k of c.keys) {
                        seen.add(k);
                        if (left) this.#excluded.add(k);
                    }
                    if (left) all = false;
                    return !left;
                }),
            );
        }
        this.#known = seen;
        for (const k of this.#excluded) if (!seen.has(k)) this.#excluded.delete(k);
        this.#allIncluded = all;
        return out;
    });

    /** Ticks (`on`) or unticks changes `which` of `file`. */
    setIncluded(file: string, which: readonly number[], on: boolean): void {
        const r = this.reviews.get(file);
        if (!r) return;
        for (const i of which) {
            for (const k of r.changes[i]?.keys ?? []) {
                if (on) this.#excluded.delete(k);
                else this.#excluded.add(k);
            }
        }
        // "Everything is ticked" is about the changes as they are now, for the next change to arrive.
        this.#allIncluded = [...this.reviews.values()].every(x => x.changes.every(c => !c.keys.some(k => this.#excluded.has(k))));
        this.#selectionTick++;
    }

    /** Ticks or unticks every change, or (with `person`) every change that person took part in. */
    setAllIncluded(on: boolean, person: string | null = null): void {
        for (const [f, r] of this.reviews)
            this.setIncluded(
                f,
                r.changes.filter(c => person === null || c.authors.includes(person)).map(c => c.index),
                on,
            );
    }

    /** How many changed lines the next commit takes. */
    selectedLines = $derived([...this.reviews].reduce((n, [f, r]) => n + r.changes.reduce((m, c, i) => m + (this.included.get(f)?.[i] ? c.add + c.del : 0), 0), 0));

    /** Puts changes `which` of `file` back as committed (all of the file's with null), for everyone in the room, and
     *  offers Undo, which puts the text back as it was if nobody changed it since. */
    revert(file: string, which: readonly number[] | null): void {
        const r = this.reviews.get(file);
        if (!r || this.readOnly) return;
        const before = this.files[file] ?? '';
        const after = revertedText(r, c => which === null || which.includes(c));
        this.#setText(file, after);
        this.lastRevert = { file, before, after, key: Date.now() };
    }

    /** The last revert, for its Undo; null once undone. */
    lastRevert = $state<{ file: string; before: string; after: string; key: number } | null>(null);

    undoRevert(): void {
        const u = this.lastRevert;
        this.lastRevert = null;
        if (!u || (this.files[u.file] ?? '') !== u.after) return;
        this.#setText(u.file, u.before);
    }

    #setText(file: string, text: string): void {
        if (this.source?.files.has(file)) this.source.replace(file, text);
        else this.edit(file, text);
    }

    /** Every problem: the shown build's and the language servers', merged (notes included; the panel filters them). */
    problems = $derived.by((): Problem[] => {
        const reports: { source: ProblemSource; items: readonly Reported[] }[] = [{ source: 'build', items: this.shownBuild.diagnostics }];
        for (const [source, files] of Object.entries(this.languageProblems) as [ProblemSource, Record<string, readonly Reported[]>][])
            reports.push({ source, items: Object.values(files).flat() });
        return mergeProblems(reports, this.order, this.seed.unread);
    });
    problemCounts = $derived(countProblems(this.problems));
    /** The shown build's errors: what the preview lists at its top. */
    buildErrors = $derived(this.problems.filter(p => p.severity === 'error' && p.sources.includes('build')));

    uncommitted = $derived(this.changes.reduce((n, c) => n + Math.max(c.add, c.del), 0));
    defaultCommitMessage = $derived.by(() => {
        const files = this.changes.filter(c => this.included.get(c.file)?.some(Boolean));
        return files.length ? `Update ${files.map(c => short(c.file)).join(', ')}` : '';
    });
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
        // File (in the explorer's order), then line, then column.
        const pos = (file: string, line = 0, col = 0): readonly [number, number, number] => [this.order.indexOf(file), line, col];
        const threads = this.visibleThreads
            .filter(t => this.commentFilter === 'all' || (this.commentFilter === 'github' ? t.source === 'github' : t.source === 'team'))
            .filter(t => this.showResolved || !t.root.resolved || t.id === this.activeThread)
            .map(t => ({ kind: 'thread' as const, id: t.id, file: t.file, thread: t, pos: pos(t.file, this.anchors[t.id]?.startLine, this.anchors[t.id]?.startColumn) }));
        const suggs =
            this.commentFilter === 'github'
                ? []
                : this.suggestions.map(s => ({ kind: 'suggestion' as const, id: s.id, file: s.file, suggestion: s, pos: pos(s.file, s.line, s.col) }));
        return [...threads, ...suggs].toSorted((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1] || a.pos[2] - b.pos[2]);
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
        this.#lastEdit = Date.now();
        // A failed build waiting to be shown waits for this pause in typing too.
        if (this.#settleTimer) this.#scheduleShow();
    }

    /** Takes a finished build. A build without errors shows at once (the errors go away as soon as they are fixed);
     *  one with errors shows only once typing has paused (`SETTLE_MS`), so the preview never flickers into its error
     *  state mid-word. Until then the previous build stays shown. */
    acceptBuild(b: BuildState): void {
        this.build = b;
        if (!b.diagnostics.some(d => d.severity === 'error') && b.ok) {
            clearTimeout(this.#settleTimer);
            this.#settleTimer = 0;
            this.shownBuild = b;
            return;
        }
        this.#scheduleShow();
    }

    #scheduleShow(): void {
        clearTimeout(this.#settleTimer);
        this.#settleTimer = window.setTimeout(
            () => {
                this.#settleTimer = 0;
                // A newer build is running: it will be accepted when it is done.
                if (this.build.status !== 'idle') return;
                this.shownBuild = this.build;
            },
            settleDelay(this.#lastEdit, Date.now()),
        );
    }

    /** Replaces what `source` reports for `file` (a language server's publishDiagnostics). */
    setLanguageProblems(source: ProblemSource, file: string, items: readonly Reported[]): void {
        this.languageProblems = { ...this.languageProblems, [source]: { ...this.languageProblems[source], [file]: items } };
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

    setCursor(c: Cursor, from: 'source' | 'preview' = 'source'): void {
        this.cursorFrom = from;
        this.cursor = c;
        if (this.root) this.lastRoot = this.root;
    }

    togglePanel(p: Panel): void {
        this.panel = this.panel === p ? null : p;
    }

    togglePopover(p: Exclude<Popover, null>): void {
        this.popover = this.popover === p ? null : p;
    }

    /** Commits every uncommitted change with the message typed, or the default one: through `backend` when the
     *  session is a repository's, else locally (the demo). A refused commit leaves everything uncommitted. */
    async commit(): Promise<void> {
        if (!this.selectedLines || this.committing || this.readOnly) return;
        const msg = this.commitMessage.trim() || this.defaultCommitMessage;
        const files: CommittedFile[] = [];
        const ids = new Map<string, ReturnType<typeof committedText>['items']>();
        const people = new Set<string>();
        for (const [f, r] of this.reviews) {
            const inc = this.included.get(f) ?? [];
            if (!inc.some(Boolean)) continue;
            const c = committedText(r, i => inc[i] ?? false);
            files.push({ path: f, text: c.text, items: c.items?.encode() ?? '' });
            ids.set(f, c.items);
            r.changes.forEach((ch, i) => inc[i] && ch.authors.forEach(a => people.add(a)));
        }
        people.delete(this.me);
        this.committing = true;
        try {
            const hash = this.backend ? await this.backend.commit(msg, files, [...people]) : hex7();
            this.commits.unshift({ hash: hash.slice(0, 7), author: this.me, when: 'just now', msg });
            this.base = { ...this.base, ...Object.fromEntries(files.map(c => [c.path, c.text])) };
            for (const [f, items] of ids) this.source?.setBaseIds(f, items);
            this.commitMessage = '';
            this.popover = null;
            this.justCommitted = true;
            clearTimeout(this.justCommittedTimer);
            this.justCommittedTimer = setTimeout(() => (this.justCommitted = false), 2000);
        } catch (e) {
            this.flash(e instanceof Error ? e.message : 'Commit failed');
        } finally {
            this.committing = false;
        }
    }

    /** Someone else in the room committed: `hash` is the branch's head now and `files` are committed, each with the
     *  ids of its characters. Does nothing when `hash` is already the head (the room tells the one who committed too). */
    committedElsewhere(hash: string, files: readonly CommittedFile[]): void {
        if (this.commits[0]?.hash === hash.slice(0, 7)) return;
        this.commits.unshift({ hash: hash.slice(0, 7), author: '', when: 'just now', msg: '' });
        this.base = { ...this.base, ...Object.fromEntries(files.map(f => [f.path, f.text])) };
        this.source?.setBase(files);
    }

    /** Makes `user` known to the session, unless someone with their id already is. */
    meet(user: User): void {
        if (!(user.id in this.users)) this.users[user.id] = user;
    }

    private justCommittedTimer: ReturnType<typeof setTimeout> | undefined;

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
        const id = `n${crypto.randomUUID()}`;
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

    /** Adds a posted team thread on `quote` in `file` with `body` as its first comment, and makes it current. */
    comment(file: string, quote: string, range: Thread['range'], body: string): void {
        const id = `n${crypto.randomUUID()}`;
        const q = quote.length > 80 ? `${quote.slice(0, 80)}…` : quote;
        this.threads.push({
            id,
            source: 'team',
            branch: this.branch,
            file,
            quote: q,
            ...(range ? { range } : {}),
            root: { id: `${id}r`, author: this.me, when: 'now', resolved: false, body, replies: [] },
        });
        this.activeThread = id;
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
        this.updateThread(threadId, t => ({
            ...t,
            root: addReply(t.root, commentId, { id: crypto.randomUUID(), author: this.me, when: 'now', resolved: false, body, replies: [] }),
        }));
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

    /** A step of the preview's zoom, to the nearest tenth, within 0.5 to 4. */
    zoomBy(delta: number): void {
        this.zoom = Math.min(4, Math.max(0.5, Math.round((this.zoom + delta) * 10) / 10));
    }

    /** The preview's zoom as the person set it there, kept within 0.5 to 4. */
    zoomTo(zoom: number): void {
        this.zoom = Math.min(4, Math.max(0.5, zoom));
    }
}
