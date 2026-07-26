/* Test runner. `npm test` runs everything; `npm test -- pwa` runs one suite.
 *
 * Each suite wants its own static server on its own port (they install service
 * workers, and a shared origin would let one suite's SW serve another's pages).
 * update-test REWRITES index.html to prove a new version propagates — so it gets
 * a throwaway copy of the site, never the working tree. A failed run used to be
 * able to leave your source clobbered.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';

const SUITES = [
  { name: 'pwa',     file: 'pwa-test.mjs',     port: 8931 },
  { name: 'update',  file: 'update-test.mjs',  port: 8932, sandbox: true },
  { name: 'feature', file: 'feature-test.mjs', port: 8933, network: true },
  { name: 'detect',  file: 'detect-test.mjs',  port: 8935 }, // 8934 is the analysis server's port
  // WebKit — Safari's engine, the only one iOS allows. Opt-in: it needs the WebKit
  // browser build (`npx playwright install webkit`; on Linux also `install-deps webkit`,
  // which wants sudo) and, to check the decode path that actually matters, a real m4a.
  // Not in the default run because a clean checkout has neither.
  { name: 'ios',     file: 'ios-test.mjs',     port: 8938, optIn: true, network: true },
  // The Phase-1 analysis backend. Opt-in: needs server/.venv, a fixture m4a, and a
  // ~1min real separation run (GPU if free). Boots its own server — no static site.
  { name: 'server',  file: 'server-test.mjs',  port: 8939, optIn: true, noServe: true },
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
    `silently test THAT instead. Kill whatever owns that port first.`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.m4a': 'audio/mp4',
};

/* In-process static server (was `python3 -m http.server`, which Windows lacks).
 * No-store so update-test's rewritten index.html is never masked by HTTP cache —
 * the suites exercise the service worker's cache, not the browser's. */
const serve = async (dir, port) => {
  await assertPortFree(port);
  const root = resolve(dir);
  const srv = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = resolve(root, path.replace(/^\/+/, '') || 'index.html');
      if (file !== root && !file.startsWith(root + sep)) throw new Error('traversal');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((res, rej) => {
    srv.on('error', rej);
    srv.listen(port, '127.0.0.1', res);
  });
  return { kill: () => srv.close() };
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
    if (!s.noServe) srv = await serve(dir, s.port);
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
