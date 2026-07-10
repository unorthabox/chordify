import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8933/';
const fail = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { fail.push(m); console.log('  FAIL  ' + m); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.emulateMedia({ reducedMotion: 'reduce' }); // skip the boot typewriter — it races status-text assertions
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('#app');

// --- UI restructure: branding, header buttons, stage order, split view -------
const ui = await page.evaluate(() => {
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const el = id => document.getElementById(id);
  return {
    tag: document.querySelector('header .tag').textContent,
    title: document.title,
    themeBtnGone: !document.getElementById('themeBtn'),
    ytKeyBtnGone: !document.getElementById('ytKeyBtn'),
    inspectorGone: !document.getElementById('inspector'),
    stageFlowsCorrectly: before(el('ytPanel'), el('nowPlaying')) && before(el('nowPlaying'), el('transport'))
      && before(el('transport'), el('crt')) && before(el('crt'), el('rack')),
    togglesInTransport: document.getElementById('transport').contains(document.getElementById('simplifySw'))
      && document.getElementById('transport').contains(document.getElementById('miniDiagSw')),
    lyricsDisplay: getComputedStyle(document.getElementById('lyrics')).display,
    gridDisplay: getComputedStyle(document.getElementById('grid')).display,
    viewTabsGone: !document.getElementById('viewTabs') && !document.getElementById('viewPerf'),
  };
});
ui.tag.includes('Colton.ink') && ui.title.includes('Colton.ink') && !ui.tag.includes('RobCo')
  ? ok('rebranded to Colton.ink (header + title)') : bad('branding: ' + JSON.stringify([ui.tag, ui.title]));
ui.themeBtnGone && ui.ytKeyBtnGone ? ok('themeBtn and ytKeyBtn removed from main page') : bad('stale buttons remain');
ui.inspectorGone ? ok('desktop inspector column removed') : bad('#inspector still present');
ui.stageFlowsCorrectly ? ok('stage order: search → now playing → controls → split view → rack')
  : bad('stage order wrong');
ui.togglesInTransport ? ok('simplify/mini-diagram toggles live in the control board')
  : bad('display toggles not inside #transport');
ui.viewTabsGone ? ok('grid/lyrics/perf tabs removed') : bad('leftover view tabs found');
ui.lyricsDisplay !== 'none' && ui.gridDisplay !== 'none'
  ? ok('lyrics and chords panes are both visible at once (split screen)')
  : bad('split view not simultaneous: ' + JSON.stringify({ lyrics: ui.lyricsDisplay, grid: ui.gridDisplay }));

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

// --- instrument selection persists across reloads, mini diagrams update ------
await page.evaluate(() => { const li = document.querySelector('#songlist li'); if (li) li.click(); });
await page.waitForTimeout(200);
const gtrLines = await page.evaluate(() => {
  const svg = document.querySelector('#grid .cell svg');
  return svg ? svg.querySelectorAll('line').length : -1;
});
await page.click('.inst-tabs .btn[data-inst="uke"]');
await page.waitForTimeout(200);
const ukeLinesLive = await page.evaluate(() => {
  const svg = document.querySelector('#grid .cell svg');
  return svg ? svg.querySelectorAll('line').length : -1;
});
ukeLinesLive !== gtrLines && ukeLinesLive > 0
  ? ok(`switching to UKE updates mini diagrams live (${gtrLines}→${ukeLinesLive} string lines)`)
  : bad(`mini diagram did not change on instrument switch: gtr=${gtrLines} uke=${ukeLinesLive}`);

await page.reload();
await page.waitForSelector('#app');
await page.waitForTimeout(200);
const afterReload = await page.evaluate(() => ({
  inst: window.CFY.st.inst,
  lit: document.querySelector('.inst-tabs .btn.lit')?.dataset.inst,
}));
afterReload.inst === 'uke' && afterReload.lit === 'uke'
  ? ok('instrument choice (UKE) persists across a reload')
  : bad('instrument did not persist: ' + JSON.stringify(afterReload));
await page.evaluate(() => { const li = document.querySelector('#songlist li'); if (li) li.click(); });
await page.waitForTimeout(200);
const ukeLinesAfterReload = await page.evaluate(() => {
  const svg = document.querySelector('#grid .cell svg');
  return svg ? svg.querySelectorAll('line').length : -1;
});
ukeLinesAfterReload === ukeLinesLive
  ? ok('mini diagrams render correctly (UKE shapes) after reload — no longer stuck on guitar')
  : bad(`mini diagram wrong after reload: expected ${ukeLinesLive} got ${ukeLinesAfterReload}`);
await page.click('.inst-tabs .btn[data-inst="gtr"]'); // restore default for the rest of the run

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

// --- transcript shows in the (always-visible) lyrics pane + editor round-trip -
await page.evaluate(() => { CFY.yt.videoId = 'dQw4w9WgXcQ'; renderLyrics(); });
const trLines = await page.locator('#lyrics .tr-line').count();
trLines > 10 ? ok(`lyrics pane renders ${trLines} transcript lines`) : bad('transcript lines in lyrics pane: ' + trLines);

// --- live-sync current-line highlight, driven by updateLive() ---------------
const curTest = await page.evaluate(() => {
  const tr = trGet('dQw4w9WgXcQ');
  if (!tr || tr.lines.length < 4) return { err: 'no cached transcript to test against' };
  CFY.yt.player = { getCurrentTime: () => tr.lines[2].t + 0.05 };
  updateLive();
  const cur = document.querySelector('#lyrics .tr-line.cur');
  return { curIdx: cur ? cur.dataset.li : null };
});
curTest.err ? bad('cur-line test setup: ' + curTest.err)
  : curTest.curIdx === '2' ? ok('current-line highlight (.cur) tracks playback position')
                           : bad('cur line index: ' + curTest.curIdx);

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
shown === 2 ? ok('lyrics pane re-rendered with edited lines') : bad('lyrics after edit: ' + shown + ' lines');

// --- visible "Fetch Lyrics" button next to the YouTube panel -----------------
await page.evaluate(() => {
  CFY.yt.title = 'Oasis - Wonderwall (Official Video)';
  CFY.yt.videoId = 'bx1Bh8ZvH84';
  document.getElementById('ytStage').style.display = 'flex';
});
await page.click('#ytLyrBtn');
await page.waitForFunction(
  () => document.getElementById('ytLyrBtn').textContent !== '⇣ Fetching…',
  { timeout: 20000 }
);
const ytLyrResult = await page.evaluate(() => ({
  msg: document.getElementById('ytMsg').textContent,
  lines: document.querySelectorAll('#lyrics .tr-line').length,
}));
ytLyrResult.msg.includes('LYRICS') && ytLyrResult.lines > 20
  ? ok(`⇣ Fetch Lyrics button (next to YouTube search) fetches on demand: ${ytLyrResult.lines} lines`)
  : bad('ytLyrBtn fetch result: ' + JSON.stringify(ytLyrResult));

// --- Process Song: auto-scale tempo to the video's real length, one-tap sync -
const process1 = await page.evaluate(async () => {
  const li = document.querySelector('#songlist li'); if (li) li.click();
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 5; this.getDuration = () => 200; this.setPlaybackRate = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  const totalBefore = totalUnits();
  await ytAttach('vid-process-test', 'Test Video Title', 'Test Channel');
  await new Promise(r => setTimeout(r, 30));
  const shArtistAfterAttach = document.getElementById('shArtist').textContent;
  document.getElementById('ytSyncBtn').click();
  return {
    shArtistAfterAttach,
    bpm: st.song.bpm,
    offset: CFY.yt.offset,
    expectedBpm: totalBefore * 60 / (200 - 5),
    ytBpmLcd: document.getElementById('ytBpmLcd').textContent,
  };
});
process1.shArtistAfterAttach === '▶ TEST VIDEO TITLE — TEST CHANNEL'
  ? ok('Now Playing artist line updates to the attached YouTube title + channel')
  : bad('shArtist after attach: ' + process1.shArtistAfterAttach);
process1.offset === 5 ? ok('⚙ Process Song captures the downbeat tap as offset') : bad('offset: ' + process1.offset);
Math.abs(process1.bpm - process1.expectedBpm) < 0.01
  ? ok(`⚙ Process Song auto-scales BPM to fit the video's real length (${process1.bpm.toFixed(1)} bpm)`)
  : bad(`auto-scale bpm: got ${process1.bpm}, expected ${process1.expectedBpm}`);
process1.ytBpmLcd === String(Math.round(process1.bpm))
  ? ok('BPM readout (replacing the old Tap Tempo button) reflects the auto-scaled value')
  : bad('ytBpmLcd: ' + process1.ytBpmLcd);

await page.evaluate(() => { CFY.yt.player.getCurrentTime = () => 5; ytDetach(false); });
const shArtistAfterDetach = await page.evaluate(() => document.getElementById('shArtist').textContent);
shArtistAfterDetach.includes('▶') === false
  ? ok('detaching restores the loaded song\'s own artist line')
  : bad('shArtist after detach: ' + shArtistAfterDetach);

// --- analyzeBuffer exposes phaseSec (used by the mic "Listen for Beat" flow) -
const beatDetect = await page.evaluate(async () => {
  if (!ensureCtx()) return { err: 'no ctx' };
  const sr = 22050, dur = 20, bpm = 120, beatSec = 60 / bpm;
  const buf = ctx.createBuffer(1, sr * dur, sr);
  const d = buf.getChannelData(0);
  for (let t = 0.2; t < dur; t += beatSec) {
    const start = Math.floor(t * sr);
    for (let i = 0; i < 400; i++) { if (start + i < d.length) d[start + i] += Math.sin(i * 0.5) * Math.exp(-i / 60); }
  }
  const result = await analyzeBuffer(buf, () => {});
  return { bpm: result.bpm, beatSec: result.beatSec, phaseSec: result.phaseSec };
});
beatDetect.bpm && Math.abs(beatDetect.bpm - 120) < 6
  ? ok(`analyzeBuffer detects tempo from a synthetic 120bpm click track (${beatDetect.bpm} bpm)`)
  : bad('click-track tempo detection: ' + JSON.stringify(beatDetect));
typeof beatDetect.phaseSec === 'number' && beatDetect.phaseSec >= 0 && beatDetect.phaseSec < beatDetect.beatSec
  ? ok(`analyzeBuffer exposes a beat phase (${beatDetect.phaseSec.toFixed(3)}s) for downbeat estimation`)
  : bad('phaseSec out of range: ' + JSON.stringify(beatDetect));

// --- 🎤 Listen for Beat: experimental mic-based tempo/downbeat estimation -----
const listenDenied = await page.evaluate(async () => {
  CFY.yt.videoId = 'vid-listen-test';
  CFY.yt.player = { getCurrentTime: () => 5 };
  const origGUM = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  document.getElementById('ytListenBtn').click();
  await new Promise(r => setTimeout(r, 300));
  const status = document.getElementById('statusTxt').textContent;
  const btnRestored = document.getElementById('ytListenBtn').textContent.includes('Listen for Beat');
  navigator.mediaDevices.getUserMedia = origGUM;
  return { status, btnRestored };
});
listenDenied.status.includes('MIC ACCESS DENIED') && listenDenied.btnRestored
  ? ok('🎤 Listen for Beat degrades gracefully when mic permission is denied')
  : bad('mic-denial handling: ' + JSON.stringify(listenDenied));

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
