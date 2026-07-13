/* Test runner. `npm test` runs everything; `npm test -- pwa` runs one suite.
 *
 * Each suite wants its own static server on its own port (they install service
 * workers, and a shared origin would let one suite's SW serve another's pages).
 * update-test REWRITES index.html to prove a new version propagates — so it gets
 * a throwaway copy of the site, never the working tree. A failed run used to be
 * able to leave your source clobbered.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUITES = [
  { name: 'pwa',     file: 'pwa-test.mjs',     port: 8931 },
  { name: 'update',  file: 'update-test.mjs',  port: 8932, sandbox: true },
  { name: 'feature', file: 'feature-test.mjs', port: 8933, network: true },
  { name: 'detect',  file: 'detect-test.mjs',  port: 8935 }, // 8934 is grab-server's port
  // WebKit — Safari's engine, the only one iOS allows. Opt-in: it needs WebKit's
  // system deps (`npx playwright install-deps webkit`, wants sudo) and, to check the
  // decode path that actually matters, a real m4a. Not in the default run because a
  // clean checkout has neither.
  { name: 'ios',     file: 'ios-test.mjs',     port: 8938, optIn: true, network: true },
];

const SITE_FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-180.png'];

const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const suites = want.length ? SUITES.filter(s => want.includes(s.name))
                           : SUITES.filter(s => !s.optIn);
if (!suites.length) {
  console.error('unknown suite. known: ' + SUITES.map(s => s.name).join(', '));
  process.exit(2);
}

/* Refuse a port we don't own. A leftover server from an earlier run will answer
 * our readiness poll perfectly happily while serving a stale copy of the site —
 * the suites then pass against code that isn't the code you just wrote. That has
 * already happened once. Fail loudly instead. */
async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); }
  catch { return; }                       // nothing there — good
  throw new Error(
    `:${port} is already in use. Something else is serving there and the suite would ` +
    `silently test THAT instead. Kill it first:  fuser -k ${port}/tcp`);
}

const serve = async (dir, port) => {
  await assertPortFree(port);
  const p = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
                  { cwd: dir, stdio: 'ignore' });
  let dead = null;
  p.on('exit', c => { dead = c; });
  const t0 = Date.now();
  for (;;) {
    if (dead !== null) throw new Error(`server on :${port} exited immediately (code ${dead})`);
    try { await fetch(`http://127.0.0.1:${port}/index.html`); return p; } catch {}
    if (Date.now() - t0 > 10000) { p.kill(); throw new Error(`server on :${port} never came up`); }
    await new Promise(r => setTimeout(r, 100));
  }
};

const results = [];
for (const s of suites) {
  console.log(`\n\x1b[1m── ${s.name} ${'─'.repeat(Math.max(0, 56 - s.name.length))}\x1b[0m`);
  if (s.network) console.log('  \x1b[2m(needs network — hits live Piped mirrors)\x1b[0m');

  let dir = process.cwd(), tmp = null;
  if (s.sandbox) {
    tmp = await mkdtemp(join(tmpdir(), 'chordify-'));
    for (const f of SITE_FILES) await cp(join(process.cwd(), f), join(tmp, f));
    dir = tmp;
  }

  let srv = null, code = 1;
  try {
    srv = await serve(dir, s.port);
    code = await new Promise(res => {
      const t = spawn('node', [s.file], {
        stdio: 'inherit',
        env: { ...process.env, BASE: `http://127.0.0.1:${s.port}/`, SITE: dir },
      });
      t.on('error', () => res(1));
      t.on('exit', c => res(c ?? 1));
    });
  } catch (e) {
    console.log('  \x1b[31mFAIL\x1b[0m  ' + e.message);
  } finally {
    if (srv) srv.kill();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
  results.push({ name: s.name, ok: code === 0 });
}

console.log('\n\x1b[1m── summary ' + '─'.repeat(48) + '\x1b[0m');
for (const r of results) console.log(`  ${r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${r.name}`);
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n\x1b[31m${failed.length} suite(s) failed\x1b[0m` : '\n\x1b[32mall suites passed\x1b[0m');
process.exit(failed.length ? 1 : 0);
