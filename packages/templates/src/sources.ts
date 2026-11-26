import { DEFAULT_LIMITS, unzip, untargz, type ArchiveLimits } from './archive.ts';
import { detect, asText } from './plan.ts';
import { safePath } from './paths.ts';
import { parseIndex, parseTemplateToml, TemplateError, type GalleryEntry, type Template, type TemplateInfo } from './template.ts';

/** The curated templates. */
export const GALLERY_REPO = { owner: 'Yukibana-Ed', repo: 'papers-templates' } as const;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const UNIVERSE = 'https://packages.typst.org/preview';

type Fetch = typeof fetch;

async function ok(r: Response, what: string): Promise<Response> {
    if (r.status === 404) throw new TemplateError(`${what}: not found`);
    if (!r.ok) throw new TemplateError(`${what}: the server answered ${r.status}`);
    return r;
}

const bytesOf = async (r: Response): Promise<Uint8Array> => new Uint8Array(await r.arrayBuffer());

/** The gallery at its newest commit: that commit (so every file of a template comes from the same one) and the
 *  templates. Raw files and thumbnails of the commit are at `galleryUrl(commit, path)`. */
export async function loadGallery(f: Fetch = fetch): Promise<{ commit: string; templates: GalleryEntry[] }> {
    const head = await ok(await f(`${API}/repos/${GALLERY_REPO.owner}/${GALLERY_REPO.repo}/commits/main`, { headers: { Accept: 'application/vnd.github.sha' } }), 'The gallery');
    const commit = (await head.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new TemplateError('The gallery: no commit');
    const index: unknown = await (await ok(await f(galleryUrl(commit, 'index.json')), 'The gallery')).json();
    return { commit, templates: parseIndex(index) };
}

/** A file of the gallery at `commit`, as a URL any page can load (CORS and CORP allow it). */
export function galleryUrl(commit: string, path: string): string {
    return `${RAW}/${GALLERY_REPO.owner}/${GALLERY_REPO.repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** A curated template, all its files from `commit`. */
export async function galleryTemplate(entry: GalleryEntry, commit: string, f: Fetch = fetch): Promise<Template> {
    const files = new Map<string, Uint8Array>();
    await Promise.all(
        entry.files.map(async p => {
            files.set(p, await bytesOf(await ok(await f(galleryUrl(commit, `${entry.id}/${p}`)), p)));
        }),
    );
    return { info: entry, files, origin: `${GALLERY_REPO.owner}/${GALLERY_REPO.repo}/${entry.id}@${commit.slice(0, 7)}` };
}

/** What a folder of files is: its `template.toml` if it has one, else worked out from the files. */
export function infoOf(files: ReadonlyMap<string, Uint8Array>, name: string): TemplateInfo {
    const manifest = files.get('template.toml');
    const text = manifest ? asText(manifest) : null;
    if (text) return parseTemplateToml(text);
    const d = detect(files);
    return { name, description: '', category: 'paper', format: d.format, engine: d.engine, root: d.root, licence: 'unknown', fields: {}, seeAlso: [] };
}

/** A GitHub repository or folder link: `owner/repo`, `github.com/owner/repo`, or `…/tree/<ref>/<folder>`. */
export function parseRepoLink(link: string): { owner: string; repo: string; ref: string | null; folder: string } | null {
    const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*?))?)?\/?$/.exec(link.trim());
    if (!m) return null;
    const folder = m[4] ? safePath(decodeURIComponent(m[4])) : '';
    if (folder === null) return null;
    return { owner: m[1] ?? '', repo: m[2] ?? '', ref: m[3] ? decodeURIComponent(m[3]) : null, folder };
}

/** A repository (or a folder of one) used as a template: its files at the ref's head, read with `token` when given
 *  (private repositories), else anonymously. At most `limits`. */
export async function repoTemplate(link: string, token: string | null, f: Fetch = fetch, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<Template> {
    const r = parseRepoLink(link);
    if (!r) throw new TemplateError('Not a GitHub repository link');
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const repo = (await (await ok(await f(`${API}/repos/${r.owner}/${r.repo}`, { headers }), `${r.owner}/${r.repo}`)).json()) as { default_branch: string };
    const ref = r.ref ?? repo.default_branch;
    const commit = (
        await (
            await ok(await f(`${API}/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(ref)}`, { headers: { ...headers, Accept: 'application/vnd.github.sha' } }), ref)
        ).text()
    ).trim();
    const tree = (await (await ok(await f(`${API}/repos/${r.owner}/${r.repo}/git/trees/${commit}?recursive=1`, { headers }), 'The tree')).json()) as {
        tree: { path: string; type: string; sha: string; size?: number }[];
    };
    const prefix = r.folder === '' ? '' : `${r.folder}/`;
    const entries = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix) && !e.path.startsWith(`${prefix}.github/`));
    if (entries.length > limits.maxFiles) throw new TemplateError(`More than ${limits.maxFiles} files`);
    if (entries.reduce((n, e) => n + (e.size ?? 0), 0) > limits.maxBytes) throw new TemplateError('The template is too large');
    const files = new Map<string, Uint8Array>();
    await Promise.all(
        entries.map(async e => {
            const path = safePath(e.path.slice(prefix.length));
            if (path === null) return;
            files.set(
                path,
                await bytesOf(await ok(await f(`${API}/repos/${r.owner}/${r.repo}/git/blobs/${e.sha}`, { headers: { ...headers, Accept: 'application/vnd.github.raw' } }), path)),
            );
        }),
    );
    return { info: infoOf(files, r.folder.split('/').pop() || r.repo), files, origin: `${r.owner}/${r.repo}${r.folder ? `/${r.folder}` : ''}@${commit.slice(0, 7)}` };
}

/** `@preview/name:version`, `name:version` or `name`. */
export function parseUniverseSpec(spec: string): { name: string; version: string | null } | null {
    const m = /^(?:@preview\/)?([a-z0-9][a-z0-9-]*)(?::(\d+\.\d+\.\d+))?$/.exec(spec.trim());
    return m ? { name: m[1] ?? '', version: m[2] ?? null } : null;
}

/** A Typst Universe template package, as `typst init` copies it: the files under its `[template] path`, with the
 *  entrypoint as root. Without a version, the newest version that has a template. */
export async function universeTemplate(spec: string, f: Fetch = fetch): Promise<Template> {
    const s = parseUniverseSpec(spec);
    if (!s) throw new TemplateError('Not a Typst package: @preview/name:version');
    let version = s.version;
    if (version === null) {
        const index = (await (await ok(await f(`${UNIVERSE}/index.json`), 'Typst Universe')).json()) as { name: string; version: string; template?: unknown }[];
        const cmp = (a: string, b: string): number => {
            const x = a.split('.').map(Number);
            const y = b.split('.').map(Number);
            return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
        };
        version =
            index
                .filter(p => p.name === s.name && p.template)
                .map(p => p.version)
                .toSorted(cmp)
                .pop() ?? null;
        if (version === null) throw new TemplateError(`${s.name}: no template in Typst Universe`);
    }
    const all = await untargz(await bytesOf(await ok(await f(`${UNIVERSE}/${s.name}-${version}.tar.gz`), `@preview/${s.name}:${version}`)));
    const manifest = asText(all.get('typst.toml') ?? new Uint8Array());
    if (!manifest) throw new TemplateError(`@preview/${s.name}:${version} has no typst.toml`);
    const path = /^\s*path\s*=\s*"([^"]+)"/m.exec(manifest.slice(manifest.indexOf('[template]')))?.[1];
    const entry = /^\s*entrypoint\s*=\s*"([^"]+)"/m.exec(manifest.slice(manifest.indexOf('[template]')))?.[1];
    if (manifest.indexOf('[template]') < 0 || !path || !entry) throw new TemplateError(`@preview/${s.name}:${version} is a package, not a template`);
    const prefix = `${safePath(path) ?? ''}/`;
    const files = new Map<string, Uint8Array>();
    for (const [p, b] of all) if (p.startsWith(prefix)) files.set(p.slice(prefix.length), b);
    const root = safePath(entry);
    if (root === null || !files.has(root)) throw new TemplateError(`@preview/${s.name}:${version}: its entrypoint is missing`);
    return {
        info: { name: s.name, description: '', category: 'paper', format: 'typst', engine: 'typst', root, licence: 'see the package', fields: {}, seeAlso: [] },
        files,
        origin: `@preview/${s.name}:${version}`,
    };
}

/** A template named the way `papers new`, the MCP tool and the `/new?template=` link name one: a gallery id
 *  (`latex-article`), a repository or folder (`owner/repo`, `owner/repo/folder`, a github.com link), or a Typst
 *  Universe package (`@preview/name[:version]`). */
export async function templateFromSpec(spec: string, token: string | null = null, f: Fetch = fetch): Promise<Template> {
    const s = spec.trim();
    if (s.startsWith('@preview/')) return universeTemplate(s, f);
    if (/^[a-z0-9][a-z0-9-]*$/.test(s)) {
        const g = await loadGallery(f);
        const entry = g.templates.find(t => t.id === s);
        if (!entry) throw new TemplateError(`No template ${s} in the gallery: ${g.templates.map(t => t.id).join(', ')}`);
        return galleryTemplate(entry, g.commit, f);
    }
    const [owner, repo, ...folder] = s.replace(/^https?:\/\/(www\.)?github\.com\//, '').split('/');
    const link = s.includes('github.com') || folder[0] === 'tree' || folder.length === 0 ? s : `github.com/${owner}/${repo}/tree/HEAD/${folder.join('/')}`;
    return repoTemplate(link, token, f);
}

/** An uploaded .zip (an Overleaf export, an arXiv source bundle saved as zip): checked, unpacked, with a single top
 *  folder taken off, and its document found. */
export async function zipTemplate(zip: Uint8Array, name: string, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<Template> {
    let files = await unzip(zip, limits);
    const tops = new Set([...files.keys()].map(p => p.split('/')[0]));
    const [only] = tops;
    if (tops.size === 1 && only !== undefined && [...files.keys()].every(p => p.includes('/'))) {
        files = new Map([...files].map(([p, b]) => [p.slice(only.length + 1), b]));
    }
    if (files.size === 0) throw new TemplateError('The archive is empty');
    return { info: infoOf(files, name), files, origin: `${name} (upload)` };
}
