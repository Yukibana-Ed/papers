import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { forwardSearch, inverseSearch, parseSynctex, type BuildResult } from '@yukibana/papers-compiler';
import { folderFiles, outline, readProject, type Project, type ProjectDocument } from '@yukibana/papers-project';
import { createOnDisk } from '@yukibana/papers-templates/disk';

/** Builds one document of the project in `projectDir`, however the host decides (sandbox, toolchain), in `workDir`
 *  (a copy of the project, whose paths the engine writes into the SyncTeX file). */
export type ProjectBuilder = (
    projectDir: string,
    document: ProjectDocument,
) => Promise<{ readonly result: BuildResult; readonly workDir: string; readonly output?: string | null }>;

export interface PapersServerOptions {
    /** The project's folder: the only folder the tools read or write. */
    readonly projectDir: string;
    readonly build: ProjectBuilder;
    readonly version?: string;
}

const MAX_READ = 1 << 20;

/** The project file `path` (relative to the project) as an absolute path, or an error for anything outside the
 *  project, inside `.git`, or reached through a link that leaves it. */
function inside(projectDir: string, path: string): string {
    const root = realpathSync(projectDir);
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== full || rel.split(sep).includes('.git')) throw new Error(`${path} is not a file of the project`);
    let real = full;
    try {
        real = realpathSync(full);
    } catch {
        // A file not written yet: its folder decides.
        try {
            real = join(realpathSync(dirname(full)), full.slice(dirname(full).length + 1));
        } catch {
            real = full;
        }
    }
    const realRel = relative(root, real);
    if (realRel.startsWith('..') || resolve(root, realRel) !== real) throw new Error(`${path} leads outside the project`);
    return full;
}

const text = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** An MCP server with the tools an assistant needs to work on a paper: what the project is, its files (read and
 *  write, inside the project only), each document's outline, building with diagnostics, and SyncTeX lookups
 *  between source lines and PDF positions. Connect it to a transport (stdio for `papers mcp`). */
