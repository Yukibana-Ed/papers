import type { editor as Editor, IDisposable, languages, Position } from 'monaco-editor/editor/editor.api';
import { PROJECT_ROOT_URI, monaco } from '#lib/editor/monaco.ts';
import type { Reported } from '#lib/problems/model.ts';

/** A JSON-RPC message, as LSP frames them. */
interface Rpc {
    readonly jsonrpc?: '2.0';
    readonly id?: number | string;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
}

interface LspPosition {
    line: number;
    character: number;
}
interface LspRange {
    start: LspPosition;
    end: LspPosition;
}
interface LspDiagnostic {
    range: LspRange;
    severity?: number;
    message: string;
    source?: string;
}
interface LspCompletionItem {
    label: string | { label: string };
    kind?: number;
    detail?: string;
    documentation?: string | { value: string };
    insertText?: string;
    insertTextFormat?: number;
    textEdit?: { range?: LspRange; insert?: LspRange; newText: string };
    sortText?: string;
    filterText?: string;
}
interface LspHover {
    contents: string | { value: string } | (string | { value: string })[];
    range?: LspRange;
}
interface LspLocation {
    uri?: string;
    targetUri?: string;
    range?: LspRange;
    targetSelectionRange?: LspRange;
}
interface LspSymbol {
    name: string;
    kind: number;
    range?: LspRange;
    selectionRange?: LspRange;
    location?: { uri: string; range: LspRange };
    children?: LspSymbol[];
}

const toLsp = (p: Position): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: LspRange): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } => ({
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
});
/** Monaco's completion kind for an LSP one (the two enumerations order the kinds differently). */
function completionKind(kind: number | undefined): languages.CompletionItemKind {
    const K = monaco.languages.CompletionItemKind;
    const byLsp = [
        K.Text,
        K.Text,
        K.Method,
        K.Function,
        K.Constructor,
        K.Field,
        K.Variable,
        K.Class,
        K.Interface,
        K.Module,
        K.Property,
        K.Unit,
        K.Value,
        K.Enum,
        K.Keyword,
        K.Snippet,
        K.Color,
        K.File,
        K.Reference,
        K.Folder,
        K.EnumMember,
        K.Constant,
        K.Struct,
        K.Event,
        K.Operator,
        K.TypeParameter,
    ];
    return byLsp[kind ?? 1] ?? K.Text;
}

/** Monaco's symbol kind for an LSP one: the same order, counted from 0 instead of 1. */
function symbolKind(kind: number): languages.SymbolKind {
    const K = monaco.languages.SymbolKind;
    const all = [
        K.File,
        K.Module,
        K.Namespace,
        K.Package,
        K.Class,
        K.Method,
        K.Property,
        K.Field,
        K.Constructor,
        K.Enum,
        K.Interface,
        K.Function,
        K.Variable,
        K.Constant,
        K.String,
        K.Number,
        K.Boolean,
        K.Array,
        K.Object,
        K.Key,
        K.Null,
        K.EnumMember,
        K.Struct,
        K.Event,
        K.Operator,
        K.TypeParameter,
    ];
    return all[kind - 1] ?? K.Variable;
}

const text = (c: string | { value: string } | undefined): string => (c === undefined ? '' : typeof c === 'string' ? c : c.value);

/** What differs between language servers: what they are started with, the requests of their own they make, and the
 *  diagnostics the editor leaves out (ones that are the compiler's business, not the editor's). */
export interface ServerProfile {
    readonly initializationOptions?: unknown;
    readonly requests?: Readonly<Record<string, (params: unknown, client: LanguageClient) => unknown>>;
    readonly ignoreDiagnostic?: (message: string) => boolean;
}

/** How long the server may take to answer `initialize`, and any other request. */
export const INITIALIZE_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 10_000;

/** Where a language server stands, as the editor shows it: starting, ready, or unavailable with why. */
export type ServerStatus = { readonly status: 'starting' } | { readonly status: 'ready' } | { readonly status: 'unavailable'; readonly detail: string };

