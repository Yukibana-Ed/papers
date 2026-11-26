import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** One release of a program: where its archives are and what each must hash to. */
export interface Pinned {
    readonly version: string;
    /** `{version}` and `{name}` are filled in. */
    readonly url: string;
    /** `${process.platform}-${process.arch}` → the archive's name, its SHA-256 (hex), and the folder inside the archive
     *  that holds the program (none: the archive's top). */
    readonly assets: Readonly<Record<string, { readonly name: string; readonly sha256: string; readonly folder?: string }>>;
    /** The executable's name inside the archive, without `.exe`. */
    readonly binary: string;
}

/** texlab 5.26.0 (2026-06-25), the native LaTeX language server. Digests from the GitHub release. */
export const TEXLAB: Pinned = {
    version: '5.26.0',
    url: 'https://github.com/latex-lsp/texlab/releases/download/v{version}/{name}',
    binary: 'texlab',
    assets: {
        'win32-x64': { name: 'texlab-x86_64-windows.zip', sha256: 'cb028d44c3d2b85d36a2ed52d41a0ff43a341b1f04c500c56c4524c4eb72b316' },
        'win32-arm64': { name: 'texlab-aarch64-windows.zip', sha256: '99b215e9a44169eb8d786c33484b963055e1c3dd40f68e14fcc47ae1c84e92c1' },
        'linux-x64': { name: 'texlab-x86_64-linux.tar.gz', sha256: '8697bd5e479d4584b14b7eed5c320c80ec4e1d91ebefbb6801e6bf38e9971300' },
        'linux-arm64': { name: 'texlab-aarch64-linux.tar.gz', sha256: 'a85cdfcd22454b8d8550f4b0f0620c45ab51760f302fac7a12bc18a890f70f8c' },
        'darwin-x64': { name: 'texlab-x86_64-macos.tar.gz', sha256: '6091611f756b28e1a57612b130c196df4b0bb6e22dde5cf5d890578513397daf' },
        'darwin-arm64': { name: 'texlab-aarch64-macos.tar.gz', sha256: 'af7972ffd230711ba04ada9b69cc32ce9111d9196ba69538062872faefdbee56' },
    },
};

/** tinymist 0.15.12 (2026-11-03), the native Typst language server (Typst 0.15.1). Digests from the release's
 *  `<asset>.sha256` files. */
export const TINYMIST: Pinned = {
    version: '0.15.12',
    url: 'https://github.com/Myriad-Dreamin/tinymist/releases/download/v{version}/{name}',
    binary: 'tinymist',
    assets: {
        'win32-x64': { name: 'tinymist-x86_64-pc-windows-msvc.zip', sha256: '7dfa68a764363bf825871c7d0ea302b6590a33b5b3ae43585e34d04296e987b1' },
        'win32-arm64': { name: 'tinymist-aarch64-pc-windows-msvc.zip', sha256: 'c97b019b99be096000352975fff5ac5e7d6c58c31b63af3712091768f9dec455' },
        'linux-x64': {
            name: 'tinymist-x86_64-unknown-linux-gnu.tar.gz',
            sha256: '95f98715f2bc3ecff528124dd691db074c15de1fe0ed2dfa8be43dda6dbbb967',
            folder: 'tinymist-x86_64-unknown-linux-gnu',
        },
        'linux-arm64': {
            name: 'tinymist-aarch64-unknown-linux-gnu.tar.gz',
            sha256: 'd75cabad569b8fc7d24fa326a36ce0c2e3a287c5a4f66204c1fc302185225678',
            folder: 'tinymist-aarch64-unknown-linux-gnu',
        },
        'darwin-x64': {
            name: 'tinymist-x86_64-apple-darwin.tar.gz',
            sha256: '557a9febd4320b190970ca37b8536e3789c853dcf4b435828c355b3fdb967e9d',
            folder: 'tinymist-x86_64-apple-darwin',
        },
        'darwin-arm64': {
            name: 'tinymist-aarch64-apple-darwin.tar.gz',
            sha256: '5f77362580b0bfc8a31b47718dfe3f426ce854d59f04030ade398f1926167b06',
            folder: 'tinymist-aarch64-apple-darwin',
        },
    },
};

/** The language server for a document: tinymist for Typst, texlab for LaTeX. */
export function serverFor(root: string): Pinned {
    return root.endsWith('.typ') ? TINYMIST : TEXLAB;
}

export interface EnsureOptions {
    /** The folder programs are kept in, one subfolder per version. */
    readonly cacheDir: string;
    readonly pinned?: Pinned;
    /** Default: this machine's. */
    readonly platform?: string;
    /** Fetches an archive's bytes. Default: `fetch`, following redirects. */
    readonly download?: (url: string) => Promise<Uint8Array>;
}

/** The system's tar: on Windows the in-box bsdtar, which reads zip archives too (a GNU tar earlier on the PATH, as Git
 *  for Windows has, reads neither zip nor drive-letter paths). */
export function tarCommand(): string {
    return process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

async function fetchBytes(url: string): Promise<Uint8Array> {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download failed: ${r.status} ${url}`);
    return new Uint8Array(await r.arrayBuffer());
}

/** The path of the pinned program, downloading it on first use: the archive must hash to its pinned SHA-256 before
 *  anything is unpacked, and the program is moved into place only when complete, so a cut download never leaves a
 *  half program behind. Throws for a platform with no pinned build, a failed download or a digest mismatch. */
export async function ensureProgram(o: EnsureOptions): Promise<string> {
    const pin = o.pinned ?? TEXLAB;
    const platform = o.platform ?? `${process.platform}-${process.arch}`;
    const asset = pin.assets[platform];
    if (!asset) throw new Error(`no ${pin.binary} build for ${platform}`);
    const exe = `${pin.binary}${platform.startsWith('win32') ? '.exe' : ''}`;
    const dir = join(o.cacheDir, pin.binary, pin.version);
    const target = join(dir, exe);
    if (existsSync(target)) return target;
    const url = pin.url.replace('{version}', pin.version).replace('{name}', asset.name);
    const bytes = await (o.download ?? fetchBytes)(url);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.sha256) throw new Error(`${asset.name} has SHA-256 ${digest}, not the pinned ${asset.sha256}; refusing it`);
    mkdirSync(dir, { recursive: true });
    const tmp = mkdtempSync(join(dir, '.unpack-'));
    try {
        const archive = join(tmp, asset.name);
        writeFileSync(archive, bytes);
        // bsdtar (Windows 10 and later, macOS) reads zip and tar.gz alike; GNU tar reads the tar.gz of Linux.
        await promisify(execFile)(tarCommand(), ['-xf', archive, '-C', tmp], { windowsHide: true });
        const unpacked = asset.folder === undefined ? join(tmp, exe) : join(tmp, asset.folder, exe);
        if (!existsSync(unpacked)) throw new Error(`${asset.name} has no ${exe}`);
        if (!platform.startsWith('win32')) chmodSync(unpacked, 0o755);
        renameSync(unpacked, target);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    return target;
}
