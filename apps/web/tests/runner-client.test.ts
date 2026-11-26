import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_PROTOCOL } from '@yukibana/papers-runner/protocol';
import { RunnerClient, type LocalBuild, type RunnerEvents } from '#lib/runner/client.ts';

class FakeSocket extends EventTarget {
    static readonly OPEN = 1;
    static all: FakeSocket[] = [];
    readyState = 0;
    binaryType = 'blob';
    readonly sent: unknown[] = [];
    constructor(readonly url: string) {
        super();
        FakeSocket.all.push(this);
    }
    send(data: string): void {
        this.sent.push(JSON.parse(data));
    }
    close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
    open(): void {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }
    say(m: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: m instanceof ArrayBuffer ? m : JSON.stringify(m) }));
    }
}

function events(): RunnerEvents & { log: string[]; builds: LocalBuild[] } {
    const log: string[] = [];
    const builds: LocalBuild[] = [];
    return {
        log,
        builds,
        ready: i => log.push(`ready:${i.toolchain}`),
        status: s => log.push(`status:${s}`),
        built: b => builds.push(b),
        closed: r => log.push(`closed:${r}`),
    };
}

function socket(): FakeSocket {
    const ws = FakeSocket.all.at(-1);
    if (!ws) throw new Error('no socket');
    return ws;
}

const READY = { type: 'ready', protocol: RUNNER_PROTOCOL, sandbox: 'none', toolchain: 'TinyTeX' };

beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('RunnerClient', () => {
    it('says hello with the token, and runs a build asked for before the server was ready once it is', () => {
        const on = events();
        const c = new RunnerClient('tok', on);
        const ws = socket();
        c.build({ 'a.tex': 'x' }, 'a.tex');
        ws.open();
        expect(ws.sent).toEqual([{ type: 'hello', token: 'tok', protocol: RUNNER_PROTOCOL }]);
        ws.say(READY);
        expect(on.log).toEqual(['ready:TinyTeX']);
        expect(ws.sent.slice(1)).toEqual([
            { type: 'project', files: { 'a.tex': { text: 'x' } } },
            { type: 'build', id: 'b1', root: 'a.tex' },
        ]);
        c.close();
    });

    it('sends only what changed, and shows only the latest build with its outputs', () => {
        const on = events();
        const c = new RunnerClient('tok', on);
        const ws = socket();
        ws.open();
        ws.say(READY);
        c.build({ 'a.tex': 'x', 'b.tex': 'y' }, 'a.tex');
        c.build({ 'a.tex': 'x2' }, 'a.tex');
        expect(ws.sent.slice(-2)).toEqual([
            {
                type: 'files',
                changes: [
                    { path: 'a.tex', body: { text: 'x2' } },
                    { path: 'b.tex', body: null },
                ],
            },
            { type: 'build', id: 'b2', root: 'a.tex' },
        ]);
        ws.say({ type: 'status', id: 'b1', step: 'pdflatex' });
        ws.say({ type: 'built', id: 'b1', ok: true, pages: 1, ms: 5, diagnostics: [] });
        ws.say({ type: 'status', id: 'b2', step: 'bibtex' });
        ws.say({ type: 'artifact', id: 'b2', name: 'pdf', bytes: 3 });
        ws.say(new Uint8Array([1, 2, 3]).buffer);
        ws.say({ type: 'built', id: 'b2', ok: true, pages: 2, ms: 9, diagnostics: [] });
        expect(on.log).toEqual(['ready:TinyTeX', 'status:bibtex']);
        expect(on.builds).toHaveLength(1);
        expect(on.builds[0]).toMatchObject({ pages: 2, synctex: null });
        expect([...(on.builds[0]?.pdf ?? [])]).toEqual([1, 2, 3]);
        c.close();
    });

    it('reports closed once when the server refuses, and closes the socket', () => {
        const on = events();
        const c = new RunnerClient('bad', on);
        const ws = socket();
        ws.open();
        ws.say({ type: 'error', message: 'Wrong token' });
        expect(ws.readyState).toBe(3);
        expect(on.log).toEqual(['closed:Wrong token']);
        c.build({ 'a.tex': 'x' }, 'a.tex');
        expect(ws.sent).toHaveLength(1);
    });

    it('reports nothing after close, so a replaced client cannot undo its successor', () => {
        const on = events();
        const c = new RunnerClient('tok', on);
        const ws = socket();
        ws.open();
        ws.say(READY);
        c.close();
        ws.say({ type: 'status', id: 'b1', step: 'x' });
        expect(on.log).toEqual(['ready:TinyTeX']);
    });
});
