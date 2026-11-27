<script lang="ts">
    import Avatar from '#lib/ui/Avatar.svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import { dialogFocus } from '#lib/ui/focus.ts';
    import { tip } from '#lib/ui/tooltip.ts';
    import type { FileChange, Session } from '#lib/session.svelte.ts';
    import type { FileReview, Row } from './model.ts';
    import { segments } from './highlight.ts';

    /** The commit popover: a message, the changed files and Commit. Clicking a file grows it into the review window:
     *  the same on the left, every file's diff on the right in one scroll, where files, hunks, single changes and
     *  people can be ticked in or out of the commit, and changes reverted. */
    let { session: s, onOpenFile }: { session: Session; onOpenFile: (file: string) => void } = $props();

    type Tri = 'all' | 'some' | 'none';

    /** The file the review window shows (and the list marks); null while it is the small popover. */
    let current = $state<string | null>(null);
    let folded = $state<ReadonlySet<string>>(new Set());
    let layout = $state<'split' | 'unified'>(readPref('papers.review.layout') === 'unified' ? 'unified' : 'split');
    const SIDE = 330;
    const SIDE_MIN = 240;
    const SIDE_MAX = 640;
    let side = $state(clampSide(Number(readPref('papers.review.side')) || SIDE));
    let stack = $state<HTMLElement | null>(null);
    let message = $state<HTMLTextAreaElement | null>(null);

    function readPref(key: string): string | null {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }
    function writePref(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            // A remembered width is a convenience.
        }
    }
    function clampSide(w: number): number {
        return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w)));
    }

    const files = $derived(s.changes);
    const reviewOf = (f: string): FileReview | undefined => s.reviews.get(f);
    const inc = (f: string, c: number): boolean => s.included.get(f)?.[c] ?? false;

    function tri(list: readonly boolean[]): Tri {
        const n = list.filter(Boolean).length;
        return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
    }
    const fileTri = (f: string): Tri => tri(s.included.get(f) ?? []);
    const allTri = $derived(tri([...s.included.values()].flat()));

    /** Everyone with a change, me first. */
    const people = $derived.by(() => {
        const set = new Set<string>();
        for (const r of s.reviews.values()) for (const c of r.changes) for (const a of c.authors) set.add(a);
        return [...set].toSorted((a, b) => (a === s.me ? -1 : b === s.me ? 1 : name(a).localeCompare(name(b))));
    });
    /** People are shown only when someone besides me changed something. */
    const team = $derived(people.some((p) => p !== s.me));

    function personTri(p: string): Tri {
        const list: boolean[] = [];
        for (const [f, r] of s.reviews) for (const c of r.changes) if (c.authors.includes(p)) list.push(inc(f, c.index));
        return tri(list);
    }
    function personLines(p: string): number {
        let n = 0;
        for (const r of s.reviews.values()) for (const c of r.changes) if (c.authors.includes(p)) n += c.add + c.del;
        return n;
    }
    const name = (p: string): string => s.users[p]?.name ?? p;
    const first = (p: string): string => (p === s.me ? 'You' : (name(p).split(' ')[0] ?? p));
    const fileAuthors = (f: string): string[] => {
        const r = reviewOf(f);
        return r ? [...r.authors].toSorted((a, b) => (a === s.me ? -1 : b === s.me ? 1 : 0)) : [];
    };

    /** Everyone whose ticked changes go into the commit, me first: the others are its co-authors. */
    const authors = $derived.by(() => {
        const set = new Set<string>();
        for (const [f, r] of s.reviews) for (const c of r.changes) if (inc(f, c.index)) for (const a of c.authors) set.add(a);
        return [...set].toSorted((a, b) => (a === s.me ? -1 : b === s.me ? 1 : name(a).localeCompare(name(b))));
    });
    const coAuthors = $derived(authors.filter((a) => a !== s.me));
    const selectedFiles = $derived(files.filter((c) => (s.included.get(c.file) ?? []).some(Boolean)).length);

    function counts(f: string): { add: number; del: number; on: number; total: number } {
        const r = reviewOf(f);
        let on = 0;
        let total = 0;
        for (const c of r?.changes ?? []) {
            total += c.add + c.del;
            if (inc(f, c.index)) on += c.add + c.del;
        }
        return { add: r?.add ?? 0, del: r?.del ?? 0, on, total };
    }

    const setFile = (f: string, on: boolean): void => s.setIncluded(f, reviewOf(f)?.changes.map((c) => c.index) ?? [], on);

    // --- opening, closing, moving --------------------------------------------------------------------------------

    function open(f: string): void {
        current = f;
        if (folded.has(f)) folded = new Set([...folded].filter((x) => x !== f));
        requestAnimationFrame(() => {
            const sec = stack?.querySelector<HTMLElement>(`section[data-file="${CSS.escape(f)}"]`);
            if (sec && stack) stack.scrollTop += sec.getBoundingClientRect().top - stack.getBoundingClientRect().top - 14;
        });
    }
    function close(): void {
        s.popover = null;
    }
    function fold(f: string): void {
        folded = folded.has(f) ? new Set([...folded].filter((x) => x !== f)) : new Set([...folded, f]);
    }
    function onStackScroll(): void {
        if (!stack) return;
        const top = stack.getBoundingClientRect().top + 60;
        let at: string | null = null;
        for (const sec of stack.querySelectorAll<HTMLElement>('section[data-file]')) if (sec.getBoundingClientRect().top <= top) at = sec.dataset['file'] ?? null;
        if (at) current = at;
    }
    function goto(f: string): void {
        close();
        onOpenFile(f);
    }
    $effect(() => {
        // A file whose changes are gone (committed, reverted) leaves the window; with none left it closes.
        if (current !== null && !s.reviews.has(current)) current = files[0]?.file ?? null;
        if (files.length === 0 && !s.justCommitted) close();
    });

    function onMessageKey(e: KeyboardEvent): void {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void s.commit();
        } else if (e.key === 'ArrowDown' && message && message.selectionStart === message.value.length) {
            e.preventDefault();
            message.closest('[role=dialog]')?.querySelector<HTMLElement>('.row')?.focus();
        }
    }
    function onRowKey(e: KeyboardEvent, f: string): void {
        const row = e.currentTarget;
        if (!(row instanceof HTMLElement) || e.target !== row) return;
        const rows = [...(row.parentElement?.querySelectorAll<HTMLElement>('.row') ?? [])];
        const i = rows.indexOf(row);
        if (e.key === 'ArrowDown') rows[i + 1]?.focus();
        else if (e.key === 'ArrowUp') (i === 0 ? message : rows[i - 1])?.focus();
        else if (e.key === ' ') setFile(f, fileTri(f) !== 'all');
        else if (e.key === 'Enter' || e.key === 'ArrowRight') open(f);
        else return;
        e.preventDefault();
    }
    function autosize(el: HTMLTextAreaElement): void {
        const fit = (): void => {
            const min = el.rows * 19 + 16;
            el.style.height = 'auto';
            el.style.height = `${Math.max(min, Math.min(el.scrollHeight + 2, 220))}px`;
        };
        $effect(() => {
            void s.commitMessage;
            fit();
        });
    }
    function indeterminate(state: Tri): (el: HTMLInputElement) => void {
        return (el) => {
            el.indeterminate = state === 'some';
        };
    }

    function setLayout(v: 'split' | 'unified'): void {
        layout = v;
        writePref('papers.review.layout', v);
    }
    function onBigKey(e: KeyboardEvent): void {
        if (e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            setLayout(layout === 'split' ? 'unified' : 'split');
        }
    }

    // --- the divider ---------------------------------------------------------------------------------------------

    function setSide(w: number): void {
        side = clampSide(w);
        writePref('papers.review.side', String(side));
    }
    function onResizeDown(e: PointerEvent): void {
        const handle = e.currentTarget;
        if (!(handle instanceof HTMLElement)) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const left = handle.previousElementSibling?.getBoundingClientRect().left ?? 0;
        const move = (ev: PointerEvent): void => setSide(ev.clientX - left);
        const up = (): void => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    }
    function onResizeKey(e: KeyboardEvent): void {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setSide(side + (e.key === 'ArrowLeft' ? -16 : 16));
    }

    // --- reverting -----------------------------------------------------------------------------------------------

    const short = (f: string): string => f.split('/').pop() ?? f;
    function words(kind: FileChange['kind'], whole: boolean): { tip: [string, string]; ask: string; btn: string; danger: boolean } {
        if (whole) {
            if (kind === 'added') return { tip: ['Delete file', 'remove the new file'], ask: 'Delete the new file', btn: 'Delete', danger: true };
            if (kind === 'deleted') return { tip: ['Restore file', 'undo the deletion'], ask: 'Restore', btn: 'Restore', danger: false };
            return { tip: ['Revert file', 'discard every change in it'], ask: 'Revert every change in', btn: 'Revert', danger: true };
        }
        if (kind === 'added') return { tip: ['Remove lines', 'take them out of the new file'], ask: 'Remove these lines from the new file', btn: 'Remove', danger: true };
        if (kind === 'deleted') return { tip: ['Restore lines', 'bring them back'], ask: 'Restore these lines of', btn: 'Restore', danger: false };
        return { tip: ['Revert change', 'discard these lines'], ask: 'Revert this change in', btn: 'Revert', danger: true };
    }
    const kindOf = (f: string): FileChange['kind'] => files.find((c) => c.file === f)?.kind ?? 'modified';

    let confirm = $state<{ file: string; which: readonly number[] | null; x: number; y: number; from: HTMLElement } | null>(null);
    function askRevert(e: MouseEvent, file: string, which: readonly number[] | null): void {
        e.stopPropagation();
        const from = e.currentTarget;
        if (!(from instanceof HTMLElement)) return;
        const r = from.getBoundingClientRect();
        confirm = { file, which, x: r.right, y: r.bottom, from };
    }
    const confirmInfo = $derived.by(() => {
        if (!confirm) return null;
        const r = reviewOf(confirm.file);
        const which = confirm.which;
        const list = r?.changes.filter((c) => which === null || which.includes(c.index)) ?? [];
        const w = words(kindOf(confirm.file), which === null);
        const others = [...new Set(list.flatMap((c) => c.authors))].filter((p) => p !== s.me);
        return { ...w, add: list.reduce((n, c) => n + c.add, 0), del: list.reduce((n, c) => n + c.del, 0), others };
    });
    function placeConfirm(el: HTMLElement): void {
        const c = confirm;
        if (!c) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let y = c.y + 6;
        if (y + h > innerHeight - 8) y = c.from.getBoundingClientRect().top - h - 6;
        el.style.left = `${Math.max(8, c.x - w)}px`;
        el.style.top = `${y}px`;
        el.querySelector<HTMLElement>('[data-confirm]')?.focus();
    }
    function hideConfirm(): void {
        const from = confirm?.from;
        confirm = null;
        if (from?.isConnected) from.focus({ preventScroll: true });
    }
    function doRevert(): void {
        const c = confirm;
        hideConfirm();
        if (c) s.revert(c.file, c.which);
    }
    function onConfirmKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideConfirm();
        }
    }
    function onPointerDown(e: PointerEvent): void {
        if (confirm && e.target instanceof Element && !e.target.closest('.confirm')) confirm = null;
    }

    // --- the diff ------------------------------------------------------------------------------------------------

    /** The rows of a hunk side by side: context once, then each run of deletions beside its run of insertions. */
    function sideBySide(rows: readonly Row[], start: number, end: number): { del: number | null; add: number | null; ctx: number | null }[] {
        const out: { del: number | null; add: number | null; ctx: number | null }[] = [];
        let i = start;
        while (i < end) {
            if (rows[i]?.kind === 'ctx') {
                out.push({ del: null, add: null, ctx: i++ });
                continue;
            }
            const dels: number[] = [];
            const adds: number[] = [];
            while (i < end && rows[i]?.kind === 'del') dels.push(i++);
            while (i < end && rows[i]?.kind === 'add') adds.push(i++);
            for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ del: dels[k] ?? null, add: adds[k] ?? null, ctx: null });
        }
        return out;
    }
    function rowTip(row: Row): Record<string, string> {
        const a = row.authors[0] ?? s.me;
        if (row.suggested) return tip(`Suggested by ${name(row.suggested.by)}`, null, `accepted by ${row.suggested.acceptedBy === s.me ? 'you' : first(row.suggested.acceptedBy)}`);
        const who = row.authors.map((p) => (p === s.me ? 'You' : name(p))).join(', ') || name(a);
        return tip(who, null, row.kind === 'add' ? 'wrote this line' : 'removed this line');
    }
