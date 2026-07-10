import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8933/';
const fail = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { fail.push(m); console.log('  FAIL  ' + m); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('#app');

// --- UI restructure: branding, header buttons, drawer, settings, panel order ---
const ui = await page.evaluate(() => ({
  tag: document.querySelector('header .tag').textContent,
  title: document.title,
  themeBtnGone: !document.getElementById('themeBtn'),
  ytKeyBtnGone: !document.getElementById('ytKeyBtn'),
  rackBeforeCrt: !!(document.getElementById('rack').compareDocumentPosition(document.getElementById('crt')) & Node.DOCUMENT_POSITION_FOLLOWING),
}));
ui.tag.includes('Colton.ink') && ui.title.includes('Colton.ink') && !ui.tag.includes('RobCo')
  ? ok('rebranded to Colton.ink (header + title)') : bad('branding: ' + JSON.stringify([ui.tag, ui.title]));
ui.themeBtnGone && ui.ytKeyBtnGone ? ok('themeBtn and ytKeyBtn removed from main page') : bad('stale buttons remain');
ui.rackBeforeCrt ? ok('controls (rack) sit above the grid (crt)') : bad('rack is not before crt');

await page.click('#songsBtn');
await page.waitForFunction(() => document.getElementById('library').getBoundingClientRect().x > -10, { timeout: 3000 });
let drawer = await page.evaluate(() => ({
  open: document.getElementById('library').classList.contains('open'),
  scrim: getComputedStyle(document.getElementById('libScrim')).display,
  visible: getComputedStyle(document.getElementById('library')).visibility === 'visible',
}));
drawer.open && drawer.scrim === 'block' && drawer.visible ? ok('songs drawer slides in with scrim') : bad('drawer: ' + JSON.stringify(drawer));
await page.click('#libScrim', { position: { x: 400, y: 300 } });
await page.waitForTimeout(350);
drawer = await page.evaluate(() => document.getElementById('library').classList.contains('open'));
!drawer ? ok('scrim tap closes the drawer') : bad('drawer did not close');

await page.click('#settingsBtn');
await page.waitForSelector('#settings.open');
const phosBefore = await page.evaluate(() => document.documentElement.getAttribute('data-phosphor') || 'green');
await page.click('#stPhosBtn');
const phosAfter = await page.evaluate(() => document.documentElement.getAttribute('data-phosphor'));
phosAfter !== phosBefore ? ok(`settings phosphor toggle works (${phosBefore}→${phosAfter})`) : bad('phosphor toggle dead');
await page.click('#stPhosBtn'); // restore
await page.fill('#stKeyIn', 'TESTKEY123');
await page.click('#stKeySave');
await page.waitForTimeout(200);
const keyMsg = await page.textContent('#stMsg');
keyMsg.includes('SAVED') ? ok('settings API key save reports inline') : bad('key save msg: ' + keyMsg);
await page.fill('#stKeyIn', ''); await page.click('#stKeySave'); // clear again
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const settingsClosed = await page.evaluate(() => !document.getElementById('settings').classList.contains('open'));
settingsClosed ? ok('Escape closes settings') : bad('settings stuck open');

// --- performance view -------------------------------------------------------
await page.click('#viewPerf');
const cells = await page.locator('#perf .pcell').count();
cells > 0 ? ok(`perf view renders ${cells} big chord cells`) : bad('perf view empty');

const capHint = await page.locator('#perfCap .next').textContent();
capHint.includes('ATTACH A YOUTUBE VIDEO') ? ok('caption bar shows attach hint when no video') : bad('caption hint missing: ' + capHint);

await page.locator('#perf .pcell').nth(3).click();
await page.waitForTimeout(300);
const activeIdx = await page.evaluate(() => {
  const el = document.querySelector('#perf .pcell.active');
  return el ? el.dataset.i : null;
});
activeIdx === '3' ? ok('tapping a perf cell seeks + highlights it') : bad('active cell after tap: ' + activeIdx);

const fontPx = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('#perf .pcell .pname')).fontSize));
fontPx >= 30 ? ok(`chord name renders at ${fontPx}px (big)`) : bad(`chord font only ${fontPx}px`);

// --- transcript parsing (pure functions) ------------------------------------
const parsed = await page.evaluate(() => {
  const ours = parseLyrText('0:12.5 | hello world\n0:16.0 | second line');
  const ytPaste = parseLyrText('0:12\nhello world\n0:16\nsecond line');
  const noStamp = parseLyrText('just words\nmore words');
  const ttml = parseTTML('<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
    '<p begin="00:00:18.640" end="00:00:21.880">♪ We\'re no strangers to love ♪</p>' +
    '<p begin="00:00:22.640" end="00:00:26.960">[Music]</p>' +
    '<p begin="00:01:02.000" end="00:01:04.000">real line</p></div></body></tt>');
  return { ours, ytPaste, noStamp, ttml };
});
parsed.ours.length === 2 && parsed.ours[0].t === 12.5 ? ok('parseLyrText: pipe format') : bad('pipe format: ' + JSON.stringify(parsed.ours));
parsed.ytPaste.length === 2 && parsed.ytPaste[1].t === 16 ? ok('parseLyrText: YouTube-paste format') : bad('yt-paste: ' + JSON.stringify(parsed.ytPaste));
parsed.noStamp.length === 2 ? ok('parseLyrText: bare words get sequential stamps') : bad('bare words: ' + JSON.stringify(parsed.noStamp));
parsed.ttml.length === 2 && Math.abs(parsed.ttml[0].t - 18.64) < 0.01 && !parsed.ttml.some(l => l.text.includes('['))
  ? ok('parseTTML: timestamps parsed, [Music] filtered, ♪ stripped') : bad('ttml: ' + JSON.stringify(parsed.ttml));