/** A language server in the content frame, from the editor's side: JSON-RPC over `send`/`receive`, the project's models
 *  of `languageId` kept open on the server (incremental changes), its diagnostics as markers, and completion, hover,
 *  go to definition and document symbols in Monaco.
 *
 *  It never leaves the editor waiting: `initialize` and every request time out, and while the server is not ready (still
 *  starting, or unavailable) completion, hover and the rest answer at once with nothing, so Monaco shows no "Loading...".
 *  The server reads only what the editor opens on it: the frame gives it no other access to the project. */
export class LanguageClient {
    private seq = 0;
    private readonly waiting = new Map<number | string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
    private readonly disposables: IDisposable[] = [];
    private readonly versions = new Map<string, number>();
    private ready: Promise<void>;
    private state: ServerStatus = { status: 'starting' };

    /** Precondition: `send` delivers to the server, and the server's messages are passed to `receive`. `onStatus` hears
     *  every change of the server's status. */
    constructor(
        private readonly languageId: string,
        private readonly owner: string,
        private readonly send: (message: Rpc) => void,
        private readonly profile: ServerProfile = {},
        private readonly onStatus: (s: ServerStatus) => void = () => {},
        /** Receives each file's diagnostics as well, for the Problems panel: (project path, its problems). */
        private readonly onDiagnostics?: (file: string, items: readonly Reported[]) => void,
    ) {
        this.ready = this.initialize().then(
            () => this.setStatus({ status: 'ready' }),
            (e: unknown) => this.fail(e instanceof Error ? e.message : String(e)),
        );
    }

    /** The server's status now. */
    get status(): ServerStatus {
        return this.state;
    }

    private setStatus(s: ServerStatus): void {
        if (this.state.status === 'unavailable') return;
        this.state = s;
        this.onStatus(s);
    }

    /** Marks the server unavailable (it crashed, its files are missing, the frame cannot be reached): every pending and
     *  later request answers at once. */
    fail(detail: string): void {
        if (this.state.status === 'unavailable') return;
        this.state = { status: 'unavailable', detail };
        this.onStatus(this.state);
        for (const w of this.waiting.values()) w.reject(new Error(detail));
        this.waiting.clear();
    }

