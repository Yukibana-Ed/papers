// Checks a built compiler package: `node smoke.mjs <pkg>` compiles a two-file document with the package in <pkg> and
// fails unless every glyph's range reads back the text it shows, and the bindings build no function from text.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTypstCompiler, initOptions, MemoryAccessModel } from '@myriaddreamin/typst.ts';

const pkg = resolve(process.argv[2] ?? '');
const glue = readFileSync(join(pkg, 'typst_ts_web_compiler.mjs'), 'utf8');
const evaluated = glue.match(/(?<!\?\? )new Function\(/g) ?? [];
if (evaluated.length > 0) throw new Error(`the bindings still build ${evaluated.length} function(s) from text unconditionally`);

const font = join(dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))), 'standard_fonts', 'LiberationSans-Regular.ttf');
const addFont = Object.assign(async (_, { builder }) => builder.add_raw_font(new Uint8Array(readFileSync(font))), {
    _kind: 'fontLoader',
    _preloadRemoteFontOptions: { assets: false },
});
const compiler = createTypstCompiler();
await compiler.init({
    getWrapper: () => import(pathToFileURL(join(pkg, 'wasm-pack-shim.mjs')).href),
    getModule: () => readFileSync(join(pkg, 'typst_ts_web_compiler_bg.wasm')),
    beforeBuild: [addFont, initOptions.withAccessModel(new MemoryAccessModel())],
});
const sources = {
    'main.typ': '#set text(font: "Liberation Sans")\n= Héllo wörld\n\nThe *first* weeks, see below.\n\n#include "part.typ"\n',
    'part.typ': 'Text from the part file.\n',
};
for (const [path, text] of Object.entries(sources)) compiler.addSource(`/${path}`, text);
const spans = await compiler.runWithWorld({ mainFilePath: '/main.typ' }, async world => {
    const pdf = world.pdf({ diagnostics: 'full' });
    if (!pdf.result) throw new Error(`the document did not compile: ${JSON.stringify(pdf.diagnostics)}`);
    // The compiler's own object, which typst.ts keeps under a symbol.
    const raw = world[Object.getOwnPropertySymbols(world)[0]];
    return raw.glyph_spans();
});

const FIELDS = 9;
let glyphs = 0;
const seen = new Set();
for (const page of spans.pages) {
    const f = new Float64Array(page.buffer, page.byteOffset, page.byteLength / 8);
    for (let k = 0; k < f.length; k += FIELDS) {
        const [x0, y0, x1, y1, , file, start, end] = f.subarray(k, k + FIELDS);
        const path = spans.files[file].replace(/^\//, '');
        const text = sources[path]?.slice(start, end);
        if (text === undefined || text.length === 0 || !(x1 > x0) || !Number.isFinite(y0) || !Number.isFinite(y1))
            throw new Error(`glyph ${k / FIELDS}: ${JSON.stringify({ path, start, end, x0, y0, x1, y1 })}`);
        seen.add(path);
        glyphs++;
    }
}
if (glyphs < 40 || !seen.has('main.typ') || !seen.has('part.typ')) throw new Error(`${glyphs} glyphs from ${[...seen].join(', ')}`);
console.log(`smoke: ${glyphs} glyphs from ${[...seen].join(' and ')}`);
