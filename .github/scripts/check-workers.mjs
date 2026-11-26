// Runs the built app and content Workers under `wrangler dev` (workerd, as in production) and checks that they read
// their vars: the app frames the configured content origin, hands it to the demo page, and the content origin lets
// only the configured app frame it. Run after `pnpm build`. With --preview it also checks the preview path, where the
// Preview workflow overrides the vars with --var.
//
// The deployed app once framed http://localhost:5185: SvelteKit 3 no longer fills `event.platform`, and the code fell
// back to its development default. Unit tests could not see that; only the built Worker can.
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const root = new URL('../../', import.meta.url);

/** Stops `child` and everything it started (wrangler starts workerd). */
function stop(child) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
}

/** Starts `wrangler dev` for an app on `port` with `vars` overridden, and resolves once it answers. */
async function start(app, port, vars) {
    // A server already on the port would be checked instead of this build.
    if (
        await fetch(`http://127.0.0.1:${port}/`).then(
            () => true,
            () => false,
        )
    )
        throw new Error(`port ${port} is already in use`);
    const args = ['dev', '--port', String(port), '--local', '--ip', '127.0.0.1', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
    // pnpm finds the app's own wrangler; on Windows it is a .cmd shim, which needs a shell.
    const child = spawn('pnpm', ['exec', 'wrangler', ...args], {
        cwd: new URL(`apps/${app}/`, root),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
    });
    let log = '';
    child.stdout.on('data', d => (log += d));
    child.stderr.on('data', d => (log += d));
    for (let i = 0; i < 120; i++) {
        try {
            await fetch(`http://127.0.0.1:${port}/`);
            return { child, log: () => log };
        } catch {
            await sleep(500);
        }
    }
    stop(child);
    throw new Error(`${app} did not start:\n${log}`);
}

function directive(csp, name) {
    return (csp ?? '')
        .split(';')
        .map(d => d.trim())
        .find(d => d.startsWith(`${name} `));
}

const failures = [];
function expectEqual(what, actual, expected) {
    if (actual !== expected) failures.push(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`ok  ${what}`);
}

async function check(label, contentOrigin, appOrigin, ports) {
    const web = await start('web', ports[0], contentOrigin ? { CONTENT_ORIGIN: contentOrigin } : {});
    const content = await start('content', ports[1], appOrigin ? { APP_ORIGIN: appOrigin } : {});
    try {
        const expectedContent = contentOrigin ?? 'https://user-content-papers.yukibana.run';
        const expectedApp = appOrigin ?? 'https://papers.yukibana.dev';
        const page = await fetch(`http://127.0.0.1:${ports[0]}/demo`);
        expectEqual(`${label}: /demo status`, page.status, 200);
        expectEqual(`${label}: app frame-src`, directive(page.headers.get('content-security-policy'), 'frame-src'), `frame-src ${expectedContent}`);
        const data = await (await fetch(`http://127.0.0.1:${ports[0]}/demo/__data.json`)).text();
        expectEqual(`${label}: demo data names the content origin`, data.includes(JSON.stringify(expectedContent)), true);
        expectEqual(`${label}: demo data names no local address`, /localhost|127\.0\.0\.1/.test(data), false);
        const frame = await fetch(`http://127.0.0.1:${ports[1]}/frame`);
        expectEqual(`${label}: /frame status`, frame.status, 200);
        expectEqual(`${label}: content frame-ancestors`, directive(frame.headers.get('content-security-policy'), 'frame-ancestors'), `frame-ancestors ${expectedApp}`);
    } finally {
        stop(web.child);
        stop(content.child);
    }
}

await check('production vars', null, null, [8791, 8792]);
if (process.argv.includes('--preview'))
    await check('preview --var', 'https://pr-1-yukibana-papers-content.example.workers.dev', 'https://pr-1-yukibana-papers.example.workers.dev', [8793, 8794]);

if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
}
process.exit(0);
