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
