import { HELLO, PROTOCOL_VERSION, isFrameMessage, isWelcome, type AppMessage, type FrameMessage } from '@yukibana/papers-frame-protocol';

/** The app's end of the content frame's channel.
 *
 *  It says hello to the frame's window at `origin` (and again on every load of the frame, so a reloaded frame gets a
 *  new port), accepts a welcome only from that window and that origin, and from then on talks over the port alone.
 *  Messages sent before the frame answered are queued; when the frame (re)connects, `onConnect` lets the caller send
 *  the whole state again. */
export class FrameClient {
    private port: MessagePort | null = null;
    private queue: AppMessage[] = [];
    private readonly onWindowMessage = (e: MessageEvent): void => {
        if (e.origin !== this.origin || e.source !== this.frame.contentWindow || !isWelcome(e.data)) return;
        const port = e.ports[0];
        if (!port) return;
        this.port?.close();
        this.port = port;
        port.addEventListener('message', (m: MessageEvent) => {
            if (isFrameMessage(m.data)) this.onMessage(m.data);
        });
        port.start();
        this.onConnect();
        for (const msg of this.queue) port.postMessage(msg, transferables(msg));
        this.queue = [];
    };
    private readonly onLoad = (): void => this.hello();

    /** Precondition: `frame` is the content frame, whose document is served from `origin`. */
    constructor(
        private readonly frame: HTMLIFrameElement,
        private readonly origin: string,
        private readonly onMessage: (m: FrameMessage) => void,
        private readonly onConnect: () => void,
    ) {
        window.addEventListener('message', this.onWindowMessage);
        frame.addEventListener('load', this.onLoad);
    }

    private hello(): void {
        this.port?.close();
        this.port = null;
        this.frame.contentWindow?.postMessage({ kind: HELLO, version: PROTOCOL_VERSION }, this.origin);
    }

    /** Sends `m` now, or once the frame has connected. */
    send(m: AppMessage): void {
        if (this.port) this.port.postMessage(m, transferables(m));
        else this.queue.push(m);
    }

    /** Whether the frame has answered. */
    get connected(): boolean {
        return this.port !== null;
    }

    dispose(): void {
        window.removeEventListener('message', this.onWindowMessage);
        this.frame.removeEventListener('load', this.onLoad);
        this.port?.close();
    }
}

/** Nothing is transferred: the app keeps its copies of the files (the editor's models are the truth). */
function transferables(_m: AppMessage): Transferable[] {
    return [];
}
