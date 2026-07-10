import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

const BASE = 'http://127.0.0.1:8932/';
const SITE = process.env.SITE;
const fail = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { fail.push(m); console.log('  FAIL  ' + m); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// First visit: SW installs and precaches the shell.
await page.goto(BASE, { waitUntil: 'load' });
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForSelector('#app');
const t0 = await page.title();
ok('initial title: ' + JSON.stringify(t0));

// Author ships a new version.
const html = readFileSync(SITE + '/index.html', 'utf8');
if (!html.includes('<title>Chordify — Colton.ink</title>')) {
  bad('title replace target not found in index.html — this test is silently a no-op, fix the string');
}
writeFileSync(SITE + '/index.html', html.replace('<title>Chordify — Colton.ink</title>',
                                                 '<title>CHORDIFY V2</title>'));
ok('index.html updated on the "server"');

// Launch #2: stale-while-revalidate should serve the OLD copy, and fetch the new
// one in the background.
const p2 = await ctx.newPage();
await p2.goto(BASE, { waitUntil: 'load' });
await p2.waitForSelector('#app');
const t1 = await p2.title();
t1 === t0 ? ok('launch 2 serves cached copy (expected — that is what makes it instant/offline)')
          : ok('launch 2 already shows new copy: ' + JSON.stringify(t1));

// Give the background revalidation a moment to land in the cache.
await p2.waitForTimeout(1500);

// Launch #3: the refreshed copy must now be what's served.
const p3 = await ctx.newPage();
await p3.goto(BASE, { waitUntil: 'load' });
await p3.waitForSelector('#app');
const t2 = await p3.title();
t2 === 'CHORDIFY V2'
  ? ok('launch 3 serves the UPDATED copy — updates do propagate without a VERSION bump')
  : bad(`launch 3 still stale: ${JSON.stringify(t2)} — users would be stuck on the old app`);

// And the updated copy must still work offline.
await ctx.setOffline(true);
const p4 = await ctx.newPage();
try {
  await p4.goto(BASE, { waitUntil: 'load', timeout: 10000 });
  await p4.waitForSelector('#stage', { timeout: 8000 });
  const t3 = await p4.title();
  t3 === 'CHORDIFY V2' ? ok('offline after update: serves updated copy, app boots')
                       : bad('offline after update: title = ' + JSON.stringify(t3));
} catch (e) {
  bad('offline after update failed: ' + e.message);
}
await ctx.setOffline(false);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILURE(S)` : '\nUPDATE PATH OK');
process.exit(fail.length ? 1 : 0);
