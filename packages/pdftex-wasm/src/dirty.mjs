// Write tracking for a WebAssembly module: every instruction that writes memory first sets a byte in a table,
// one byte per 4 KiB page, so that a host can copy and restore only the pages a run wrote.
//
//   node dirty.mjs <in.wasm> <out.wasm>
//
// The module must export a global `inc_dirty` (the table's address: 1 byte per page of the largest memory) and
// a function `inc_mark_range(addr, len)` that marks a range. A store of at most 16 bytes at address a marks the
// page of a; it may also reach into the next page, so the host treats a marked page p as "p and p + 1".
// The pass fails on any memory-writing instruction it does not know.
import binaryen from 'binaryen';
import fs from 'node:fs';

const [inFile, outFile] = process.argv.slice(2);
const mod = binaryen.readBinary(fs.readFileSync(inFile));
{
    const F = binaryen.Features;
    mod.setFeatures(F.MVP | F.BulkMemory | F.BulkMemoryOpt | F.ExceptionHandling | F.SignExt | F.MutableGlobals | F.NontrappingFPToInt | F.Multivalue | F.ReferenceTypes);
}
const ex = name => {
    for (let i = 0; i < mod.getNumExports(); i++) {
        const e = binaryen.getExportInfo(mod.getExportByIndex(i));
        if (e.name === name) return e;
    }
    throw new Error('no export ' + name);
};
const table = binaryen.getExpressionInfo(binaryen.getGlobalInfo(mod.getGlobal(ex('inc_dirty').value)).init).value;
const markRange = ex('inc_mark_range').value;
const I = binaryen;
const ids = Object.fromEntries(
    Object.entries(I)
        .filter(([k, v]) => k.endsWith('Id') && typeof v === 'number')
        .map(([k, v]) => [v, k.slice(0, -2)]),
);

// the children of an expression, by kind (only the kinds a C compiler emits; anything else stops the pass)
const kids = {
    Block: e => e.children,
    If: e => [e.condition, e.ifTrue, e.ifFalse],
    Loop: e => [e.body],
    Break: e => [e.condition, e.value],
    Switch: e => [e.condition, e.value],
    Call: e => e.operands,
    CallIndirect: e => [...e.operands, e.target],
    LocalGet: () => [],
    LocalSet: e => [e.value],
    GlobalGet: () => [],
    GlobalSet: e => [e.value],
    Load: e => [e.ptr],
    Store: e => [e.ptr, e.value],
    Const: () => [],
    Unary: e => [e.value],
    Binary: e => [e.left, e.right],
    Select: e => [e.ifTrue, e.ifFalse, e.condition],
    Drop: e => [e.value],
    Return: e => [e.value],
    MemorySize: () => [],
    MemoryGrow: e => [e.delta],
    Nop: () => [],
    Unreachable: () => [],
    MemoryCopy: e => [e.dest, e.source, e.size],
    MemoryFill: e => [e.dest, e.value, e.size],
    Try: e => [e.body, ...e.catchBodies],
    Throw: e => e.operands,
    Rethrow: () => [],
    RefFunc: () => [],
    RefNull: () => [],
    RefIsNull: e => [e.value],
    TableGet: e => [e.index],
    TableSet: e => [e.index, e.value],
    TableSize: () => [],
    Pop: () => [],
};
let stores = 0,
    bulk = 0,
    funcs = 0;
const names = [];
for (let i = 0; i < mod.getNumFunctions(); i++) names.push(binaryen.getFunctionInfo(mod.getFunctionByIndex(i)));
for (const f of names) {
    if (!f.body || f.name === markRange) continue;
    const params = binaryen.expandType(f.params);
    const a = params.length + f.vars.length; // new i32 locals: one for stores, two for each bulk write
    let extra = 1,
        used = false;
    const stack = [f.body];
    while (stack.length) {
        const e = stack.pop();
        if (!e) continue;
        const kind = ids[binaryen.getExpressionId(e)];
        if (kind === 'Unreachable' || kind === 'Nop' || kind === 'Pop') continue;
        if (!kids[kind]) throw new Error(`${f.name}: instruction kind ${kind ?? binaryen.getExpressionId(e)} is not known to the write tracker`);
        let info;
        try {
            info = binaryen.getExpressionInfo(e);
        } catch {
            throw new Error(`${f.name}: binaryen.js cannot describe a ${kind}`);
        }
        for (const c of kids[kind](info)) if (c) stack.push(c);
        if (kind === 'Store') {
            if (info.bytes > 16) throw new Error('store wider than 16 bytes');
            const addr = info.offset ? mod.i32.add(mod.local.tee(a, info.ptr, I.i32), mod.i32.const(info.offset)) : mod.local.tee(a, info.ptr, I.i32);
            const mark = mod.i32.store8(table, 1, mod.i32.shr_u(addr, mod.i32.const(12)), mod.i32.const(1));
            I.Store.setPtr(e, mod.block(null, [mark, mod.local.get(a, I.i32)], I.i32));
            stores++;
            used = true;
        } else if (kind === 'MemoryCopy' || kind === 'MemoryFill') {
            const K = I[kind],
                d = a + extra,
                n = d + 1;
            extra += 2;
            K.setDest(e, mod.local.tee(d, info.dest, I.i32));
            K.setSize(
                e,
                mod.block(null, [mod.local.set(n, info.size), mod.call(markRange, [mod.local.get(d, I.i32), mod.local.get(n, I.i32)], I.none), mod.local.get(n, I.i32)], I.i32),
            );
            bulk++;
            used = true;
        }
    }
    if (!used) continue;
    mod.removeFunction(f.name);
    mod.addFunction(f.name, f.params, f.results, [...f.vars, ...Array(extra).fill(I.i32)], f.body);
    funcs++;
}
mod.addGlobal('inc_tracked', I.i32, false, mod.i32.const(1));
mod.addGlobalExport('inc_tracked', 'inc_tracked'); // tells the host that marks are complete
if (!mod.validate()) throw new Error('the instrumented module does not validate');
binaryen.setOptimizeLevel(2);
binaryen.setShrinkLevel(0);
if (process.env.DIRTY_OPT !== '0') mod.optimize();
fs.writeFileSync(outFile, mod.emitBinary());
console.log(`write tracking: ${stores} stores, ${bulk} bulk writes in ${funcs} functions, table at ${table}`);
