import { describe, expect, it } from 'vitest';
import { Machine } from '../src/index.ts';
import { engine } from './support.ts';

describe.runIf(engine !== null)('a machine', () => {
    it('keeps the marks of a starting module inside the write-tracking table', () => {
        const module = engine;
        if (module === null) throw new Error('no engine');
        // A host that answers every call of the starting module with zeros where it is given a place to write, and
        // marks them or not.
        const started = (marking: boolean): Uint8Array => {
            const machine = new Machine(module);
            const host: Record<string, Record<string, (...args: number[]) => number>> = {};
            for (const i of WebAssembly.Module.imports(module)) {
                (host[i.module] ??= {})[i.name] = (...args: number[]): number => {
                    for (const p of args) {
                        machine.bytes().fill(0, p, p + 4);
                        if (marking) machine.mark(p, 4);
                    }
                    return 0;
                };
            }
            machine.start(null, host);
            const table = machine.exports.inc_dirty.value;
            const bytes = machine.bytes().slice();
            bytes.fill(0, table, table + (1 << 18));
            return bytes;
        };
        expect(Buffer.compare(started(true), started(false))).toBe(0);
    });
});