    /** Handles one message from the server. */
    receive(m: Rpc): void {
        if (m.method !== undefined && m.id !== undefined) return this.serverRequest(m);
        if (m.method !== undefined) return this.notification(m.method, m.params);
        if (m.id === undefined) return;
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message));
        else w.resolve(m.result);
    }

    /** Sends a request, once the server is initialized (`initialize` itself goes at once), and resolves with its
     *  result. */
    async request<T>(method: string, params: unknown): Promise<T> {
        if (method !== 'initialize') await this.ready;
        if (this.state.status === 'unavailable') throw new Error(this.state.detail);
        return this.send1<T>(method, params, method === 'initialize' ? INITIALIZE_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    }

    private send1<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
        const id = `c${++this.seq}`;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`no answer to ${method} in ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            const done = (): void => clearTimeout(timer);
            this.waiting.set(id, {
                resolve: (r: unknown) => {
                    done();
                    resolve(r as T);
                },
                reject: (e: Error) => {
                    done();
                    reject(e);
                },
            });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    /** `ask()`'s answer when the server is ready and answers in time; `none` at once otherwise. */
    private async answer<T>(none: T, ask: () => Promise<T>): Promise<T> {
        if (this.state.status !== 'ready') return none;
        try {
            return await ask();
        } catch {
            return none;
        }
    }

    notify(method: string, params: unknown): void {
        this.send({ jsonrpc: '2.0', method, params });
    }

    /** The server asks the editor something: configuration (none: the server's defaults), progress tokens and
     *  registrations (accepted); anything else is not supported. */
    private serverRequest(m: Rpc): void {
        const id = m.id ?? 0;
        if (m.method === 'workspace/configuration') {
            const items = (m.params as { items?: unknown[] } | undefined)?.items ?? [];
            return this.send({ jsonrpc: '2.0', id, result: items.map(() => null) });
        }
        const own = m.method === undefined ? undefined : this.profile.requests?.[m.method];
        if (own) return this.send({ jsonrpc: '2.0', id, result: own(m.params, this) ?? null });
        if (m.method === 'window/workDoneProgress/create' || m.method === 'client/registerCapability' || m.method === 'client/unregisterCapability')
            return this.send({ jsonrpc: '2.0', id, result: null });
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Not supported: ${m.method ?? ''}` } });
    }

    private notification(method: string, params: unknown): void {
        if (method !== 'textDocument/publishDiagnostics') return;
        const p = params as { uri: string; diagnostics: LspDiagnostic[] };
        const prefix = `${PROJECT_ROOT_URI}/`;
        const file = p.uri.startsWith(prefix) ? decodeURIComponent(p.uri.slice(prefix.length)) : null;
        if (this.onDiagnostics && file !== null)
            this.onDiagnostics(
                file,
                p.diagnostics
                    .filter(d => !this.profile.ignoreDiagnostic?.(d.message))
                    .map(d => ({
                        file,
                        line: d.range.start.line + 1,
                        column: d.range.start.character + 1,
                        endLine: d.range.end.line + 1,
                        endColumn: d.range.end.character + 1,
                        severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
                        message: d.message,
                    })),
            );
        const model = monaco.editor.getModel(monaco.Uri.parse(p.uri));
        if (!model) return;
        monaco.editor.setModelMarkers(
            model,
            this.owner,
            p.diagnostics
                .filter(d => !this.profile.ignoreDiagnostic?.(d.message))
                .map(d =>
                    Object.assign(toRange(d.range), {
                        severity: d.severity === 1 ? monaco.MarkerSeverity.Error : d.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
                        message: d.message,
                        source: d.source ?? this.owner,
                    }),
                ),
        );
    }

    private async initialize(): Promise<void> {
        await this.request('initialize', {
            processId: null,
            rootUri: PROJECT_ROOT_URI,
            initializationOptions: this.profile.initializationOptions ?? {},
            workspaceFolders: [{ uri: PROJECT_ROOT_URI, name: 'project' }],
            capabilities: {
                textDocument: {
                    synchronization: { didSave: false, dynamicRegistration: false },
                    completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    definition: { linkSupport: true },
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    publishDiagnostics: {},
                },
                workspace: { configuration: true, workspaceFolders: true },
            },
        });
        this.notify('initialized', {});
        for (const model of monaco.editor.getModels()) this.track(model);
        this.disposables.push(monaco.editor.onDidCreateModel(model => this.track(model)));
        this.registerProviders();
    }

    /** Opens `model` on the server if it is of this client's language, and sends its changes as they happen. */
    private track(model: Editor.ITextModel): void {
        if (model.getLanguageId() !== this.languageId) return;
        const uri = model.uri.toString();
        this.versions.set(uri, 1);
        this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.languageId, version: 1, text: model.getValue() } });
        this.disposables.push(
            model.onDidChangeContent(e => {
                const version = (this.versions.get(uri) ?? 1) + 1;
                this.versions.set(uri, version);
                const contentChanges = e.changes.map(c => ({
                    range: {
                        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
                        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
                    },
                    rangeLength: c.rangeLength,
                    text: c.text,
                }));
                this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges });
            }),
            model.onWillDispose(() => this.notify('textDocument/didClose', { textDocument: { uri } })),
        );
    }

    private registerProviders(): void {
        const id = this.languageId;
        const doc = (model: Editor.ITextModel): { uri: string } => ({ uri: model.uri.toString() });
        this.disposables.push(
            monaco.languages.registerCompletionItemProvider(id, {
                triggerCharacters: ['#', '.', '@', '(', '"', '/', '<', '$'],
                provideCompletionItems: (model, position): Promise<languages.CompletionList> =>
                    this.answer({ suggestions: [] }, async (): Promise<languages.CompletionList> => {
                        const r = await this.request<LspCompletionItem[] | { items: LspCompletionItem[] } | null>('textDocument/completion', {
                            textDocument: doc(model),
                            position: toLsp(position),
                        });
                        const items = Array.isArray(r) ? r : (r?.items ?? []);
                        const word = model.getWordUntilPosition(position);
                        const fallback = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
                        return {
                            suggestions: items.map(i => {
                                const edit = i.textEdit;
                                const range = edit?.range ?? edit?.insert;
                                const suggestion: languages.CompletionItem = {
                                    label: typeof i.label === 'string' ? i.label : i.label.label,
                                    kind: completionKind(i.kind),
                                    insertText: edit?.newText ?? i.insertText ?? (typeof i.label === 'string' ? i.label : i.label.label),
                                    range: range ? toRange(range) : fallback,
                                };
                                if (i.detail !== undefined) suggestion.detail = i.detail;
                                if (i.documentation !== undefined) suggestion.documentation = { value: text(i.documentation) };
                                if (i.insertTextFormat === 2) suggestion.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
                                if (i.sortText !== undefined) suggestion.sortText = i.sortText;
                                if (i.filterText !== undefined) suggestion.filterText = i.filterText;
                                return suggestion;
                            }),
                        };
                    }),
            }),
            monaco.languages.registerHoverProvider(id, {
                provideHover: (model, position): Promise<languages.Hover | null> =>
                    this.answer(null, async (): Promise<languages.Hover | null> => {
                        const h = await this.request<LspHover | null>('textDocument/hover', { textDocument: doc(model), position: toLsp(position) });
                        if (!h) return null;
                        const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
                        return { contents: parts.map(p => ({ value: text(p) })), ...(h.range ? { range: toRange(h.range) } : {}) };
                    }),
            }),
            monaco.languages.registerDefinitionProvider(id, {
                provideDefinition: (model, position): Promise<languages.Location[]> =>
                    this.answer([], async (): Promise<languages.Location[]> => {
                        const r = await this.request<LspLocation | LspLocation[] | null>('textDocument/definition', { textDocument: doc(model), position: toLsp(position) });
                        const list = r === null ? [] : Array.isArray(r) ? r : [r];
                        return list.flatMap(l => {
                            const uri = l.targetUri ?? l.uri;
                            const range = l.targetSelectionRange ?? l.range;
                            return uri && range ? [{ uri: monaco.Uri.parse(uri), range: toRange(range) }] : [];
                        });
                    }),
            }),
            monaco.languages.registerDocumentSymbolProvider(id, {
                provideDocumentSymbols: (model): Promise<languages.DocumentSymbol[]> =>
                    this.answer([], async (): Promise<languages.DocumentSymbol[]> => {
                        const r = await this.request<LspSymbol[] | null>('textDocument/documentSymbol', { textDocument: doc(model) });
                        const map = (s: LspSymbol): languages.DocumentSymbol => {
                            const range = s.range ?? s.location?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                            return {
                                name: s.name,
                                detail: '',
                                kind: symbolKind(s.kind),
                                tags: [],
                                range: toRange(range),
                                selectionRange: toRange(s.selectionRange ?? range),
                                children: (s.children ?? []).map(map),
                            };
                        };
                        return (r ?? []).map(map);
                    }),
            }),
        );
    }

    /** Resolves once the server has answered `initialize` and the models are open on it. */
    whenReady(): Promise<void> {
        return this.ready;
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        for (const model of monaco.editor.getModels()) if (model.getLanguageId() === this.languageId) monaco.editor.setModelMarkers(model, this.owner, []);
        for (const w of this.waiting.values()) w.reject(new Error('Language server stopped'));
        this.waiting.clear();
    }
}
