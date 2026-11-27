import { HELLO, PROTOCOL_VERSION, isFrameMessage, isReady, isWelcome, type AppMessage, type FrameMessage } from '@yukibana/papers-frame-protocol';

/** The app's end of the content frame's channel.
 *
 *  It says hello to the frame's window at `origin` (and again on every load of the frame, so a reloaded frame gets a
 *  new port), accepts a welcome only from that window and that origin, and from then on talks over the port alone.
 *  Messages sent before the frame answered are queued, collapsed by `collapseQueue`; when the frame (re)connects,
 *  `onConnect` is called first, and must send the whole project (`project`, which the queued `project` and `files`
 *  messages are dropped for). Its argument says whether this is a reconnection: a reloaded frame has lost its
 *  language servers, and the queued language-server messages of the old ones are dropped. */
export class FrameClient {
    private port: MessagePort | null = null;
    private queue: AppMessage[] = [];
    private connections = 0;
    private readonly onWindowMessage = (e: MessageEvent): void => {
        if (e.origin !== this.origin || e.source !== this.frame.contentWindow) return;
        // The frame's code runs after its load event may have fired: it says when it is ready to be greeted.
        if (isReady(e.data)) return this.hello();
        if (!isWelcome(e.data)) return;
        const port = e.ports[0];
        if (!port) return;
        this.port?.close();
        this.port = port;
        port.addEventListener('message', (m: MessageEvent) => {
            if (isFrameMessage(m.data)) this.onMessage(m.data);
        });
        port.start();
        const again = this.connections++ > 0;
        const queued = collapseQueue(this.queue, again);
        this.queue = [];
        this.onConnect(again);
        for (const msg of queued) port.postMessage(msg, []);
    };
    private readonly onLoad = (): void => this.hello();

    /** Precondition: `frame` is the content frame, whose document is served from `origin`. */
    constructor(
        private readonly frame: HTMLIFrameElement,
        private readonly origin: string,
        private readonly onMessage: (m: FrameMessage) => void,
        private readonly onConnect: (reconnected: boolean) => void,
    ) {
        window.addEventListener('message', this.onWindowMessage);
        frame.addEventListener('load', this.onLoad);
    }

    private hello(): void {
        this.port?.close();
        this.port = null;
        this.frame.contentWindow?.postMessage({ kind: HELLO, version: PROTOCOL_VERSION }, this.origin);
    }

    /** Sends `m` now, or once the frame has connected. Nothing is transferred (the empty list): the app keeps its
     *  copies of the files, the editor's models being the truth. */
    send(m: AppMessage): void {
        if (this.port) this.port.postMessage(m, []);
        else this.queue.push(m);
    }

    dispose(): void {
        window.removeEventListener('message', this.onWindowMessage);
        this.frame.removeEventListener('load', this.onLoad);
        this.port?.close();
        this.port = null;
        this.queue = [];
    }
}

/** The messages that each replace the frame's whole state of one kind: only the last of each is worth sending. */
const LATEST_ONLY: ReadonlySet<AppMessage['type']> = new Set(['root', 'reveal', 'mirror', 'marks', 'presence', 'zoom', 'theme', 'builder', 'output']);

/** What of `queue` (in the order sent) still matters to a frame that has just connected and been sent the whole
 *  project: no `project`, `files` or `print`, the last message of each kind in `LATEST_ONLY`, every `centre?` (someone waits
 *  for each answer), and the language-server messages in order, unless `reconnected` (they were for a frame that is
 *  gone). Promises: the kept messages keep their relative order. */
export function collapseQueue(queue: readonly AppMessage[], reconnected: boolean): AppMessage[] {
    const last = new Map<AppMessage['type'], number>();
    queue.forEach((m, i) => last.set(m.type, i));
    return queue.filter((m, i) => {
        if (m.type === 'project' || m.type === 'files') return false;
        // A print or a download asked for before the frame was there has nothing to give.
        if (m.type === 'print' || m.type === 'download') return false;
        if (LATEST_ONLY.has(m.type)) return last.get(m.type) === i;
        if (m.type === 'lsp' || m.type === 'lsp-start' || m.type === 'lsp-stop') return !reconnected;
        return true;
    });
}