// --- LRCLIB path: title cleaning, LRC parsing, live lookup -------------------
const lrc = await page.evaluate(async () => {
  const cleaned = cleanQuery('Oasis - Wonderwall (Official Video) [HD]');
  const parsed = parseLRC('[00:38.43] Today is gonna be the day\n[00:43.46] And by now\nnoise line\n[01:00.26][02:00.00] repeated line');
  CFY.yt.title = 'Oasis - Wonderwall (Official Video)';
  CFY.yt.videoId = 'lrctest';
  try {
    const d = await fetchLyricsDB('lrctest');
    return { cleaned, parsed, n: d.lines.length, synced: d.synced, src: d.srcName, first: d.lines[0] };
  } catch (e) { return { cleaned, parsed, err: e.message }; }
});
lrc.cleaned === 'Oasis - Wonderwall' ? ok('cleanQuery strips video-title noise') : bad('cleanQuery: "' + lrc.cleaned + '"');
lrc.parsed.length === 4 && lrc.parsed[0].t === 38.43 && lrc.parsed[3].t === 120
  ? ok('parseLRC: stamps, multi-tag lines, noise skipped') : bad('parseLRC: ' + JSON.stringify(lrc.parsed));
if (lrc.err) bad('live LRCLIB lookup failed: ' + lrc.err);
else {
  lrc.synced && lrc.n > 20 ? ok(`live LRCLIB: ${lrc.n} synced lines via ${lrc.src}, first @${lrc.first.t}s "${lrc.first.text.slice(0, 30)}"`)
                           : bad('LRCLIB result shape: ' + JSON.stringify({ n: lrc.n, synced: lrc.synced }));
}
await page.evaluate(() => { CFY.yt.title = ''; CFY.yt.videoId = null; });

// --- live transcript fetch through the app's own chain ----------------------
const fetched = await page.evaluate(async () => {
  try {
    const d = await fetchTranscript('dQw4w9WgXcQ');
    return { n: d.lines.length, first: d.lines[0], cached: !!trGet('dQw4w9WgXcQ') };
  } catch (e) { return { err: e.message }; }
});
if (fetched.err) bad('live fetchTranscript failed: ' + fetched.err);
else {
  ok(`live transcript fetched: ${fetched.n} lines, first @${fetched.first.t}s "${fetched.first.text.slice(0, 40)}"`);
  fetched.cached ? ok('transcript cached in localStorage') : bad('transcript not cached');
}

// --- transcript shows in lyrics view + editor round-trip ---------------------
await page.evaluate(() => { CFY.yt.videoId = 'dQw4w9WgXcQ'; });
await page.click('#viewLyr');
const trLines = await page.locator('#lyrics .tr-line').count();
trLines > 10 ? ok(`lyrics view renders ${trLines} transcript lines`) : bad('transcript lines in lyrics view: ' + trLines);

await page.click('#lyrEditBtn');
await page.waitForSelector('#lyrEdit', { state: 'visible' });
const txt = await page.inputValue('#lyrTxt');
txt.includes(' | ') ? ok('editor opens pre-filled with fetched transcript') : bad('editor content: ' + txt.slice(0, 80));
await page.fill('#lyrTxt', '0:05.0 | edited first line\n0:09.0 | edited second line');
await page.click('#lyrSaveBtn');
await page.waitForSelector('#lyrEdit', { state: 'hidden' });
const after = await page.evaluate(() => trGet('dQw4w9WgXcQ'));
after.edited && after.lines.length === 2 && after.lines[0].text === 'edited first line'
  ? ok('editor save round-trips (edited flag, 2 lines)') : bad('after save: ' + JSON.stringify(after));
const shown = await page.locator('#lyrics .tr-line').count();
shown === 2 ? ok('lyrics view re-rendered with edited lines') : bad('lyrics after edit: ' + shown + ' lines');

// --- search fallback without an API key --------------------------------------
const search = await page.evaluate(async () => {
  try { const r = await ytSearch('wonderwall oasis'); return { n: r.length, first: r[0] }; }
  catch (e) { return { err: e.message }; }
});
search.err ? bad('keyless search failed: ' + search.err)
           : ok(`keyless search works: ${search.n} results, first "${search.first.title.slice(0, 40)}" id=${search.first.id}`);

await browser.close();
console.log('\npage errors: ' + (errors.length ? JSON.stringify(errors) : 'none'));
console.log(fail.length ? `\n${fail.length} FAILURE(S)` : '\nALL FEATURE CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
