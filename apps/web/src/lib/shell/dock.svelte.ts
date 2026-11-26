/**
 * The workbench's layout, made with dockview, as Yukibana Light's is: a tab for each open file and the Preview, in
 * groups that can be resized, and dragged beside, under or into one another.
 *
 * The session says which files have a tab, in which order, and which one is in front; the dock shows that, and tells
 * the session what the person does to the tabs. There is one source editor, shown in the file tab in front, so the
 * files' tabs stay in one group: a file's tab is dragged only within it, while Preview and whole groups go anywhere.
 *
 * On a narrow screen (`NARROW`) Preview is a tab of the files' group, and the session's `narrowPane` says which of the
 * two is in front; on a wider one it goes back beside the files if that is where it was.
 */
import {
    createDockview,
    type DockviewApi,
    type DockviewGroupPanel,
    type GroupPanelPartInitParameters,
    type IContentRenderer,
    type IDockviewPanel,
    type IGroupHeaderProps,
    type IHeaderActionsRenderer,
    type ITabRenderer,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { flushSync, mount, unmount, type Snippet } from 'svelte';
import type { Session } from '#lib/session.svelte.ts';
import Slot from './Slot.svelte';

/** What a group shows in front: a file (in the source editor), the Preview, or nothing. */
export type Front = 'file' | 'preview' | null;

/** The parts the dock places, written where the workbench is. */
export interface DockParts {
    /** The source editor. */
    editor: Snippet<[null]>;
    preview: Snippet<[null]>;
    /** The tab of the file at a path: its name, its state, its close button. */
    fileTab: Snippet<[string]>;
    /** What stands right after a group's tabs, and at the right end of its tab bar, for what the group has in front. */
    before: Snippet<[Front]>;
    after: Snippet<[Front]>;
}

export interface Dock {
    /** Makes the dock show the session's tabs, file in front and narrow pane. Reads them, so an effect that calls
     *  this runs again when they change. */
    sync(): void;
    dispose(): void;
}

/** The width (px) up to which the screen is narrow: the same as the styles' breakpoint. */
const NARROW = '(max-width: 900px)';
const FILE = 'file:';
const PREVIEW = 'preview';
/** No group gets narrower than this (px). */
const MIN_WIDTH = 160;

/** Where the layout is kept in this browser, and how long (ms) after its last change it is written. */
const KEPT = 'papers.dock';
const KEEP_MS = 300;

type Layout = ReturnType<DockviewApi['toJSON']>;

/** The layout kept in this browser, or null: none, or storage is not to be had. What it holds is checked by use. */
function keptLayout(): Layout | null {
    try {
        const text = localStorage.getItem(KEPT);
        return text === null ? null : (JSON.parse(text) as Layout);
    } catch {
        return null;
    }
}

function keepLayout(layout: Layout): void {
    try {
        localStorage.setItem(KEPT, JSON.stringify(layout));
    } catch {
        // Kept for convenience only.
    }
}

const pathOf = (panel: IDockviewPanel): string | null => (panel.id.startsWith(FILE) ? panel.id.slice(FILE.length) : null);

type Mounted = ReturnType<typeof mount>;

/** A file's panel: empty, until the source editor is put in it (the one in front has it). */
class FilePanel implements IContentRenderer {
    readonly element = document.createElement('div');

    constructor() {
        this.element.className = 'dock-panel';
    }

    init(): void {}
}

/** A panel that holds a part for as long as the dock lives. */
class PartPanel implements IContentRenderer {
    readonly element = document.createElement('div');
    #mounted: Mounted;

    constructor(part: Snippet<[null]>, className: string) {
        this.element.className = `dock-panel ${className}`;
        this.#mounted = mount(Slot<null>, { target: this.element, props: { part, arg: null } });
    }

    init(): void {}

    dispose(): void {
        void unmount(this.#mounted);
    }
}

/** A tab that shows a part for a value: a file's tab. */
class PartTab<T> implements ITabRenderer {
    readonly element = document.createElement('div');
    #mounted: Mounted;

    constructor(part: Snippet<[T]>, arg: T) {
        this.element.className = 'dock-tab';
        this.#mounted = mount(Slot<T>, { target: this.element, props: { part, arg } });
    }

    init(): void {}

    dispose(): void {
        void unmount(this.#mounted);
    }
}

/** A tab that is its title. */
class TitleTab implements ITabRenderer {
    readonly element = document.createElement('div');

    constructor() {
        this.element.className = 'dock-tab';
    }

    init(params: GroupPanelPartInitParameters): void {
        this.element.textContent = params.title;
    }
}

/** A part in a group's tab bar, shown for what the group has in front. */
class HeaderPart implements IHeaderActionsRenderer {
    readonly element = document.createElement('div');
    #front = $state<Front>(null);
    #mounted: Mounted | null = null;
    #watch: { dispose(): void } | null = null;

    constructor(
        private readonly part: Snippet<[Front]>,
        className: string,
    ) {
        this.element.className = className;
    }

    init(params: IGroupHeaderProps): void {
        const read = (): void => {
            const panel = params.group.activePanel;
            this.#front = panel === undefined ? null : pathOf(panel) === null ? 'preview' : 'file';
        };
        read();
        this.#watch = params.api.onDidActivePanelChange(read);
        const front = (): Front => this.#front;
        this.#mounted = mount(Slot<Front>, {
            target: this.element,
            props: {
                part: this.part,
                get arg() {
                    return front();
                },
            },
        });
    }

    dispose(): void {
        this.#watch?.dispose();
        if (this.#mounted) void unmount(this.#mounted);
    }
}

/**
 * Builds the layout in `element` for `s`, with `parts` in it, and returns it.
 * Precondition: `s` has at least one tab, and `element` is in the page.
 * The parts are mounted when this returns (what they bind is set).
 */
export function createDock(element: HTMLElement, s: Session, parts: DockParts): Dock {
    // The editor's home: one element, moved into the file panel in front.
    const editor = document.createElement('div');
    editor.className = 'dock-editor';
    const editorMounted = mount(Slot<null>, { target: editor, props: { part: parts.editor, arg: null } });

    const dock: DockviewApi = createDockview(element, {
        theme: { name: 'yukibana', className: 'dockview-theme-yukibana' },
        disableFloatingGroups: true,
        createComponent: ({ name }) => (name === PREVIEW ? new PartPanel(parts.preview, 'dock-preview') : new FilePanel()),
        createTabComponent: ({ id, name }) => (name === PREVIEW ? new TitleTab() : new PartTab(parts.fileTab, id.slice(FILE.length))),
        createLeftHeaderActionComponent: () => new HeaderPart(parts.before, 'dock-before'),
        createRightHeaderActionComponent: () => new HeaderPart(parts.after, 'dock-after'),
    });

    /** True while the dock is being made to show the session: what happens then is not the person's doing. */
    let syncing = false;
    const quietly = (run: () => void): void => {
        const was = syncing;
        syncing = true;
        try {
            run();
        } finally {
            syncing = was;
        }
    };

    const filePanels = (): IDockviewPanel[] => dock.panels.filter(p => pathOf(p) !== null);
    const filesGroup = (): DockviewGroupPanel | undefined => filePanels()[0]?.group;
    const previewPanel = (): IDockviewPanel | undefined => dock.getPanel(PREVIEW);

    const addFile = (path: string): void => {
        const group = filesGroup();
        dock.addPanel({
            id: FILE + path,
            component: 'file',
            tabComponent: 'file',
            title: path,
            inactive: true,
            ...(group === undefined ? {} : { position: { referenceGroup: group } }),
        });
    };

    const media = matchMedia(NARROW);
    /** True when Preview was beside the files before the screen got narrow: it goes back there. */
    let beside = true;

    const arrange = (): void => {
        const preview = previewPanel();
        const files = filesGroup();
        if (preview === undefined || files === undefined) return;
        quietly(() => {
            if (media.matches) {
                beside = preview.group !== files;
                if (beside) preview.api.moveTo({ group: files, skipSetActive: true });
            } else if (beside && preview.group === files) {
                preview.api.moveTo({ group: files, position: 'right' });
                const width = element.clientWidth;
                files.api.setSize({ width: Math.round(width / 2) });
            }
        });
        for (const g of dock.groups) g.api.setConstraints({ minimumWidth: Math.min(MIN_WIDTH, element.clientWidth / 2) });
    };

    /** The first layout: the files on the left, Preview on the right, half each. */
    const build = (): void => {
        for (const path of s.tabs) addFile(path);
        const files = filesGroup();
        dock.addPanel({
            id: PREVIEW,
            component: PREVIEW,
            tabComponent: PREVIEW,
            title: 'Preview',
            renderer: 'always',
            ...(files === undefined ? {} : { position: { referenceGroup: files, direction: 'right' } }),
        });
    };
    // The layout this browser had last, if it kept one that still holds: its file tabs are then made the session's.
    quietly(() => {
        const kept = keptLayout();
        if (kept !== null) {
            try {
                dock.fromJSON(kept);
            } catch {
                dock.clear();
            }
            if (previewPanel() === undefined) dock.clear();
        }
        if (previewPanel() === undefined) build();
    });
    dock.layout(element.clientWidth, element.clientHeight);
    if (media.matches) arrange();
    const onMedia = (): void => {
        arrange();
        sync();
    };
    media.addEventListener('change', onMedia);

    /** The file the dock last showed in front. */
    let shown: string | null = null;

    function sync(): void {
        const tabs = s.tabs;
        const active = s.activeFile;
        const pane = s.narrowPane;
        quietly(() => {
            // New tabs first, so that the files' group is still there when the last of the old ones goes.
            for (const path of tabs) if (dock.getPanel(FILE + path) === undefined) addFile(path);
            for (const p of filePanels()) if (!tabs.includes(pathOf(p) ?? '')) p.api.close();
            // The session's order, where the tabs are not in it already (a tab the person dragged is reported first).
            const files = filesGroup();
            if (files !== undefined) {
                const group = files;
                tabs.forEach((path, want) => {
                    const panel = dock.getPanel(FILE + path);
                    const others = group.panels.filter(p => pathOf(p) !== null);
                    if (panel !== undefined && others[want] !== panel) panel.api.moveTo({ group, index: group.panels.indexOf(others[want] ?? panel), skipSetActive: true });
                });
            }
            const front = dock.getPanel(FILE + active);
            if (front === undefined) return;
            if (editor.parentElement !== front.view.content.element) front.view.content.element.append(editor);
            const preview = previewPanel();
            const shared = preview !== undefined && preview.group === front.group;
            const group = front.group;
            if (shared && media.matches) {
                // In one group on a narrow screen, the session says which of the two is in front.
                const wanted = pane === 'preview' ? preview : front;
                if (group.activePanel !== wanted) wanted.api.setActive();
            } else if (group.activePanel !== front && (group.activePanel !== preview || active !== shown)) {
                // Preview stays in front of the files it shares a group with until another file is asked for.
                front.api.setActive();
            }
            shown = active;
        });
    }

    flushSync();
    sync();

    // Made while `syncing`: dockview tells a new listener what is in front now, which is not news.
    syncing = true;
    let keeping = 0;
    const subscriptions = [
        dock.onDidActivePanelChange(({ panel }) => {
            if (syncing || panel === undefined) return;
            const path = pathOf(panel);
            if (path !== null) s.activeFile = path;
            // On a narrow screen the two share a group, and the session knows which is in front.
            if (media.matches) s.narrowPane = path === null ? 'preview' : 'source';
        }),
        // A tab closed by the dock itself (none of ours does) is closed in the session, or comes back if it may not go.
        dock.onDidRemovePanel(panel => {
            const path = pathOf(panel);
            if (syncing || path === null) return;
            s.closeTab(path);
            queueMicrotask(sync);
        }),
        // The order the person dragged the tabs into is the session's.
        dock.onDidLayoutChange(() => {
            if (syncing) return;
            const order = (filesGroup()?.panels ?? []).map(pathOf).filter(p => p !== null);
            if (order.length === s.tabs.length && order.some((p, i) => p !== s.tabs[i])) s.tabs = order;
        }),
        // The layout is kept for the next visit, as it is on a screen wide enough to have one.
        dock.onDidLayoutChange(() => {
            clearTimeout(keeping);
            if (!media.matches) keeping = window.setTimeout(() => keepLayout(dock.toJSON()), KEEP_MS);
        }),
        // A file's tab stays among the files' tabs: there is one editor to show it in.
        dock.onWillShowOverlay(e => {
            const dragged = e.getData()?.panelId;
            if (dragged === null || dragged === undefined || !dragged.startsWith(FILE)) return;
            const inTabs = e.kind === 'tab' || e.kind === 'header_space';
            if (e.group !== filesGroup() || !inTabs) e.preventDefault();
        }),
        dock.onWillDrop(e => {
            const dragged = e.getData()?.panelId;
            if (dragged === null || dragged === undefined || !dragged.startsWith(FILE)) return;
            const inTabs = e.kind === 'tab' || e.kind === 'header_space';
            if (e.group !== filesGroup() || !inTabs) e.preventDefault();
        }),
    ];
    syncing = false;

    return {
        sync,
        dispose(): void {
            clearTimeout(keeping);
            media.removeEventListener('change', onMedia);
            for (const sub of subscriptions) sub.dispose();
            dock.dispose();
            void unmount(editorMounted);
        },
    };
}
