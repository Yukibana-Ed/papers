// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELLO, PROTOCOL_VERSION, READY, WELCOME, type AppMessage, type FrameMessage } from '@yukibana/papers-frame-protocol';
import { FrameClient, collapseQueue } from '#lib/preview/frame-client.ts';

const ORIGIN = 'https://content.test';

/** A MessagePort that records what the app posts and lets the test speak for the frame. */
class FakePort extends EventTarget {
    readonly posted: unknown[] = [];
    closed = false;
    postMessage(m: unknown): void {
        this.posted.push(m);
    }
    start(): void {}
    close(): void {
        this.closed = true;
    }
    say(m: FrameMessage | Record<string, unknown>): void {
        this.dispatchEvent(new MessageEvent('message', { data: m }));
    }
}

function setup(): { frame: HTMLIFrameElement; hellos: unknown[]; welcome: (from?: { origin?: string; source?: unknown }) => FakePort } {
    const hellos: unknown[] = [];
    // happy-dom loads no frames: an element with a stand-in window is enough for the client.
    const win = { postMessage: (m: unknown) => hellos.push(m) };
    const frame = Object.assign(new EventTarget(), { contentWindow: win }) as unknown as HTMLIFrameElement;
    const welcome = (from: { origin?: string; source?: unknown } = {}): FakePort => {
        const port = new FakePort();
        const e = new MessageEvent('message', { data: { kind: WELCOME, version: PROTOCOL_VERSION }, origin: from.origin ?? ORIGIN });
        Object.defineProperty(e, 'source', { value: 'source' in from ? from.source : win });
        Object.defineProperty(e, 'ports', { value: [port] });
        window.dispatchEvent(e);
        return port;
    };
    return { frame, hellos, welcome };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('FrameClient', () => {
    it('says hello on load and when the frame says it is ready, and talks over the port of a welcome', () => {
        const { frame, hellos, welcome } = setup();
        const got: FrameMessage[] = [];
        const connects: boolean[] = [];
        const c = new FrameClient(
            frame,
            ORIGIN,
            m => got.push(m),
            again => connects.push(again),
        );
        frame.dispatchEvent(new Event('load'));
        const ready = new MessageEvent('message', { data: { kind: READY, version: PROTOCOL_VERSION }, origin: ORIGIN });
        Object.defineProperty(ready, 'source', { value: frame.contentWindow });
        window.dispatchEvent(ready);
        expect(hellos).toEqual([
            { kind: HELLO, version: PROTOCOL_VERSION },
            { kind: HELLO, version: PROTOCOL_VERSION },
        ]);
        c.send({ type: 'zoom', zoom: 1.5 });
        const port = welcome();
        expect(connects).toEqual([false]);
        expect(port.posted).toEqual([{ type: 'zoom', zoom: 1.5 }]);
        c.send({ type: 'theme', dark: true });
        expect(port.posted.at(-1)).toEqual({ type: 'theme', dark: true });
        port.say({ type: 'scale', scale: 2 });
        port.say({ type: 'scale', scale: -1 });
        port.say({ type: 'nonsense' });
        expect(got).toEqual([{ type: 'scale', scale: 2 }]);
        c.dispose();
    });

    it('ignores a welcome from another origin or window', () => {
        const { frame, welcome } = setup();
        const connects: boolean[] = [];
        const c = new FrameClient(
            frame,
            ORIGIN,
            () => {},
            again => connects.push(again),
        );
        welcome({ origin: 'https://evil.test' });
        welcome({ source: window });
        expect(connects).toEqual([]);
        c.dispose();
    });

    it('on a reload, drops the old port, queues, and says it is a reconnection', () => {
        const { frame, welcome } = setup();
        const connects: boolean[] = [];
        const c = new FrameClient(
            frame,
            ORIGIN,
            () => {},
            again => connects.push(again),
        );
        const first = welcome();
        frame.dispatchEvent(new Event('load'));
        expect(first.closed).toBe(true);
        c.send({ type: 'lsp', server: 'tinymist', message: { id: 1 } });
        c.send({ type: 'marks', marks: [] });
        const second = welcome();
        expect(connects).toEqual([false, true]);
        expect(second.posted).toEqual([{ type: 'marks', marks: [] }]);
        expect(first.posted).toEqual([]);
        c.dispose();
        expect(second.closed).toBe(true);
    });
});

describe('collapseQueue', () => {
    const queue: AppMessage[] = [
        { type: 'project', files: {}, root: 'a.tex', engine: 'pdflatex' },
        { type: 'files', changes: [{ path: 'a.tex', contents: 'x' }] },
        { type: 'zoom', zoom: 1 },
        { type: 'lsp-start', server: 'tinymist' },
        { type: 'centre?' },
        { type: 'zoom', zoom: 2 },
        { type: 'lsp', server: 'tinymist', message: { id: 1 } },
        { type: 'centre?' },
        { type: 'theme', dark: false },
    ];

    it('keeps the last of each state message, every question, and the language-server messages in order', () => {
        expect(collapseQueue(queue, false)).toEqual([
            { type: 'lsp-start', server: 'tinymist' },
            { type: 'centre?' },
            { type: 'zoom', zoom: 2 },
            { type: 'lsp', server: 'tinymist', message: { id: 1 } },
            { type: 'centre?' },
            { type: 'theme', dark: false },
        ]);
    });

    it('drops the language-server messages of a frame that reloaded', () => {
        expect(collapseQueue(queue, true).map(m => m.type)).toEqual(['centre?', 'zoom', 'centre?', 'theme']);
    });
});
