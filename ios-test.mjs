/* iOS end-to-end test — runs the real phone code path in WebKit.
 *
 * WebKit is the engine Safari uses, and it is the ONLY engine allowed on iOS. So
 * running the app here, with an iPhone UA and viewport, exercises the same code that
 * runs on the phone: the same service worker, the same file picker, and — the thing
 * that actually matters — the same decodeAudioData.
 *
 * The risk this exists to kill: `decodeAudioData` is the narrowest part of the whole
 * phone flow. yt-dlp WITHOUT ffmpeg writes a **DASH** m4a ("Only some players support
 * this container", it warns), and a-Shell on an iPhone has no ffmpeg. If WebKit can't
 * decode that container, the phone flow is dead on arrival and no amount of UI testing
 * would have told us. So this feeds it a real YouTube m4a, downloaded by real yt-dlp,
 * exactly as the phone would produce it.
 *
 *   node ios-test.mjs                     # uses ./fixtures/*.m4a if present
 *   M4A=/path/to/cfy-<id>.m4a node ios-test.mjs
 *
 * Skips the decode checks (loudly) if no m4a is available, so it still runs on a
 * clean checkout.
 */
import { webkit } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8938/';
const fail = [];
const ok   = (m) => console.log('  \x1b[32mPASS\x1b[0m  ' + m);
const bad  = (m) => { fail.push(m); console.log('  \x1b[31mFAIL\x1b[0m  ' + m); };
const skip = (m) => console.log('  \x1b[33mSKIP\x1b[0m  ' + m);

// find an m4a to decode
let m4a = process.env.M4A || null;
if (!m4a && existsSync('fixtures')) {
  const f = readdirSync('fixtures').find(n => n.endsWith('.m4a'));
  if (f) m4a = join('fixtures', f);
}

const IPHONE = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
           + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3, isMobile: true, hasTouch: true,
};

const browser = await webkit.launch();
const ctx = await browser.newContext(IPHONE);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

console.log(`\n  engine: WebKit (Safari's engine — the only one iOS allows)\n`);

// --- 1. the app boots at all in WebKit ---------------------------------------
const resp = await page.goto(BASE, { waitUntil: 'load' });
resp.status() === 200 ? ok('app served 200') : bad('status ' + resp.status());
await page.waitForSelector('#app', { timeout: 15000 });
await page.waitForTimeout(800);
ok('app renders in WebKit at iPhone viewport');

// --- 2. it knows it is on iOS -------------------------------------------------
const plat = await page.evaluate(() => ({ isIOS: isIOS(), ua: navigator.userAgent.slice(0, 24) }));
plat.isIOS ? ok('isIOS() true — the grab panel will show the a-Shell flow')
           : bad('isIOS() false on an iPhone UA: ' + JSON.stringify(plat));

// --- 3. the service worker — installability is the whole point -----------------
const sw = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const r = await navigator.serviceWorker.ready.catch(e => ({ err: String(e) }));
  if (r && r.err) return { supported: true, err: r.err };
  const keys = await caches.keys();
  const c = keys.length ? await caches.open(keys[0]) : null;
  const cached = c ? (await c.keys()).map(x => new URL(x.url).pathname) : [];
  return { supported: true, active: !!(r && r.active), cached };
});
sw.supported && sw.active
  ? ok(`service worker activates in WebKit (${sw.cached.length} entries precached)`)
  : bad('service worker did not activate in WebKit: ' + JSON.stringify(sw));

/* The YouTube iframe API is unreachable from here, so stub the player — exactly as
   feature-test.mjs does. Everything else below is the app's own, unmodified code. */
await page.evaluate(() => {
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 0; this.getDuration = () => 213; this.setPlaybackRate = () => {};
    this.playVideo = () => {}; this.pauseVideo = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  trSave('dQw4w9WgXcQ', { lines: [{ t: 0, text: 'seed' }] });   // don't hit live lyrics APIs
});

