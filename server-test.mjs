/* Analysis-server test — the Phase-1 backend, end to end.
 *
 * Boots the FastAPI server from server/ on a test port with a throwaway data
 * dir, pre-seeds the fixture m4a as data/<vid>/source.m4a (so no network is
 * needed), then drives the real pipeline: POST /analyze → poll /job → four
 * AAC stems + analysis.json out. That includes a REAL GPU separation run, so
 * this is opt-in like ios: it needs the server venv, the fixture, and ~1min.
 *
 *   npm run test:server
 *
 * Model weights are shared from server/data/models so runs don't re-download
 * ~1GB. The stable server keeps port 8934; tests use 8939.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const PORT = 8939;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-secret';
const VID = 'dQw4w9WgXcQ';

const fail = [];
const ok  = (m) => console.log('  \x1b[32mPASS\x1b[0m  ' + m);
const bad = (m) => { fail.push(m); console.log('  \x1b[31mFAIL\x1b[0m  ' + m); };
const die = async (m) => { bad(m); await cleanup(); process.exit(1); };

// --- preconditions -------------------------------------------------------------
const fixture = existsSync('fixtures')
  ? (await readdir('fixtures')).find(n => n.endsWith('.m4a')) : null;
if (!fixture) { console.log('  \x1b[33mSKIP\x1b[0m  no fixtures/*.m4a — run yt-dlp first'); process.exit(1); }
if (!existsSync('server/.venv')) { console.log('  \x1b[33mSKIP\x1b[0m  server/.venv missing — see server/requirements.txt'); process.exit(1); }
const vid = fixture.match(/cfy-([\w-]{11})\.m4a/)?.[1] ?? VID;

// --- boot the server on a throwaway data dir -----------------------------------
const data = await mkdtemp(join(tmpdir(), 'chordify-server-'));
await cp(join('fixtures', fixture), join(data, vid, 'source.m4a'));

const srv = spawn('uv', ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: 'server', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CHORDIFY_KEY: KEY, CHORDIFY_DATA: data,
         CHORDIFY_MODELS: join(process.cwd(), 'server', 'data', 'models') },
});
let srvLog = '';
srv.stdout.on('data', d => srvLog += d);
srv.stderr.on('data', d => srvLog += d);

async function cleanup() {
  srv.kill();
  await new Promise(r => setTimeout(r, 500));
  await rm(data, { recursive: true, force: true }).catch(() => {});
}

const t0 = Date.now();
for (;;) {
  try { await fetch(`${BASE}/health`); break; } catch {}
  if (srv.exitCode !== null) await die(`server exited early (code ${srv.exitCode}):\n${srvLog.slice(-1500)}`);
  if (Date.now() - t0 > 30000) await die('server never came up:\n' + srvLog.slice(-1500));
  await new Promise(r => setTimeout(r, 250));
}

const H = { 'X-Chordify-Key': KEY };
const jfetch = async (path, opts = {}) =>
  fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

// --- 1. /health keeps the v1 contract and announces v2 -------------------------
const health = await (await fetch(`${BASE}/health`)).json();
health.ok === true ? ok('/health ok:true (v1 clients keep working)') : bad('/health ok !== true: ' + JSON.stringify(health));
health.ytdlp ? ok(`/health reports yt-dlp ${health.ytdlp}`) : bad('/health missing ytdlp version');
health.v2 === true && health.stems === true
  ? ok('/health announces v2+stems (Phase-2 client feature detection)')
  : bad('/health missing v2/stems flags: ' + JSON.stringify(health));

// --- 1b. the served app shell (tailnet devices need only the server URL) -------
const shell = await fetch(`${BASE}/`);
const shellHtml = shell.ok ? await shell.text() : '';
shell.ok && shellHtml.includes('GRAB_DEFAULTS')
  ? ok('/ serves the app shell (index.html)')
  : bad(`/ → ${shell.status}, expected index.html`);
const swRes = await fetch(`${BASE}/sw.js`);
swRes.ok && (swRes.headers.get('content-type') || '').includes('javascript')
  ? ok('/sw.js served as javascript (service worker can register)')
  : bad(`/sw.js → ${swRes.status} ${swRes.headers.get('content-type')}`);
for (const path of ['/server/.env', '/package.json', '/detect-baseline.json']) {
  const r = await fetch(BASE + path);
  r.status === 404 ? ok(`${path} → 404 (only the allowlisted shell is served)`)
                   : bad(`${path} → ${r.status}, wanted 404`);
}

// --- 2. auth gate --------------------------------------------------------------
const noKey = await fetch(`${BASE}/analyze`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: vid }) });
noKey.status === 401 ? ok('POST /analyze without key → 401') : bad(`POST /analyze without key → ${noKey.status}, wanted 401`);
const badVid = await jfetch('/analyze', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: '../../etc' }) });
badVid.status === 400 ? ok('bad video id → 400') : bad(`bad video id → ${badVid.status}, wanted 400`);

// --- 3. the pipeline: analyze → poll → done ------------------------------------
const an = await (await jfetch('/analyze', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: vid }) })).json();
an.job && !an.cached ? ok(`job queued: ${an.job}`) : bad('expected fresh job, got ' + JSON.stringify(an));

let job = null, lastState = '';
const t1 = Date.now();
for (;;) {
  job = await (await jfetch(`/job/${an.job}`)).json();
  if (job.status !== lastState) { console.log(`        job: ${job.status} (gpu ${job.gpu ?? 'cpu'})`); lastState = job.status; }
  if (job.status === 'done' || job.status === 'error') break;
  if (Date.now() - t1 > 300000) break;
  await new Promise(r => setTimeout(r, 2000));
}
job.status === 'done'
  ? ok(`pipeline finished in ${((Date.now() - t1) / 1000).toFixed(0)}s (gpu ${job.gpu ?? 'cpu'})`)
  : await die(`pipeline did not finish: ${JSON.stringify(job)}\n${srvLog.slice(-1500)}`);

// --- 4. outputs: analysis.json + 4 AAC stems -----------------------------------
const analysis = await (await jfetch(`/song/${vid}/analysis.json`)).json();
analysis.video_id === vid && Array.isArray(analysis.stems) && analysis.stems.length === 4
  ? ok(`analysis.json: ${analysis.stems.join('/')} via ${analysis.stem_model}, ${analysis.duration_s}s`)
  : bad('analysis.json shape: ' + JSON.stringify(analysis));

const pexec = promisify(execFile);
for (const stem of ['vocals', 'drums', 'bass', 'other']) {
  const f = join(data, vid, 'stems', `${stem}.m4a`);
  const size = (await stat(f).catch(() => ({ size: 0 }))).size;
  if (size < 100000) { bad(`${stem}.m4a missing or tiny (${size}B)`); continue; }
  const { stdout } = await pexec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name',
                                             '-of', 'default=noprint_wrappers=1:nokey=1', f]);
  stdout.trim() === 'aac'
    ? ok(`${stem}.m4a is AAC (${(size / 1048576).toFixed(1)}MB) — iOS-decodable`)
    : bad(`${stem}.m4a codec ${stdout.trim()}, wanted aac`);
}

// --- 5. cache + v1 /grab against the cached source -----------------------------
const again = await (await jfetch('/analyze', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: vid }) })).json();
again.cached === true ? ok('re-analyze → cached:true (analyze-once-cache-forever)') : bad('re-analyze not cached: ' + JSON.stringify(again));

const grab = await fetch(`${BASE}/grab?v=${vid}`);
const bytes = new Uint8Array(await grab.arrayBuffer());
grab.headers.get('content-type') === 'audio/mp4' && bytes.length > 500000
  ? ok(`/grab serves the cached m4a (${(bytes.length / 1048576).toFixed(1)}MB, audio/mp4) — v1 contract intact`)
  : bad(`/grab: type=${grab.headers.get('content-type')} len=${bytes.length}`);

const stemRange = await jfetch(`/song/${vid}/stem/vocals.m4a`, { headers: { Range: 'bytes=0-1023' } });
stemRange.status === 206 ? ok('stem endpoint honours Range (WebKit media-friendly)')
                         : bad(`Range request → ${stemRange.status}, wanted 206`);

await cleanup();
console.log(fail.length ? `\n${fail.length} FAILURE(S)` : '\nANALYSIS SERVER VERIFIED');
process.exit(fail.length ? 1 : 0);
