#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { prepareWrite, type Diagnostic } from '@yukibana/papers-compiler';
import { ensureProgram, serverFor, startLanguageServer, TEXLAB, TINYMIST } from '@yukibana/papers-lsp';
import { createPapersServer } from '@yukibana/papers-mcp';
import { folderFiles, openProject, readProject, type Project, type ProjectDocument } from '@yukibana/papers-project';
import { DEFAULT_PORT, startRunner } from '@yukibana/papers-runner';
import { cacheDir, sandboxSupport, type SandboxChoice } from '@yukibana/papers-sandbox';
import { createOnDisk } from '@yukibana/papers-templates/disk';
import { engineFolder, IncrementalBuilds, incrementalFits, type IncrementalBuild } from './incremental.ts';
import { buildLocal } from './local.ts';
import { resolveToolchain } from './toolchain.ts';

const VERSION = '0.0.0-dev';

const HELP = `papers ${VERSION}: build LaTeX papers on this computer, safely.

  papers build [dir] [--doc main.tex] [--tex <TeX folder>] [--sandbox auto|none]
  papers watch [dir] [--doc main.tex] [--tex …] [--sandbox …] [--incremental]
  papers serve [--port ${DEFAULT_PORT}] [--tex …] [--sandbox …] [--incremental] [--dev]   the build server for papers.yukibana.dev
  papers lsp                                                         texlab over stdio
  papers mcp [dir] [--tex …] [--sandbox …]                           an MCP server over stdio
  papers doctor [dir] [--tex …]
  papers new <template> [folder] [--title …]                        a paper from a template: latex-article, owner/repo/folder, @preview/name, a .zip

--sandbox none runs TeX unconfined, with access to all your files: only for a toolchain you trust.
--incremental builds pdfLaTeX documents with the engine of the site, which goes on from where the last build was
still the same; documents it does not build (other engines, biber, an index, shell escape) are built as without it.
--shell-escape lets documents whose papers.toml asks for it run shell commands (still in the sandbox); a project
cannot turn this on by itself.
`;

/** A one-line, editor-clickable form of a diagnostic: `file:line: severity: message`. */
function line(d: Diagnostic): string {
    return `${d.file ?? '?'}${d.line ? `:${d.line}` : ''}: ${d.severity}: ${d.message}`;
}

function pickDocument(p: Project, doc: string | undefined): ProjectDocument {
    const d = doc === undefined ? p.documents[0] : p.documents.find(x => x.root === doc.replace(/\\/g, '/'));
    if (!d)
        throw new Error(
            doc === undefined ? 'no document here (no .tex file with \\documentclass)' : `no document ${doc}; documents: ${p.documents.map(x => x.root).join(', ') || 'none'}`,
        );
    return d;
}

function sandboxOf(v: string | undefined): SandboxChoice {
    if (v === undefined || v === 'auto') return 'auto';
    if (v === 'none') return 'none';
    throw new Error(`--sandbox is auto or none, not ${v}`);
}

/** Puts what an incremental build made into `<dir>/.papers/out/`, where no build reads: the PDF and its SyncTeX
 *  under the document's name. Returns their paths. */
function putOutputs(dir: string, root: string, b: IncrementalBuild): { pdf: string | null; synctex: string | null } {
    const out = join(dir, '.papers', 'out');
    const base = basename(root).replace(/\.tex$/, '');
    const put = (name: string, bytes: Uint8Array | null): string | null => {
        if (bytes === null) return null;
        const file = join(out, name);
        prepareWrite(dir, file);
        writeFileSync(file, bytes);
        return file;
    };
    return { pdf: put(`${base}.pdf`, b.pdf), synctex: put(`${base}.synctex.gz`, b.synctex) };
}

