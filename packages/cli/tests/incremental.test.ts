import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@yukibana/papers-project';
import { engineFolder, IncrementalBuilds, incrementalFits } from '../src/incremental.ts';
import type { Toolchain } from '../src/toolchain.ts';

const dir = mkdtempSync(join(tmpdir(), 'papers-incremental-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A folder laid out as TeX Live, with the least it takes to dump a format called pdflatex: one that knows braces,
 *  parameters and `\page`, which ships out a page with a rule. */
function installation(): Toolchain {
    const root = join(dir, 'texlive');
    mkdirSync(join(root, 'texmf-dist', 'web2c'), { recursive: true });
    mkdirSync(join(root, 'texmf-dist', 'tex'), { recursive: true });
    writeFileSync(
        join(root, 'texmf-dist', 'web2c', 'texmf.cnf'),
        'TEXINPUTS = .;$SELFAUTOPARENT/texmf-dist/tex\nTEXFORMATS = .\nTEXPOOL = .\nTFMFONTS = .\nTEXFONTMAPS = .\nWEB2C = $SELFAUTOPARENT/texmf-dist/web2c\nopenout_any = p\nopenin_any = a\n',
    );
    writeFileSync(join(root, 'texmf-dist', 'web2c', 'cp227.tcx'), '');
    writeFileSync(
        join(root, 'texmf-dist', 'tex', 'pdflatex.ini'),
        '\\catcode`\\{=1 \\catcode`\\}=2 \\catcode`\\#=6\n' +
            '\\pdfoutput=1 \\pdfcompresslevel=0 \\pdfobjcompresslevel=0 \\pdfmapfile{}\n' +
            '\\pdfpagewidth=200pt \\pdfpageheight=100pt\n' +
            '\\def\\page#1{\\shipout\\vbox{\\hrule width #1pt height 10pt}}\n\\dump\n',
    );
    return { root, bin: join(root, 'bin', 'none'), label: 'test' };
}

const document: ProjectDocument = { root: 'main.tex', engine: 'pdflatex', bibliography: 'none', index: 'none', shellEscape: false, inputs: ['main.tex'], missing: [] };

function pages(pdf: Uint8Array | null): number {
    return pdf === null
        ? -1
        : (Buffer.from(pdf)
              .toString('latin1')
              .match(/\/Type \/Page\b(?!s)/g)?.length ?? 0);
}

describe('what the incremental engine builds', () => {
    it('is pdfLaTeX with BibTeX or no tool, on a folder laid out as TeX Live', () => {
        const toolchain = installation();
        expect(incrementalFits(document, toolchain, false)).toBe(true);
        expect(incrementalFits({ ...document, bibliography: 'bibtex' }, toolchain, false)).toBe(true);
        expect(incrementalFits({ ...document, engine: 'xelatex' }, toolchain, false)).toBe(false);
        expect(incrementalFits({ ...document, bibliography: 'biber' }, toolchain, false)).toBe(false);
        expect(incrementalFits({ ...document, index: 'makeindex' }, toolchain, false)).toBe(false);
        expect(incrementalFits({ ...document, shellEscape: true }, toolchain, true)).toBe(false);
        // Shell escape that is asked for but not allowed is off: the document is built without it either way.
        expect(incrementalFits({ ...document, shellEscape: true }, toolchain, false)).toBe(true);
        expect(incrementalFits(document, { ...toolchain, root: join(dir, 'none') }, false)).toBe(false);
    });
});

const engine = engineFolder();

describe.runIf(engine !== null)('an incremental build on this computer', () => {
    it('builds from the files of a folder, again after an edit, and reads no link out of the folder', () => {
        if (engine === null) return;
        const toolchain = installation();
        const project = join(dir, 'project');
        mkdirSync(join(project, 'parts'), { recursive: true });
        writeFileSync(join(project, 'main.tex'), '\\page{10}\\input parts/more \\end\n');
        writeFileSync(join(project, 'parts', 'more.tex'), '\\page{20}\\page{30}\n');
        const builds = new IncrementalBuilds(engine, join(dir, 'cache'));
        expect(builds.available).toBe(true);
        const steps: string[] = [];
        const first = builds.build(project, ['main.tex', 'parts/more.tex'], document, toolchain, s => steps.push(s));
        expect(first.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(first.ok).toBe(true);
        expect(pages(first.pdf)).toBe(3);
        expect(first.pages).toBe(3);
        expect(steps[0]).toBe('pdflatex');
        expect(first.synctex === null ? '' : gunzipSync(first.synctex).toString('latin1')).toContain('SyncTeX Version:1');

        // Nothing changed: the same bytes.
        const again = builds.build(project, ['main.tex', 'parts/more.tex'], document, toolchain);
        expect(again.pdf).toEqual(first.pdf);

        // An edit, with the same length, so that only the time says the file changed.
        writeFileSync(join(project, 'parts', 'more.tex'), '\\page{20}\\page{40}\n');
        utimesSync(join(project, 'parts', 'more.tex'), new Date(), new Date(Date.now() + 5000));
        const edited = builds.build(project, ['main.tex', 'parts/more.tex'], document, toolchain);
        expect(pages(edited.pdf)).toBe(3);
        expect(edited.pdf).not.toEqual(first.pdf);
        // The same as a build that starts with nothing kept.
        const fresh = new IncrementalBuilds(engine, join(dir, 'cache')).build(project, ['main.tex', 'parts/more.tex'], document, toolchain);
        expect(pages(fresh.pdf)).toBe(3);
        expect(Buffer.from(fresh.log).toString()).toBe(edited.log);

        // An error is a diagnostic, and the build is not ok.
        writeFileSync(join(project, 'main.tex'), '\\page{10}\\nosuchmacro \\end\n');
        const failed = builds.build(project, ['main.tex', 'parts/more.tex'], document, toolchain);
        expect(failed.ok).toBe(false);
        expect(failed.diagnostics[0]).toMatchObject({ severity: 'error', file: 'main.tex', line: 1 });

        // A link out of the folder is not a file of the project.
        if (process.platform !== 'win32') {
            writeFileSync(join(dir, 'outside.tex'), '\\page{50}\n');
            symlinkSync(join(dir, 'outside.tex'), join(project, 'parts', 'link.tex'));
            writeFileSync(join(project, 'main.tex'), '\\page{10}\\input parts/link \\end\n');
            const linked = builds.build(project, ['main.tex', 'parts/more.tex', 'parts/link.tex'], document, toolchain);
            // TeX does not find it, and stops.
            expect(linked.ok).toBe(false);
            expect(linked.diagnostics.some(d => d.severity === 'error' && /parts\/link/.test(d.message))).toBe(true);
        }
    });
});
