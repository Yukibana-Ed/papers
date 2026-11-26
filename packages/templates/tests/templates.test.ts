import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    ArchiveError,
    detect,
    escapeFor,
    parseIndex,
    parseRepoLink,
    parseTemplateToml,
    parseUniverseSpec,
    planFiles,
    repositoryName,
    safeFolder,
    safePath,
    unzip,
    untargz,
    zipTemplate,
    type Template,
} from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const files = (o: Record<string, string>): Map<string, Uint8Array> => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));

/** A zip with each file deflated (or stored when `store`), as an archiver writes one. */
function zip(entries: Record<string, string | Uint8Array>, store = false): Uint8Array {
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of Object.entries(entries)) {
        const data = Buffer.from(typeof content === 'string' ? enc.encode(content) : content);
        const body = store ? data : deflateRawSync(data);
        const n = Buffer.from(name);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(store ? 0 : 8, 8);
        h.writeUInt32LE(body.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(n.length, 26);
        local.push(h, n, body);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(store ? 0 : 8, 10);
        c.writeUInt32LE(body.length, 20);
        c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(n.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, n);
        offset += 30 + n.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...local, cd, end]));
}

function tgz(entries: Record<string, string>): Uint8Array {
    const parts: Buffer[] = [];
    for (const [name, content] of Object.entries(entries)) {
        const data = Buffer.from(content);
        const h = Buffer.alloc(512);
        h.write(name, 0);
        h.write(data.length.toString(8).padStart(11, '0'), 124);
        h.write('0', 156);
        parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

describe('paths', () => {
    it('keeps project paths and refuses escapes', () => {
        expect(safePath('sections/intro.tex')).toBe('sections/intro.tex');
        expect(safePath('./a\\b.tex')).toBe('a/b.tex');
        for (const bad of ['../x', '/etc/passwd', 'C:/x', 'a//b', 'a/./b', 'con:x', '', 'a/b.']) expect(safePath(bad)).toBeNull();
        expect(safeFolder(' papers/2026/ ')).toBe('papers/2026');
        expect(safeFolder('')).toBe('');
        expect(repositoryName('  Instant Feedback: a Study!  ')).toBe('Instant-Feedback-a-Study');
        expect(repositoryName('Über Café')).toBe('Uber-Cafe');
    });
});

describe('manifests', () => {
    it('reads template.toml', () => {
        const info = parseTemplateToml(
            'name = "Article"\ndescription = "d"\ncategory = "paper"\nformat = "latex"\nengine = "pdflatex"\nroot = "main.tex"\nlicence = "0BSD"\nthumbnail = "thumbnail.png"\n\n[fields]\ntitle = { text = "T" }\nauthors = { text = "A \\\\and B", join = " \\\\and " }\n',
        );
        expect(info).toMatchObject({ name: 'Article', format: 'latex', root: 'main.tex', fields: { title: { text: 'T' }, authors: { text: 'A \\and B', join: ' \\and ' } } });
        expect(() => parseTemplateToml('name = "x"\nformat = "word"\nengine = "pdflatex"\nroot = "a.tex"')).toThrow(/format/);
        expect(() => parseTemplateToml('name = "x"\nformat = "latex"\nengine = "pdflatex"\nroot = "../a.tex"')).toThrow(/root/);
    });

    it('reads the gallery index and skips broken entries', () => {
        const entry = {
            id: 'a',
            name: 'A',
            format: 'typst',
            engine: 'typst',
            root: 'main.typ',
            licence: '0BSD',
            thumbnail: 'thumbnail.png',
            files: ['main.typ'],
            fields: {},
            seeAlso: [],
        };
        const list = parseIndex({ version: 1, templates: [entry, { ...entry, id: 'b', files: ['../x'] }, { ...entry, id: 'c', engine: 'word' }] });
        expect(list.map(t => t.id)).toEqual(['a']);
        expect(() => parseIndex({ version: 2 })).toThrow();
    });
});

describe('detection', () => {
    it('prefers papers.toml, then the shallowest document', () => {
        expect(
            detect(files({ 'a.tex': '\\documentclass{article}', 'papers.toml': '[[document]]\nroot = "b.tex"\nengine = "lualatex"', 'b.tex': '\\documentclass{article}' })),
        ).toEqual({
            format: 'latex',
            root: 'b.tex',
            engine: 'lualatex',
        });
        expect(detect(files({ 'sub/main.tex': '\\documentclass{article}', 'paper.tex': '% \\documentclass{x}\n\\documentclass{report}', 'ch1.tex': '\\section{A}' })).root).toBe(
            'paper.tex',
        );
        expect(detect(files({ 'x.tex': '\\documentclass{article}\\usepackage{fontspec}' })).engine).toBe('xelatex');
        expect(detect(files({ 'lib.typ': '#let x = 1', 'main.typ': '= Hi' }))).toEqual({ format: 'typst', root: 'main.typ', engine: 'typst' });
        expect(() => detect(files({ 'notes.md': '# x' }))).toThrow(/No document/);
    });
});

describe('planning', () => {
    const t: Template = {
        info: {
            name: 'A',
            description: '',
            category: 'paper',
            format: 'latex',
            engine: 'pdflatex',
            root: 'main.tex',
            licence: '0BSD',
            fields: { title: { text: 'The Title' }, authors: { text: 'First \\and Second', join: ' \\and ' } },
            seeAlso: [],
        },
        files: new Map([
            ['main.tex', enc.encode('\\title{The Title}\\author{First \\and Second}')],
            ['refs.bib', enc.encode('@book{x,}')],
            ['template.toml', enc.encode('x')],
            ['thumbnail.png', new Uint8Array([137, 80, 78, 71, 0])],
            ['fig.png', new Uint8Array([137, 80, 78, 71, 0])],
        ]),
        origin: 'test',
    };

    it('puts the files under the folder with the title and authors in', () => {
        const p = planFiles(t, { folder: 'papers/feedback', title: 'Fast & Free: 100% Feedback', authors: ['Ada Varga', 'Lena Kraus'] });
        expect(p.root).toBe('papers/feedback/main.tex');
        expect(p.files.map(f => f.path)).toEqual(['papers/feedback/fig.png', 'papers/feedback/main.tex', 'papers/feedback/papers.toml', 'papers/feedback/refs.bib']);
        expect(dec.decode(p.files.find(f => f.path.endsWith('main.tex'))?.bytes)).toBe('\\title{Fast \\& Free: 100\\% Feedback}\\author{Ada Varga \\and Lena Kraus}');
        expect(p.files.find(f => f.path.endsWith('fig.png'))?.bytes).toEqual(new Uint8Array([137, 80, 78, 71, 0]));
        expect(dec.decode(p.files.find(f => f.path.endsWith('papers.toml'))?.bytes)).toContain(
            'texlive = "2026"\n\n[[document]]\nroot = "main.tex"\nengine = "pdflatex"\nbibliography = "bibtex"',
        );
    });

    it('refuses a folder outside the repository', () => {
        expect(() => planFiles(t, { folder: '../x' })).toThrow();
    });

    it('escapes per language', () => {
        expect(escapeFor('typst', 'C# and @me')).toBe('C\\# and \\@me');
        expect(escapeFor('latex', 'a_b ~ c')).toBe('a\\_b \\textasciitilde{} c');
    });
});

describe('archives', () => {
    it('unzips deflated and stored entries, skipping macOS metadata', async () => {
        for (const store of [false, true]) {
            const out = await unzip(zip({ 'main.tex': '\\documentclass{article}', 'img/a.png': new Uint8Array([1, 2, 3]), '__MACOSX/._main.tex': 'x' }, store));
            expect([...out.keys()].toSorted()).toEqual(['img/a.png', 'main.tex']);
            expect(out.get('img/a.png')).toEqual(new Uint8Array([1, 2, 3]));
        }
    });

    it('refuses unsafe paths, too many files and bombs', async () => {
        await expect(unzip(zip({ '../evil.tex': 'x' }))).rejects.toBeInstanceOf(ArchiveError);
        await expect(unzip(zip({ 'a.tex': 'x', 'b.tex': 'y' }), { maxFiles: 1, maxBytes: 1e6 })).rejects.toThrow(/More than 1/);
        await expect(unzip(zip({ 'big.tex': 'x'.repeat(100_000) }), { maxFiles: 10, maxBytes: 1000 })).rejects.toThrow(/too large/);
        await expect(unzip(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Not a zip/);
    });

    it('takes an Overleaf-style single top folder off and finds the root', async () => {
        const t = await zipTemplate(zip({ 'My Paper/main.tex': '\\documentclass{article}', 'My Paper/sec/a.tex': '\\section{A}' }), 'My Paper');
        expect([...t.files.keys()].toSorted()).toEqual(['main.tex', 'sec/a.tex']);
        expect(t.info.root).toBe('main.tex');
    });

    it('untars a Typst package', async () => {
        const out = await untargz(tgz({ 'typst.toml': '[package]\nname = "x"', 'template/main.typ': '= Hi' }));
        expect(dec.decode(out.get('template/main.typ'))).toBe('= Hi');
        await expect(untargz(tgz({ '../x': 'y' }))).rejects.toThrow(/Unsafe/);
    });
});

describe('links', () => {
    it('reads repository links and package specs', () => {
        expect(parseRepoLink('https://github.com/Yukibana-Ed/papers-templates/tree/main/latex-article')).toEqual({
            owner: 'Yukibana-Ed',
            repo: 'papers-templates',
            ref: 'main',
            folder: 'latex-article',
        });
        expect(parseRepoLink('octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo', ref: null, folder: '' });
        expect(parseRepoLink('https://github.com/o/r/tree/main/../x')).toBeNull();
        expect(parseUniverseSpec('@preview/charged-ieee:0.1.4')).toEqual({ name: 'charged-ieee', version: '0.1.4' });
        expect(parseUniverseSpec('charged-ieee')).toEqual({ name: 'charged-ieee', version: null });
        expect(parseUniverseSpec('@local/x:1.0.0')).toBeNull();
    });
});
