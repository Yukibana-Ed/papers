import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryFiles } from '@yukibana/papers-project';
import { buildDocument, realFileInside, sweepLinks, syncInto } from '../src/index.ts';

/** A link to a file, or null where this machine may not make one (Windows without developer mode). */
function fileLink(target: string, at: string): boolean {
    try {
        symlinkSync(target, at, 'file');
        return true;
    } catch {
        return false;
    }
}

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function folderLink(target: string, at: string): void {
    symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

function setup(): { root: string; project: string; work: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), 'papers-safe-'));
    const project = join(root, 'project');
    const work = join(root, 'work');
    const outside = join(root, 'outside');
    for (const d of [project, work, outside]) mkdirSync(d);
    return { root, project, work, outside };
}

describe('the work folder is never followed out of', () => {
    it('syncInto replaces a link to a file outside instead of writing through it', () => {
        const { project, work, outside } = setup();
        writeFileSync(join(project, 'refs.bib'), 'attacker');
        writeFileSync(join(outside, 'bashrc'), 'precious');
        if (!fileLink(join(outside, 'bashrc'), join(work, 'refs.bib'))) return;
        syncInto(project, memoryFiles({ 'refs.bib': 'attacker' }), work, ['refs.bib']);
        expect(readFileSync(join(outside, 'bashrc'), 'utf8')).toBe('precious');
        expect(lstatSync(join(work, 'refs.bib')).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(work, 'refs.bib'), 'utf8')).toBe('attacker');
    });

    it('syncInto replaces a linked folder instead of writing into its target', () => {
        const { project, work, outside } = setup();
        mkdirSync(join(project, 'sections'));
        writeFileSync(join(project, 'sections', 'intro.tex'), 'hello');
        folderLink(outside, join(work, 'sections'));
        syncInto(project, memoryFiles({ 'sections/intro.tex': 'hello' }), work, ['sections/intro.tex']);
        expect(existsSync(join(outside, 'intro.tex'))).toBe(false);
        expect(readFileSync(join(work, 'sections', 'intro.tex'), 'utf8')).toBe('hello');
    });

    it('sweepLinks removes links anywhere below, without touching their targets', () => {
        const { work, outside } = setup();
        writeFileSync(join(outside, 'secret'), 'secret');
        mkdirSync(join(work, 'a'));
        folderLink(outside, join(work, 'a', 'out'));
        const file = fileLink(join(outside, 'secret'), join(work, 'paper.pdf'));
        const removed = sweepLinks(work);
        expect(removed.length).toBe(file ? 2 : 1);
        expect(existsSync(join(work, 'a', 'out'))).toBe(false);
        expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('secret');
    });

    it('realFileInside reads only regular files inside the folder', () => {
        const { work, outside } = setup();
        writeFileSync(join(work, 'paper.pdf'), '%PDF');
        writeFileSync(join(outside, 'secret'), 'secret');
        expect(realFileInside(work, join(work, 'paper.pdf'))).not.toBeNull();
        expect(realFileInside(work, join(outside, 'secret'))).toBeNull();
        expect(realFileInside(work, join(work, 'missing.pdf'))).toBeNull();
        if (fileLink(join(outside, 'secret'), join(work, 'linked.pdf'))) expect(realFileInside(work, join(work, 'linked.pdf'))).toBeNull();
    });
});

describe('shell escape', () => {
    const doc = { root: 'main.tex', engine: 'pdflatex', bibliography: 'none', index: 'none', shellEscape: true, inputs: ['main.tex'], missing: [] } as const;

    async function argsOf(allowShellEscape: boolean | undefined): Promise<{ args: readonly string[]; warned: boolean }> {
        const work = mkdtempSync(join(tmpdir(), 'papers-se-'));
        const seen: (readonly string[])[] = [];
        const runner = {
            kind: 'fake',
            run: async (req: { args: readonly string[] }) => {
                seen.push(req.args);
                return { code: 1, stdout: '', stderr: '', ms: 0, timedOut: false };
            },
        };
        const r = await buildDocument({ workDir: work, document: doc, runner, maxRuns: 1, ...(allowShellEscape === undefined ? {} : { allowShellEscape }) });
        return { args: seen[0] ?? [], warned: r.diagnostics.some(d => /shell escape/.test(d.message)) };
    }

    it('is off when only papers.toml asks for it, with a warning saying how to allow it', async () => {
        const r = await argsOf(undefined);
        expect(r.args).toContain('-no-shell-escape');
        expect(r.warned).toBe(true);
    });

    it('is on when the person building allows it', async () => {
        const r = await argsOf(true);
        expect(r.args).toContain('-shell-escape');
        expect(r.warned).toBe(false);
    });
});