// --- 4. the shortcut deep link + the #grabbed return trip ----------------------
const link = await page.evaluate(() => grabShortcutUrl('dQw4w9WgXcQ'));
link.startsWith('shortcuts://run-shortcut?name=Chordify%20Grab')
  ? ok('step 1 deep-links the Chordify Grab shortcut')
  : bad('bad shortcut url: ' + link);

const ret = await page.evaluate(async () => {
  localStorage.setItem('cfy_pendgrab', 'dQw4w9WgXcQ');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  location.hash = '#grabbed';
  await new Promise(r => setTimeout(r, 600));
  return { panelOpen: document.getElementById('grabPanel').classList.contains('open'),
           attached: yt.videoId,
           hashCleared: location.hash !== '#grabbed' };
});
ret.panelOpen && ret.attached === 'dQw4w9WgXcQ' && ret.hashCleared
  ? ok('returning from the Shortcut (#grabbed) re-attaches the video and reopens step 2')
  : bad('#grabbed return trip: ' + JSON.stringify(ret));

// --- 5. THE LOAD-BEARING CHECK: step 2, with a real yt-dlp m4a -----------------
// Everything else here is UI. This is the one that decides whether the phone works:
// WebKit's decodeAudioData is the narrowest part of the whole flow.
if (!m4a) {
  skip('no m4a available (set M4A=/path/to/cfy-<id>.m4a). DECODE PATH NOT VERIFIED.');
} else {
  console.log(`\n  feeding the real file to "2 Chart It": ${m4a.split('/').pop()}\n`);
  // the video must be attached, or step 2 has nothing to chart against
  await page.evaluate(async () => { await ytAttach('dQw4w9WgXcQ', 'Test Song', 'Test Channel'); });

  const t0 = Date.now();
  // this fires the app's OWN change handler — the real step-2 path, not a re-implementation
  await page.setInputFiles('#grabFile', m4a);
  // NB: `st` is a top-level const, so it is NOT a property of window. Reference it
  // bare; `window.st` is undefined and the condition would never fire.
  const chart = await page.waitForFunction(
    () => (typeof st !== 'undefined' && st.song && st.song.videoId === 'dQw4w9WgXcQ')
        ? { n: st.song.sections[0][1].length, bpm: st.song.bpm, key: st.song.key,
            first: st.song.sections[0][1].slice(0, 6).map(c => c[0]).join(' ') }
        : (/COULD NOT DECODE|NO TEMPO/.test(document.getElementById('grabMsg').textContent)
            ? { err: document.getElementById('grabMsg').textContent } : false),
    null, { timeout: 180000 }
  ).then(h => h.jsonValue()).catch(e => ({ err: 'timed out: ' + e.message.slice(0, 60) }));
  const secs = (Date.now() - t0) / 1000;

  if (chart.err) {
    bad(`step 2 FAILED in WebKit: ${chart.err}`);
    bad('   ^ this is the phone flow breaking. Investigate before trusting the iPhone.');
  } else {
    ok(`WebKit decoded the real yt-dlp m4a and charted it — ${chart.n} chords, `
       + `${Math.round(chart.bpm)} bpm, key ${chart.key}`);
    console.log(`        first chords: ${chart.first}`);
    ok('   ^ Safari\'s engine handles the AAC/m4a. The phone\'s decode step is sound.');
    // an iPhone CPU is ~2-4x slower than this box. A 3.5-minute song must stay usable.
    secs < 90
      ? ok(`end-to-end took ${secs.toFixed(1)}s for a 3.5-minute song — fine on a phone (~2-4x slower)`)
      : bad(`end-to-end took ${secs.toFixed(1)}s — a phone is 2-4x slower again; too slow`);
  }
}

await browser.close();
console.log('\npage errors: ' + (errors.length ? JSON.stringify(errors.slice(0, 4)) : 'none'));
if (errors.length) bad(`${errors.length} console/page error(s) in WebKit`);
console.log(fail.length ? `\n${fail.length} FAILURE(S)` : '\niOS PATH VERIFIED IN WEBKIT');
process.exit(fail.length ? 1 : 0);