export function createPapersServer(o: PapersServerOptions): McpServer {
    const server = new McpServer({ name: 'yukibana-papers', version: o.version ?? '0.0.0' });
    const builds = new Map<string, { readonly result: BuildResult; readonly workDir: string; readonly output?: string | null }>();
    const project = (): Project => readProject(folderFiles(o.projectDir));
    const documentOf = (p: Project, root: string | undefined): ProjectDocument => {
        const doc = root === undefined ? p.documents[0] : p.documents.find(d => d.root === root);
        if (!doc)
            throw new Error(
                root === undefined
                    ? 'the project has no document (no .tex file with \\documentclass)'
                    : `no document ${root}; documents: ${p.documents.map(d => d.root).join(', ')}`,
            );
        return doc;
    };
    const documentArg = { document: z.string().optional().describe('The root .tex file, relative to the project; default: the first document') };

    server.registerTool(
        'project_info',
        {
            description:
                'The project: how it declares its TeX environment, and its documents with the engine, bibliography and index tool each builds with, and files they reference but the project lacks.',
        },
        () => {
            const p = project();
            return text({
                declared: p.declared,
                environment: p.environment,
                locked: p.lock?.texlive ?? null,
                latexmkrc: p.latexmkrc !== null,
                documents: p.documents.map(d => ({
                    root: d.root,
                    engine: d.engine,
                    bibliography: d.bibliography,
                    index: d.index,
                    shellEscape: d.shellEscape,
                    inputs: d.inputs,
                    missing: d.missing,
                })),
            });
        },
    );

    server.registerTool('list_files', { description: 'Every file of the project, relative paths.' }, () => text(project().files.list().join('\n')));

    server.registerTool('read_file', { description: 'A text file of the project.', inputSchema: { path: z.string().describe('Relative to the project') } }, ({ path }) => {
        const full = inside(o.projectDir, path);
        if (statSync(full).size > MAX_READ) throw new Error(`${path} is larger than 1 MB`);
        return text(readFileSync(full, 'utf8'));
    });

    server.registerTool(
        'write_file',
        {
            description: 'Writes a text file of the project (creating folders as needed). Only inside the project, never in .git.',
            inputSchema: { path: z.string(), content: z.string() },
        },
        ({ path, content }) => {
            const full = inside(o.projectDir, path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, content);
            return text(`wrote ${path} (${Buffer.byteLength(content)} bytes)`);
        },
    );

    server.registerTool(
        'create_project',
        {
            description:
                'Creates a new paper from a template in a new, empty folder of the project: a gallery id (latex-article, latex-conference, latex-thesis, latex-slides, latex-cv, typst-article, typst-slides), a GitHub repository or folder (owner/repo/folder), or a Typst Universe template (@preview/name:version). Returns the root file to build.',
            inputSchema: { template: z.string(), folder: z.string().describe('A new folder, relative to the project'), title: z.string().optional() },
        },
        async ({ template, folder, title }) => {
            if (template.toLowerCase().endsWith('.zip')) throw new Error('create_project takes a template name, not an archive');
            const dir = inside(o.projectDir, folder);
            const r = await createOnDisk(template, dir, title ? { title } : {});
            return text(JSON.stringify({ origin: r.origin, root: `${folder.replace(/\\/g, '/').replace(/\/$/, '')}/${r.root}`, files: r.files }, null, 2));
        },
    );

    server.registerTool('outline', { description: "A document's sections, with the file and line of each.", inputSchema: documentArg }, ({ document }) => {
        const p = project();
        return text(outline(p.files, documentOf(p, document)));
    });

    const summary = (r: BuildResult, output: string | null | undefined): unknown => ({
        ok: r.ok,
        pages: r.pages,
        seconds: Math.round(r.ms) / 1000,
        pdf: output ?? r.pdf,
        steps: r.steps.map(s => `${s.program} (${s.code ?? 'killed'}, ${Math.round(s.ms)} ms)`),
        diagnostics: r.diagnostics.filter(d => d.severity !== 'info'),
        boxes: r.diagnostics.filter(d => d.severity === 'info').length,
    });

    server.registerTool(
        'build',
        { description: 'Builds a document (sandboxed) and returns whether it worked, its page count and its errors and warnings with file and line.', inputSchema: documentArg },
        async ({ document }) => {
            const doc = documentOf(project(), document);
            const b = await o.build(o.projectDir, doc);
            builds.set(doc.root, b);
            return text(summary(b.result, b.output));
        },
    );

    server.registerTool('diagnostics', { description: 'The errors, warnings and box notes of the last build of a document.', inputSchema: documentArg }, ({ document }) => {
        const doc = documentOf(project(), document);
        const b = builds.get(doc.root);
        return text(b ? b.result.diagnostics : 'not built yet; call build first');
    });

    const syncOf = (document: string | undefined): { sync: ReturnType<typeof parseSynctex>; workDir: string } => {
        const doc = documentOf(project(), document);
        const b = builds.get(doc.root);
        if (!b?.result.synctex) throw new Error('no SyncTeX data; build the document first');
        return { sync: parseSynctex(readFileSync(b.result.synctex)), workDir: b.workDir };
    };

    server.registerTool(
        'synctex_forward',
        {
            description: 'Where a source line appears in the PDF: boxes with page and position in PDF points from the top-left corner.',
            inputSchema: { ...documentArg, file: z.string(), line: z.number().int().positive() },
        },
        ({ document, file, line }) => text(forwardSearch(syncOf(document).sync, file, line)),
    );

    server.registerTool(
        'synctex_inverse',
        {
            description: 'The source file and line behind a point of the PDF (page from 1; x, y in PDF points from the top-left corner).',
            inputSchema: { ...documentArg, page: z.number().int().positive(), x: z.number(), y: z.number() },
        },
        ({ document, page, x, y }) => {
            const { sync, workDir } = syncOf(document);
            const hit = inverseSearch(sync, page, x, y);
            if (!hit) return text(null);
            // The engine names files by the copy's paths, or relative to the root's folder; report them relative to
            // the project.
            const docDir = dirname(documentOf(project(), document).root).replace(/^\.$/, '');
            const root = realpathSync(workDir).replace(/\\/g, '/').toLowerCase();
            let f = hit.file.replace(/\\/g, '/').replace(/\/\.\//g, '/');
            if (f.toLowerCase().startsWith(`${root}/`)) f = f.slice(root.length + 1);
            else if (f.startsWith('./')) f = (docDir ? `${docDir}/` : '') + f.slice(2);
            return text({ file: f, line: hit.line });
        },
    );

    return server;
}