async function build(
    dir: string,
    doc: string | undefined,
    tex: string | undefined,
    sandbox: SandboxChoice,
    shellEscape: boolean,
    incremental: IncrementalBuilds | null = null,
): Promise<boolean> {
    const project = openProject(dir);
    const d = pickDocument(project, doc);
    const toolchain = resolveToolchain(project.environment, tex);
    if (incremental !== null && incrementalFits(d, toolchain, shellEscape)) {
        const r = incremental.build(dir, project.files.list(), d, toolchain, p => process.stderr.write(`  ${p}\n`));
        for (const x of r.diagnostics) if (x.severity !== 'info') console.log(line(x));
        const boxes = r.diagnostics.filter(x => x.severity === 'info').length;
        console.log(
            `${r.ok ? 'built' : 'failed'} ${d.root}: ${r.pages} page${r.pages === 1 ? '' : 's'} in ${(r.ms / 1000).toFixed(1)} s (${r.steps.join(', ')}), ${toolchain.label}, incremental${boxes ? `, ${boxes} box notes` : ''}`,
        );
        const { pdf } = putOutputs(dir, d.root, r);
        if (pdf !== null) console.log(pdf);
        return r.ok;
    }
    const b = await buildLocal(dir, project.files, d, toolchain, sandbox, p => process.stderr.write(`  ${p}\n`), shellEscape);
    const r = b.result;
    for (const x of r.diagnostics) if (x.severity !== 'info') console.log(line(x));
    const boxes = r.diagnostics.filter(x => x.severity === 'info').length;
    console.log(
        `${r.ok ? 'built' : 'failed'} ${d.root}: ${r.pages} page${r.pages === 1 ? '' : 's'} in ${(r.ms / 1000).toFixed(1)} s (${r.steps.map(s => s.program).join(', ')}), ${toolchain.label}, sandbox ${sandbox === 'none' ? 'none' : 'on'}${boxes ? `, ${boxes} box notes` : ''}`,
    );
    if (b.output) console.log(b.output);
    return r.ok;
}

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            doc: { type: 'string' },
            tex: { type: 'string' },
            sandbox: { type: 'string' },
            port: { type: 'string' },
            server: { type: 'string' },
            dev: { type: 'boolean' },
            incremental: { type: 'boolean' },
            'shell-escape': { type: 'boolean' },
            title: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
        },
    });
    const [command, arg] = positionals;
    if (values.version) {
        console.log(VERSION);
        return 0;
    }
    if (values.help || !command) {
        console.log(HELP);
        return command ? 0 : 1;
    }
    const dir = resolve(arg ?? '.');
    const sandbox = sandboxOf(values.sandbox);
    let incremental: IncrementalBuilds | null = null;
    if (values.incremental) {
        const engine = engineFolder();
        incremental = engine === null ? null : new IncrementalBuilds(engine, join(cacheDir(), 'pdftex'));
        if (incremental?.available !== true) throw new Error('--incremental: the engine is not installed with this program');
    }

    switch (command) {
        case 'new': {
            const spec = arg;
            if (!spec) throw new Error('papers new <template> [folder]: which template?');
            const folder = positionals[2] ?? (spec.replace(/^.*[\\/@:]/, '').replace(/\.zip$/i, '') || 'paper');
            const r = await createOnDisk(spec, folder, values.title ? { title: values.title } : {});
            console.log(`${r.files.length} files from ${r.origin} in ${resolve(folder)}`);
            console.log(`papers build ${folder} --doc ${r.root}`);
            return 0;
        }
        case 'build':
            return (await build(dir, values.doc, values.tex, sandbox, values['shell-escape'] === true)) ? 0 : 1;

        case 'watch': {
            let timer: NodeJS.Timeout | undefined;
            let running = false;
            let again = false;
            const go = async (): Promise<void> => {
                if (running) {
                    again = true;
                    return;
                }
                running = true;
                try {
                    await build(dir, values.doc, values.tex, sandbox, values['shell-escape'] === true, incremental);
                } catch (e) {
                    console.error(e instanceof Error ? e.message : String(e));
                }
                running = false;
                if (again) {
                    again = false;
                    void go();
                }
            };
            await go();
            watch(dir, { recursive: true }, (_event, name) => {
                if (name && /(^|[\\/])(\.git|\.papers|node_modules)([\\/]|$)/.test(name)) return;
                clearTimeout(timer);
                timer = setTimeout(() => void go(), 300);
            });
            return new Promise<number>(() => undefined);
        }

        case 'serve': {
            const port = values.port ? Number(values.port) : DEFAULT_PORT;
            const origins = ['https://papers.yukibana.dev', ...(values.dev ? ['http://localhost:5180'] : [])];
            const support = await sandboxSupport();
            if (sandbox === 'auto' && !support.available) throw new Error(`no sandbox available (${support.detail})`);
            const workRoot = join(cacheDir(), 'serve');
            // Folders a previous run could not remove (a language server still held one).
            rmSync(workRoot, { recursive: true, force: true, maxRetries: 3 });
            mkdirSync(workRoot, { recursive: true });
            let texlab: string | null = null;
            // Folders in which the installation's programs have built: what they leave there (a .bbl, an .aux) would
            // be taken for the project's own files by the incremental engine, so it does not build there again.
            const native = new Set<string>();
            const runner = await startRunner({
                port,
                origins,
                workRoot,
                sandbox: sandbox === 'none' ? 'none' : (support.kind ?? 'none'),
                toolchain: values.tex ?? 'declared by the project',
                onCode: code => console.log(`pairing code: ${code}`),
                build: async (workDir, root, onStep) => {
                    const files = folderFiles(workDir);
                    const project = readProject(files);
                    const d = pickDocument(project, root);
                    const toolchain = resolveToolchain(project.environment, values.tex);
                    if (incremental !== null && !native.has(workDir) && incrementalFits(d, toolchain, values['shell-escape'] === true)) {
                        const r = incremental.build(workDir, files.list(), d, toolchain, onStep);
                        return { ok: r.ok, pages: r.pages, ms: r.ms, diagnostics: r.diagnostics, ...putOutputs(workDir, d.root, r) };
                    }
                    native.add(workDir);
                    // The connection's folder is already a copy: build in place.
                    const b = await buildLocal(workDir, files, d, toolchain, sandbox, onStep, values['shell-escape'] === true);
                    return { ...b.result, diagnostics: b.result.diagnostics };
                },
                languageServer: (workDir, server) => {
                    const pending: unknown[] = [];
                    const listeners: ((m: unknown) => void)[] = [];
                    let ls: ReturnType<typeof startLanguageServer> | null = null;
                    const program =
                        server === 'tinymist'
                            ? ensureProgram({ cacheDir: cacheDir(), pinned: TINYMIST })
                            : texlab
                              ? Promise.resolve(texlab)
                              : ensureProgram({ cacheDir: cacheDir() });
                    const ready = program.then(path => {
                        if (server === 'texlab') texlab = path;
                        ls = startLanguageServer(path, workDir, server === 'tinymist' ? ['lsp'] : []);
                        for (const l of listeners) ls.onMessage(l);
                        for (const m of pending) ls.send(m);
                    });
                    void ready.catch((e: unknown) => console.error(`${server}: ${e instanceof Error ? e.message : String(e)}`));
                    return {
                        send: m => (ls ? ls.send(m) : pending.push(m)),
                        onMessage: l => (ls ? ls.onMessage(l) : listeners.push(l)),
                        close: () => ls?.close(),
                    };
                },
            });
            console.log(`serving on http://127.0.0.1:${runner.port} for ${origins.join(', ')}; sandbox ${sandbox === 'none' ? 'OFF' : support.detail}`);
            return new Promise<number>(() => undefined);
        }

        case 'lsp': {
            // texlab for LaTeX, tinymist for Typst: --server, else by the project's first document.
            let pinned = values.server === 'tinymist' ? TINYMIST : values.server === 'texlab' ? TEXLAB : null;
            if (pinned === null) {
                try {
                    const p = openProject(dir);
                    // Typst documents are not among the project's TeX documents: any .typ file and no TeX document means Typst.
                    const typst = p.files.list().some(f => f.endsWith('.typ'));
                    pinned = p.documents[0] ? serverFor(p.documents[0].root) : typst ? TINYMIST : TEXLAB;
                } catch {
                    pinned = TEXLAB;
                }
            }
            const path = await ensureProgram({ cacheDir: cacheDir(), pinned });
            const child = spawn(path, pinned === TINYMIST ? ['lsp'] : [], { stdio: 'inherit' });
            return new Promise<number>(r => child.on('close', code => r(code ?? 1)));
        }

        case 'mcp': {
            const server = createPapersServer({
                projectDir: dir,
                version: VERSION,
                build: async (projectDir, doc) => {
                    const project = openProject(projectDir);
                    const b = await buildLocal(
                        projectDir,
                        project.files,
                        doc,
                        resolveToolchain(project.environment, values.tex),
                        sandbox,
                        undefined,
                        values['shell-escape'] === true,
                    );
                    return { result: b.result, workDir: b.workDir, output: b.output };
                },
            });
            await server.connect(new StdioServerTransport());
            return new Promise<number>(() => undefined);
        }

        case 'doctor': {
            console.log(`papers ${VERSION}, Node ${process.version}, ${process.platform}-${process.arch}`);
            const s = await sandboxSupport();
            console.log(`sandbox:   ${s.available ? 'yes' : 'NO'}, ${s.detail}`);
            const texlab = join(cacheDir(), 'texlab', TEXLAB.version, process.platform === 'win32' ? 'texlab.exe' : 'texlab');
            console.log(`texlab:    ${existsSync(texlab) ? texlab : `not downloaded yet (${TEXLAB.version}, on first \`papers lsp\`)`}`);
            const tinymist = join(cacheDir(), 'tinymist', TINYMIST.version, process.platform === 'win32' ? 'tinymist.exe' : 'tinymist');
            console.log(`tinymist:  ${existsSync(tinymist) ? tinymist : `not downloaded yet (${TINYMIST.version}, on first \`papers lsp\` of a Typst project)`}`);
            if (existsSync(join(dir, 'papers.toml')) || existsSync(dir)) {
                try {
                    const p = openProject(dir);
                    console.log(`project:   ${dir}${p.declared ? '' : ' (no papers.toml: managed TeX Live by default)'}`);
                    console.log(`env:       ${JSON.stringify(p.environment)}`);
                    for (const d of p.documents)
                        console.log(`document:  ${d.root}: ${d.engine}, ${d.bibliography}, index ${d.index}${d.missing.length ? `, missing ${d.missing.join(', ')}` : ''}`);
                    try {
                        console.log(`toolchain: ${resolveToolchain(p.environment, values.tex).label}`);
                    } catch (e) {
                        console.log(`toolchain: NO, ${e instanceof Error ? e.message : String(e)}`);
                    }
                } catch (e) {
                    console.log(`project:   ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            return s.available ? 0 : 1;
        }

        default:
            console.error(`unknown command ${command}\n\n${HELP}`);
            return 1;
    }
}

main(process.argv.slice(2)).then(
    code => process.exit(code),
    (e: unknown) => {
        console.error(`papers: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(2);
    },
);
