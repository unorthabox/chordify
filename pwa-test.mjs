import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8931/';
const fail = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { fail.push(m); console.log('  FAIL  ' + m); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// --- 1. online load -------------------------------------------------------
const resp = await page.goto(BASE, { waitUntil: 'load' });
resp.status() === 200 ? ok('index.html served 200') : bad('index.html status ' + resp.status());

await page.waitForSelector('#app', { timeout: 10000 });
ok('#app rendered');

// --- 2. manifest + icon ---------------------------------------------------
for (const [path, type] of [['manifest.webmanifest', 'json'], ['icon-180.png', 'image/png'], ['sw.js', 'javascript']]) {
  const r = await page.request.get(BASE + path);
  const ct = (r.headers()['content-type'] || '').toLowerCase();
  r.status() === 200 ? ok(`${path} served 200 (${ct || 'no content-type'})`) : bad(`${path} status ${r.status()}`);
}

const mf = await page.evaluate(async () => {
  const link = document.querySelector('link[rel=manifest]');
  if (!link) return null;
  return await (await fetch(link.href)).json();
});
mf && mf.display === 'standalone' ? ok('manifest display=standalone') : bad('manifest missing/not standalone');
mf && mf.start_url ? ok('manifest start_url=' + mf.start_url) : bad('manifest has no start_url');

// --- 3. service worker activation ----------------------------------------
const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return { scope: reg.scope, active: !!reg.active, state: reg.active && reg.active.state };
});
swState.active && swState.state === 'activated'
  ? ok(`service worker activated (scope ${swState.scope})`)
  : bad('service worker not activated: ' + JSON.stringify(swState));

// --- 4. shell actually precached -----------------------------------------
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = {};
  for (const n of names) {
    const c = await caches.open(n);
    out[n] = (await c.keys()).map((r) => new URL(r.url).pathname);
  }
  return out;
});
const all = Object.values(cached).flat();
console.log('  cache contents: ' + JSON.stringify(cached));
['/index.html', '/manifest.webmanifest', '/icon-180.png'].forEach((p) =>
  all.some((u) => u.endsWith(p)) ? ok('precached ' + p) : bad('NOT precached ' + p));

// --- 5. THE REAL TEST: offline reload -------------------------------------
await ctx.setOffline(true);
const page2 = await ctx.newPage();
const offErrors = [];
page2.on('pageerror', (e) => offErrors.push(e.message));

let offResp;
try {
  offResp = await page2.goto(BASE, { waitUntil: 'load', timeout: 15000 });
} catch (e) {
  bad('offline navigation threw: ' + e.message);
}
if (offResp) {
  offResp.status() === 200 ? ok('offline: index.html served from cache (200)') : bad('offline status ' + offResp.status());
  try {
    await page2.waitForSelector('#app', { timeout: 10000 });
    ok('offline: #app rendered');
    const title = await page2.title();
    ok('offline: title = ' + JSON.stringify(title));
    // stage/grid means the app actually booted its JS, not just static HTML
    await page2.waitForSelector('#stage', { timeout: 5000 });
    ok('offline: #stage rendered (app JS ran)');
    const handle = await page2.evaluate(() => typeof window.CFY);
    handle === 'object' ? ok('offline: window.CFY present (app initialised)') : bad('offline: window.CFY = ' + handle);
  } catch (e) {
    bad('offline: app did not render — ' + e.message);
  }
}

// --- 6. cross-origin offline must fail soft, not hang ----------------------
const ytBlocked = await page2.evaluate(async () => {
  try { await fetch('https://i.ytimg.com/vi/x/default.jpg', { mode: 'no-cors' }); return 'resolved'; }
  catch (e) { return 'rejected'; }
});
ok(`offline: cross-origin fetch ${ytBlocked} (expected rejected — SW passes it through, app degrades)`);

await ctx.setOffline(false);
await browser.close();

console.log('\nconsole/page errors online:  ' + (errors.length ? JSON.stringify(errors, null, 2) : 'none'));
console.log('page errors offline:         ' + (offErrors.length ? JSON.stringify(offErrors, null, 2) : 'none'));
console.log(fail.length ? `\n${fail.length} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
