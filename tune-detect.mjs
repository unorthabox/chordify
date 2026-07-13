/* Hyperparameter sweep for the detector's scoring weights.
 *
 * Dev-only by design: it reports the dev score, and detect-test.mjs reports both
 * dev and held-out. Tuning on the numbers you then quote is how you fit four knobs
 * to 24 songs and learn nothing. Not part of `npm test` — a tool you reach for.
 *
 *   node tune-detect.mjs W_BASS=0.1,0.22,0.35 W_KEY=0,0.06,0.12
 */
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-180.png'];
const PORT = 8936;

const grid = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  grid[k] = v.split(',').map(Number);
}
if (!Object.keys(grid).length) {
  console.error('usage: node tune-detect.mjs W_BASS=0.1,0.2 W_KEY=0,0.06');
  process.exit(2);
}

// cartesian product of the grid
let combos = [{}];
for (const [k, vals] of Object.entries(grid))
  combos = combos.flatMap(c => vals.map(v => ({ ...c, [k]: v })));

const src = await readFile('index.html', 'utf8');
const run = (dir) => new Promise((res) => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                    { cwd: dir, stdio: 'ignore' });
  setTimeout(() => {
    let out = '';
    const t = spawn('node', ['detect-test.mjs'],
                    { env: { ...process.env, BASE: `http://127.0.0.1:${PORT}/` } });
    t.stdout.on('data', d => out += d);
    t.on('exit', () => { srv.kill(); res(out); });
  }, 1200);
});

console.log(`${combos.length} combos\n`);
const rows = [];
for (const c of combos) {
  let html = src;
  for (const [k, v] of Object.entries(c)) {
    const re = new RegExp(`(const\\s+[^;]*\\b${k}\\s*=\\s*)-?[0-9.]+`);
    if (!re.test(html)) { console.error(`!! ${k} not found in index.html`); process.exit(1); }
    html = html.replace(re, `$1${v}`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'cfy-tune-'));
  for (const f of SITE) await cp(f, join(dir, f));
  await writeFile(join(dir, 'index.html'), html);
  const out = await run(dir);
  await rm(dir, { recursive: true, force: true });

  const g = (re) => { const m = out.match(re); return m ? +m[1] : null; };
  const r = {
    ...c,
    triad: g(/CSR-triad\s+([\d.]+)%/),  triadHeld: g(/CSR-triad\s+[\d.]+%\s+\(held-out ([\d.]+)%/),
    seven: g(/CSR-7th\s+([\d.]+)%/),    sevenHeld: g(/CSR-7th\s+[\d.]+%\s+\(held-out ([\d.]+)%/),
    over:  g(/over-extension ([\d.]+)%/),
  };
  rows.push(r);
  const keys = Object.keys(c).map(k => `${k}=${c[k]}`).join(' ');
  console.log(`  ${keys.padEnd(34)} triad ${String(r.triad).padStart(5)}%  7th ${String(r.seven).padStart(5)}%  over+ ${String(r.over).padStart(4)}%`);
}

// rank by 7th accuracy, but never at the cost of the triad floor
const best = rows.filter(r => r.triad !== null)
                 .sort((a, b) => (b.seven + b.triad) - (a.seven + a.triad))[0];
console.log('\nbest by (triad + 7th):');
console.log('  ' + Object.entries(best).map(([k, v]) => `${k}=${v}`).join('  '));
console.log('\n  \x1b[2mheld-out is shown only to confirm it did not diverge — do not tune on it\x1b[0m');
