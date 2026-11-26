import { isAppMessage, isHello, PROTOCOL_VERSION, READY, WELCOME, type AppMessage, type FrameMessage, type Ready, type Welcome } from '@yukibana/papers-frame-protocol';

/** The frame's side of the connection to the app.
 *
 *  Waits for the app's `hello` on `window`, accepts it only from `appOrigin` and only from the parent window, and
 *  answers `welcome` with a fresh MessagePort; every later message, both ways, goes over that port. A second `hello`
 *  (the app reloaded its side) replaces the port. Messages that arrive on `window` from anywhere else are ignored. */
export class Bridge {
    #port: MessagePort | null = null;
    readonly #appOrigin: string;
    readonly #onMessage: (m: AppMessage) => void;
    readonly #onConnect: () => void;

    /** Precondition: `appOrigin` is an origin. `onConnect` runs after each accepted handshake, before any message. */
    constructor(appOrigin: string, onMessage: (m: AppMessage) => void, onConnect: () => void) {
        this.#appOrigin = appOrigin;
        this.#onMessage = onMessage;
        this.#onConnect = onConnect;
        window.addEventListener('message', this.#onWindowMessage);
        // A hello that came before this code ran, kept by the inline script in app.html; then tell the app we are here.
        // In a microtask, so that whoever constructs this has finished before `onConnect` runs.
        const early: unknown = Reflect.get(window, '__ykEarly');
        Reflect.deleteProperty(window, '__ykEarly');
        queueMicrotask(() => {
            if (Array.isArray(early)) for (const e of early) if (e instanceof MessageEvent) this.#onWindowMessage(e);
            if (this.#port === null && window.parent !== window) {
                const ready: Ready = { kind: READY, version: PROTOCOL_VERSION };
                window.parent.postMessage(ready, appOrigin);
            }
        });
    }

    #onWindowMessage = (event: MessageEvent<unknown>): void => {
        if (event.origin !== this.#appOrigin || event.source !== window.parent || !isHello(event.data)) return;
        this.#port?.close();
        const channel = new MessageChannel();
        this.#port = channel.port1;
        this.#port.addEventListener('message', (e: MessageEvent<unknown>): void => {
            if (isAppMessage(e.data)) this.#onMessage(e.data);
        });
        this.#port.start();
        const welcome: Welcome = { kind: WELCOME, version: PROTOCOL_VERSION };
        window.parent.postMessage(welcome, this.#appOrigin, [channel.port2]);
        this.#onConnect();
    };

    /** Sends `m` to the app; dropped while not connected. */
    send(m: FrameMessage): void {
        this.#port?.postMessage(m);
    }

    get connected(): boolean {
        return this.#port !== null;
    }

    dispose(): void {
        window.removeEventListener('message', this.#onWindowMessage);
        this.#port?.close();
        this.#port = null;
    }
}