</script>

<svelte:window onpointerdowncapture={onPointerDown} />

{#snippet check(state: Tri, label: string, onchange: (on: boolean) => void, hint = 'in this commit')}
    <input
        type="checkbox"
        class="yk-check"
        checked={state === 'all'}
        {@attach indeterminate(state)}
        onchange={(e) => onchange(e.currentTarget.checked)}
        onclick={(e) => e.stopPropagation()}
        {...tip(label, 'Space', hint)}
    />
{/snippet}

{#snippet stackAv(list: readonly string[])}
    <span class="stack-av">
        {#each list as p (p)}<Avatar user={s.users[p]} size={16} />{/each}
    </span>
{/snippet}

{#snippet path(f: string)}
    {@const i = f.lastIndexOf('/')}
    {#if i >= 0}<span class="dir">{f.slice(0, i + 1)}</span>{/if}<span class="name">{f.slice(i + 1)}</span>
{/snippet}

{#snippet nums(f: string)}
    {@const c = counts(f)}
    <span class="nums">
        {#if c.on > 0 && c.on < c.total}<span class="part" {...tip('Partly included', null, `${c.on} of ${c.total} lines`)}>{c.on}/{c.total}</span>{/if}
        {#if c.add}<span class="a">+{c.add}</span>{/if}
        {#if c.del}<span class="d">−{c.del}</span>{/if}
    </span>
{/snippet}

{#snippet status(kind: FileChange['kind'])}
    {@const letter = kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : 'M'}
    <span class="st st-{letter}" {...tip(kind === 'added' ? 'Added' : kind === 'deleted' ? 'Deleted' : 'Modified')}>{letter}</span>
{/snippet}

{#snippet list()}
    <div class="list-head">
        {@render check(allTri, 'Include all', (on) => s.setAllIncluded(on))}
        <span>Changes</span>
        <span class="grow"></span>
        <span class="mono">{files.length}</span>
    </div>
    {#if team}
        <div class="people">
            {#each people as p (p)}
                <label class="pchip">
                    {@render check(personTri(p), `Include ${p === s.me ? 'yours' : first(p)}`, (on) => s.setAllIncluded(on, p))}
                    <Avatar user={s.users[p]} size={20} />
                    <span>{first(p)}</span>
                    <span class="mono soft">{personLines(p)}</span>
                </label>
            {/each}
        </div>
    {/if}
    <ul class="list" role="listbox" aria-label="Changes">
        {#each files as c (c.file)}
            {@const st = fileTri(c.file)}
            {@const w = words(c.kind, true)}
            <li
                class="row"
                class:excluded={st === 'none'}
                class:deleted={c.kind === 'deleted'}
                class:yk-tint={current === c.file}
                role="option"
                tabindex="-1"
                aria-selected={current === c.file}
                aria-current={current === c.file}
                onclick={() => open(c.file)}
                onkeydown={(e) => onRowKey(e, c.file)}
                {...tip(c.file, 'Enter', 'show the changes')}
            >
                {@render check(st, `Include ${c.file}`, (on) => setFile(c.file, on))}
                {@render status(c.kind)}
                <span class="path">{@render path(c.file)}</span>
                {#if team}{@render stackAv(fileAuthors(c.file))}{/if}
                {@render nums(c.file)}
                <span class="acts">
                    {#if c.kind !== 'deleted'}
                        <button type="button" class="yk-icon-btn mini" onclick={(e) => (e.stopPropagation(), goto(c.file))} {...tip('Open', null, 'in the editor')}><Icon name="open" size={15} /></button>
                    {/if}
                    <button type="button" class="yk-icon-btn mini" onclick={(e) => askRevert(e, c.file, null)} {...tip(w.tip[0], null, w.tip[1])}><Icon name="undo" size={15} /></button>
                </span>
            </li>
        {/each}
    </ul>
{/snippet}

{#snippet foot()}
    <div class="foot">
        <span class="branch mono"><Icon name="branch" size={13} />{s.branch}</span>
        {#if team && authors.length}
            <span class="coauth" {...tip('Authors', null, coAuthors.length ? `Co-authored-by ${coAuthors.map(name).join(', ')}` : 'only you')}>{@render stackAv(authors)}</span>
        {/if}
        <span class="grow"></span>
        <button type="button" class="yk-btn yk-btn--primary btn-sm" disabled={!s.selectedLines || s.committing} onclick={() => void s.commit()} {...tip('Commit', 'Enter', `${selectedFiles} file${selectedFiles === 1 ? '' : 's'} to ${s.branch}`)}>Commit</button>
    </div>
{/snippet}

{#snippet message_(rows: number)}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
        bind:this={message}
        bind:value={s.commitMessage}
        {@attach autosize}
        autofocus
        class="yk-input msg"
        {rows}
        placeholder={s.defaultCommitMessage || 'Nothing to commit'}
        aria-label="Message"
        onkeydown={onMessageKey}
    ></textarea>
{/snippet}

{#snippet cell(r: Row, f: string)}
    {#each segments(r.text, f, r.mark) as g, k (k)}{#if g.marked}<span class="w t-{g.cls}">{g.text}</span>{:else if g.cls}<span class="t-{g.cls}">{g.text}</span>{:else}{g.text}{/if}{/each}{r.text === '' ? ' ' : ''}
{/snippet}

{#snippet lineCheck(f: string, r: Row)}
    <input
        type="checkbox"
        class="yk-check"
        checked={inc(f, r.change)}
        onchange={(e) => s.setIncluded(f, [r.change], e.currentTarget.checked)}
        {...tip('Include change', 'Space', r.kind === 'add' ? 'add it in this commit' : 'remove it in this commit')}
    />
{/snippet}

{#snippet author(r: Row, cls: string)}
    {#if team}
        <td class="au {cls}">
            <span class="au-in" class:sug={r.suggested !== undefined} class:two={r.authors.length > 1} {...rowTip(r)}>
                {#each r.authors.slice(0, 2) as p (p)}<Avatar user={s.users[p]} size={16} />{/each}
            </span>
        </td>
    {/if}
{/snippet}

{#snippet diff(f: string, r: FileReview)}
    {#each r.hunks as h, hi (hi)}
        {@const hw = words(kindOf(f), false)}
        {@const hs = tri(h.changes.map((c) => inc(f, c)))}
        <table class="dtable {layout}">
            {#if layout === 'unified'}
                <colgroup><col style:width="26px" />{#if team}<col style:width="38px" />{/if}<col style:width="40px" /><col style:width="40px" /><col style:width="16px" /><col /></colgroup>
            {:else}
                <colgroup><col style:width="26px" />{#if team}<col style:width="38px" />{/if}<col style:width="40px" /><col /><col style:width="1px" /><col style:width="26px" />{#if team}<col style:width="38px" />{/if}<col style:width="40px" /><col /></colgroup>
            {/if}
            <tbody>
                <tr class="hunk">
                    <td class="cb">{@render check(hs, 'Include hunk', (on) => s.setIncluded(f, h.changes, on))}</td>
                    <td colspan={layout === 'split' ? (team ? 8 : 6) : team ? 5 : 4}>
                        <div class="hk">
                            <span class="mono">@@ -{h.oldStart} +{h.newStart} @@</span>
                            <span class="ctx">{#if h.header}{@render cell({ kind: 'ctx', text: h.header, old: null, new: null, change: -1, authors: [] }, f)}{/if}</span>
                            <span class="hacts">
                                <button type="button" class="yk-icon-btn mini" onclick={(e) => askRevert(e, f, h.changes)} {...tip(hw.tip[0], null, hw.tip[1])}><Icon name="undo" size={14} /></button>
                            </span>
                        </div>
                    </td>
                </tr>
                {#if layout === 'unified'}
                    {#each r.rows.slice(h.start, h.end) as row, k (h.start + k)}
                        {@const off = row.kind !== 'ctx' && !inc(f, row.change)}
                        <tr class={row.kind === 'ctx' ? '' : row.kind} class:off>
                            <td class="cb">{#if row.kind !== 'ctx'}{@render lineCheck(f, row)}{/if}</td>
                            {#if row.kind !== 'ctx'}{@render author(row, '')}{:else if team}<td class="au"></td>{/if}
                            <td class="no">{row.old ?? ''}</td>
                            <td class="no">{row.new ?? ''}</td>
                            <td class="sg">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</td>
                            <td class="tx">{@render cell(row, f)}</td>
                        </tr>
                    {/each}
                {:else}
                    {#each sideBySide(r.rows, h.start, h.end) as pair, k (k)}
                        {#if pair.ctx !== null}
                            {@const row = r.rows[pair.ctx]}
                            {#if row}
                                <tr>
                                    <td class="cb"></td>{#if team}<td class="au"></td>{/if}<td class="no">{row.old}</td><td class="tx">{@render cell(row, f)}</td>
                                    <td class="mid"></td>
                                    <td class="cb"></td>{#if team}<td class="au"></td>{/if}<td class="no">{row.new}</td><td class="tx">{@render cell(row, f)}</td>
                                </tr>
                            {/if}
                        {:else}
                            {@const d = pair.del === null ? undefined : r.rows[pair.del]}
                            {@const a = pair.add === null ? undefined : r.rows[pair.add]}
                            <tr>
                                {#if d}
                                    {@const off = inc(f, d.change) ? '' : 'off'}
                                    <td class="cb del {off}">{@render lineCheck(f, d)}</td>
                                    {@render author(d, `del ${off}`)}
                                    <td class="no del {off}">{d.old}</td>
                                    <td class="tx del {off}">{@render cell(d, f)}</td>
                                {:else}
                                    <td class="cb blank"></td>{#if team}<td class="au blank"></td>{/if}<td class="no blank"></td><td class="tx blank"></td>
                                {/if}
                                <td class="mid"></td>
                                {#if a}
                                    {@const off = inc(f, a.change) ? '' : 'off'}
                                    <td class="cb add {off}">{@render lineCheck(f, a)}</td>
                                    {@render author(a, `add ${off}`)}
                                    <td class="no add {off}">{a.new}</td>
                                    <td class="tx add {off}">{@render cell(a, f)}</td>
                                {:else}
                                    <td class="cb blank"></td>{#if team}<td class="au blank"></td>{/if}<td class="no blank"></td><td class="tx blank"></td>
                                {/if}
                            </tr>
                        {/if}
                    {/each}
                {/if}
            </tbody>
        </table>
    {/each}
{/snippet}

{#if current === null}
    <div class="popover commit-pop" role="dialog" aria-label="Commit" {@attach dialogFocus}>
        {@render message_(1)}
        {@render list()}
        {@render foot()}
    </div>
{:else}
    <div class="commit-scrim"></div>
    <div class="popover commit-pop big" role="dialog" aria-label="Commit" tabindex="-1" {@attach dialogFocus} onkeydown={onBigKey}>
        <div class="side" style:width="{side}px">
            {@render message_(3)}
            {@render list()}
            {@render foot()}
        </div>
        <!-- A focusable separator is a widget: the arrow keys move it. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
            class="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={side}
            aria-valuemin={SIDE_MIN}
            aria-valuemax={SIDE_MAX}
            tabindex="0"
            onpointerdown={onResizeDown}
            ondblclick={() => setSide(SIDE)}
            onkeydown={onResizeKey}
            {...tip('Resize', '← →', 'double-click resets')}
        ></div>
        <div class="stackwrap">
            <div class="stackbar">
                <div class="yk-segmented sm" role="group" aria-label="Layout">
                    {#each [['split', 'Split', 'Side by side'], ['unified', 'Unified', 'Unified']] as [v, label, hint] (v)}
                        <button
                            type="button"
                            aria-pressed={layout === v}
                            onclick={() => setLayout(v === 'unified' ? 'unified' : 'split')}
                            {...tip(hint ?? '', 'Alt+S')}>{label}</button
                        >
                    {/each}
                </div>
                <span class="grow"></span>
                <button type="button" class="yk-icon-btn mini" onclick={close} {...tip('Close', 'Esc')}><Icon name="x" size={15} /></button>
            </div>
            <div class="stack" bind:this={stack} onscroll={onStackScroll}>
                {#each files as c (c.file)}
                    {@const r = reviewOf(c.file)}
                    {@const w = words(c.kind, true)}
                    <section data-file={c.file} class:folded={folded.has(c.file)}>
                        <div class="dtool">
                            {@render check(fileTri(c.file), `Include ${c.file}`, (on) => setFile(c.file, on))}
                            <button type="button" class="ftitle" aria-expanded={!folded.has(c.file)} onclick={() => fold(c.file)} {...tip(folded.has(c.file) ? 'Expand' : 'Collapse', null, c.file)}>
                                <Icon name="chevron" size={14} />
                                {@render status(c.kind)}
                                <span class="fname">{@render path(c.file)}</span>
                            </button>
                            {@render nums(c.file)}
                            <span class="grow"></span>
                            {#if c.kind !== 'deleted'}
                                <button type="button" class="yk-icon-btn mini" onclick={() => goto(c.file)} {...tip('Open', null, 'in the editor')}><Icon name="open" size={15} /></button>
                            {/if}
                            <button type="button" class="yk-icon-btn mini" onclick={(e) => askRevert(e, c.file, null)} {...tip(w.tip[0], null, w.tip[1])}><Icon name="undo" size={15} /></button>
                        </div>
                        {#if r && !folded.has(c.file)}
                            <div class="dbody">{@render diff(c.file, r)}</div>
                        {/if}
                    </section>
                {/each}
            </div>
        </div>
    </div>
{/if}

{#if confirm && confirmInfo}
    {@const ci = confirmInfo}
    <div class="confirm popover" role="alertdialog" aria-label={ci.btn} {@attach placeConfirm} onkeydown={onConfirmKey} tabindex="-1">
        <div class="ct">{ci.ask} <span class="mono">{short(confirm.file)}</span>?</div>
        <div class="cs">
            {#if ci.add}<span class="a">+{ci.add}</span>{/if}
            {#if ci.del}<span class="d">−{ci.del}</span>{/if}
            {#if ci.others.length}
                {@render stackAv(ci.others)}
                <span class="soft">{ci.others.map(first).join(' and ')}’s {kindOf(confirm.file) === 'added' && confirm.which === null ? 'work' : 'lines'} too</span>
            {/if}
        </div>
        <div class="cb2">
            <button type="button" class="yk-btn yk-btn--ghost btn-sm" onclick={hideConfirm}>Cancel</button>
            <button type="button" data-confirm class="yk-btn {ci.danger ? 'yk-btn--danger' : 'yk-btn--primary'} btn-sm" onclick={doRevert} {...tip(ci.btn, 'Enter')}>{ci.btn}</button>
        </div>
    </div>
{/if}

<style>
    .commit-pop {
        right: 40px;
        width: 400px;
        max-height: calc(100vh - 60px);
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 0;
    }
    .commit-pop.big {
        position: fixed;
        inset: 0;
        margin: auto;
        width: min(1680px, calc(100vw - 64px));
        height: calc(100vh - 48px);
        max-height: none;
        padding: 0;
        flex-direction: row;
        gap: 0;
        overflow: hidden;
        z-index: 50;
        border-radius: var(--yk-radius-lg);
    }
    .commit-scrim {
        position: fixed;
        inset: 0;
        background: oklch(from var(--yk-ink) l c h / 0.16);
        z-index: 45;
        animation: fade-in var(--yk-motion-fast) var(--yk-motion-ease);
    }
    .big > .side {
        flex: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px;
        min-height: 0;
        border-right: 1px solid var(--yk-line);
    }
    .big > .side .list {
        flex: 1;
    }
    .msg {
        display: block;
        width: 100%;
        box-sizing: border-box;
        resize: none;
        line-height: 1.45;
        font-size: var(--yk-font-size-sm);
        min-height: 36px;
    }
    .grow {
        flex: 1;
    }
    .soft {
        color: var(--yk-soft);
    }

    .list-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        font-size: var(--yk-font-size-xs);
        color: var(--yk-soft);
    }
    .list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow: auto;
        min-height: 0;
    }
    .row {
        --row-bg: var(--yk-sunken);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 6px 0 8px;
        height: 30px;
        border-radius: var(--yk-radius-sm);
        cursor: pointer;
        position: relative;
    }
    .row:hover {
        background: var(--yk-sunken);
    }
    .row.yk-tint {
        --row-bg: var(--yk-accent-bg);
    }
    .row:focus-visible {
        outline: var(--yk-focus-width) solid var(--yk-ink);
        outline-offset: -2px;
        background: var(--row-bg);
    }
    .path {
        font-family: var(--yk-font-family-mono);
        font-size: 12.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 1;
    }
    .dir {
        color: var(--yk-soft);
    }
    .row.excluded .path {
        color: var(--yk-soft);
    }
    .row.deleted .path .name {
        text-decoration: line-through;
    }
    .st {
        font-family: var(--yk-font-family-mono);
        font-size: 11px;
        font-weight: var(--yk-font-weight-bold);
        width: 14px;
        text-align: center;
        flex: none;
    }
    .st-M {
        color: var(--yk-info);
    }
    .st-A {
        color: var(--yk-ok);
    }
    .st-D {
        color: var(--yk-danger);
    }
    .nums {
        font-family: var(--yk-font-family-mono);
        font-size: var(--yk-font-size-xs);
        display: flex;
        gap: 6px;
        flex: none;
    }
    .a {
        color: var(--yk-ok);
    }
    .d {
        color: var(--yk-danger);
    }
    .part {
        color: var(--yk-soft);
    }
    /* Row actions: on hover or keyboard focus, over the end of the row, on the row's own colour (no shift). */
    .acts {
        position: absolute;
        right: 2px;
        top: 3px;
        display: none;
        gap: 2px;
        padding-left: 18px;
        background: linear-gradient(to right, transparent, var(--row-bg) 16px);
    }
    .row:is(:hover, :focus-visible, :has(:focus-visible)) .acts {
        display: flex;
    }
    .mini {
        width: 24px;
        height: 24px;
    }
    .acts .mini {
        width: 22px;
        height: 22px;
    }

    .people {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 8px 6px;
    }
    .pchip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 9px 0 7px;
        border: 1px solid var(--yk-line);
        border-radius: var(--yk-radius-pill);
        cursor: pointer;
        font-size: 12.5px;
    }
    .pchip:hover {
        border-color: var(--yk-line-strong);
    }
    .stack-av {
        display: inline-flex;
        flex: none;
    }
    .stack-av :global(.avatar + .avatar) {
        margin-left: -4px;
    }
    .row .stack-av :global(.avatar) {
        box-shadow: 0 0 0 1.5px var(--row-bg);
    }
    .row:not(:hover, .yk-tint) .stack-av :global(.avatar) {
        box-shadow: 0 0 0 1.5px var(--yk-surface);
    }

    .foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 2px 0 6px;
    }
    .branch {
        display: inline-flex;
        gap: 5px;
        align-items: center;
        color: var(--yk-soft);
        font-size: var(--yk-font-size-xs);
    }
    .coauth {
        display: inline-flex;
        margin-left: 6px;
    }

    .resizer {
        width: 9px;
        margin: 0 -5px 0 -4px;
        flex: none;
        cursor: col-resize;
        position: relative;
        z-index: 3;
        touch-action: none;
    }
    .resizer::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 4px;
        width: 1px;
    }
    .resizer:hover::after,
    .resizer:focus-visible::after,
    :global(body.resizing) .resizer::after {
        background: var(--yk-ink);
        width: 2px;
        left: 3.5px;
    }
    .resizer:focus-visible {
        outline: none;
    }
    :global(body.resizing),
    :global(body.resizing *) {
        cursor: col-resize !important;
        user-select: none;
    }

    .stackwrap {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
    }
    .stackbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px 6px 14px;
        border-bottom: 1px solid var(--yk-line);
    }
    .yk-segmented.sm > button {
        padding: 2px 9px;
        font-size: var(--yk-font-size-xs);
    }
    .stack {
        overflow: auto;
        flex: 1;
        min-width: 0;
        background: var(--yk-bg);
        padding: 0 14px 40vh;
    }
    .stack section {
        margin-top: 14px;
        border: 1px solid var(--yk-line);
        border-radius: var(--yk-radius-md);
        overflow: clip;
        background: var(--yk-surface);
    }
    .dtool {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px 6px 5px;
        border-bottom: 1px solid var(--yk-line);
        min-height: 40px;
        box-sizing: border-box;
        position: sticky;
        top: 0;
        z-index: 2;
        background: var(--yk-surface);
    }
    section.folded .dtool {
        border-bottom: 0;
    }
    .ftitle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        border: 0;
        background: none;
        padding: 2px 4px 2px 0;
        cursor: pointer;
        color: inherit;
        font: inherit;
        border-radius: var(--yk-radius-sm);
    }
    .ftitle > :global(.yk-icon) {
        color: var(--yk-soft);
        transition: transform var(--yk-motion-fast);
    }
    section.folded .ftitle > :global(.yk-icon) {
        transform: rotate(-90deg);
    }
    .fname {
        font-family: var(--yk-font-family-mono);
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .ftitle:hover .fname {
        text-decoration: underline;
        text-underline-offset: 3px;
        text-decoration-color: var(--yk-line-strong);
    }

    .dbody {
        font-family: var(--yk-font-family-mono);
        font-size: 12.5px;
        line-height: 20px;
    }
    .dtable {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font: inherit;
    }
    .dtable td {
        padding: 0;
        vertical-align: top;
        white-space: pre-wrap;
        word-break: break-word;
    }
    td.no {
        text-align: right;
        color: var(--yk-soft);
        padding-right: 8px;
        user-select: none;
        font-size: 11.5px;
    }
    td.cb {
        text-align: center;
        user-select: none;
    }
    /* Every box in a diff on one axis: the middle of the first column, the middle of a line. */
    td.cb .yk-check {
        display: grid;
        flex: none;
        margin: 2px auto 0;
    }
    td.sg {
        color: var(--yk-soft);
        user-select: none;
    }
    td.tx {
        padding-right: 12px;
    }
    td.mid {
        background: var(--yk-line);
    }
    .au-in {
        display: flex;
        width: fit-content;
        height: 20px;
        align-items: center;
        margin-inline: auto;
        position: relative;
    }
    .au-in :global(.avatar) {
        box-shadow: none;
    }
    /* A line two people changed: both, side by side. */
    .au-in.two {
        gap: 2px;
    }
    /* An accepted suggestion: a pen on the suggester's picture. */
    .au-in.sug::after {
        content: '';
        position: absolute;
        right: -3px;
        bottom: -1px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--yk-surface);
        box-shadow: 0 0 0 1px var(--yk-line);
        mask: none;
    }
    .au-in.sug::before {
        content: '';
        position: absolute;
        right: -2px;
        bottom: 0;
        width: 7px;
        height: 7px;
        z-index: 1;
        background: var(--yk-soft);
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round'%3E%3Cpath d='M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    tr.add td:is(.tx, .sg),
    td.add:is(.tx, .au) {
        background: oklch(from var(--yk-accent) l c h / 0.11);
    }
    tr.del td:is(.tx, .sg),
    td.del:is(.tx, .au) {
        background: oklch(from var(--yk-danger) l c h / 0.09);
    }
    tr.add td:is(.no, .cb, .au),
    td.add:is(.no, .cb) {
        background: oklch(from var(--yk-accent) l c h / 0.17);
    }
    tr.del td:is(.no, .cb, .au),
    td.del:is(.no, .cb) {
        background: oklch(from var(--yk-danger) l c h / 0.14);
    }
    td.blank {
        background: repeating-linear-gradient(135deg, transparent 0 5px, var(--yk-line) 5px 6px);
    }
    .w {
        border-radius: 2px;
    }
    :is(tr.add, td.add) .w {
        background: oklch(from var(--yk-accent) l c h / 0.3);
    }
    :is(tr.del, td.del) .w {
        background: oklch(from var(--yk-danger) l c h / 0.26);
    }
    /* Left out of the commit: no colour, a hatched gutter, as IntelliJ greys a change out. */
    tr.off td:is(.tx, .sg, .au),
    td.off:is(.tx, .au) {
        background: transparent;
        color: var(--yk-soft);
    }
    tr.off td:is(.no, .cb),
    td.off:is(.no, .cb) {
        background: repeating-linear-gradient(135deg, transparent 0 4px, oklch(from var(--yk-line-strong) l c h / 0.35) 4px 5px);
    }
    :is(tr.off, td.off) .w {
        background: none;
    }
    tr.hunk td {
        background: var(--yk-sunken);
        color: var(--yk-soft);
        height: 28px;
        vertical-align: middle;
        font-size: 11.5px;
    }
    tr.hunk td.cb .yk-check {
        margin-block: 0;
    }
    .hk {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-right: 8px;
    }
    .hk .ctx {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
    .hacts {
        display: flex;
        opacity: 0;
        transition: opacity var(--yk-motion-fast);
    }
    tr.hunk:is(:hover, :focus-within) .hacts {
        opacity: 1;
    }
    .t-cmd {
        color: var(--yk-code-function);
    }
    .t-arg {
        color: var(--yk-code-number);
    }
    .t-math {
        color: var(--yk-code-string);
    }
    .t-cmt {
        color: var(--yk-code-comment);
        font-style: italic;
    }
    .t-kw {
        color: var(--yk-code-keyword);
    }
    .t-key {
        color: var(--yk-code-function);
    }

    .confirm {
        position: fixed;
        z-index: 70;
        width: 290px;
        padding: 12px;
        display: grid;
        gap: 8px;
        border-radius: var(--yk-radius-lg);
    }
    .ct {
        font-weight: var(--yk-font-weight-semibold);
    }
    .cs {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: var(--yk-font-family-mono);
        font-size: var(--yk-font-size-xs);
    }
    .cs .soft {
        font-family: var(--yk-font-family-body);
    }
    .cb2 {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
    }
</style>
