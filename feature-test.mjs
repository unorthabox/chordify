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
    stageFlowsCorrectly: before(el('ytPanel'), el('transport')) && before(el('transport'), el('nowPlaying'))
      && before(el('nowPlaying'), el('crt')) && before(el('crt'), el('rack')),
    togglesInTransport: document.getElementById('transport').contains(document.getElementById('simplifySw'))
      && document.getElementById('transport').contains(document.getElementById('miniDiagSw')),
    instTabsPlacement: (() => {
      const it = document.getElementById('instTabs');
      return !!it && el('ytPanel').contains(it) && !el('ytStage').contains(it)
        && before(it, el('ytSyncBtn')) && getComputedStyle(it).display !== 'none';
    })(),
    onlyOneInstTabs: document.querySelectorAll('.inst-tabs').length === 1,
    lyricsDisplay: getComputedStyle(document.getElementById('lyrics')).display,
    gridDisplay: getComputedStyle(document.getElementById('grid')).display,
    viewTabsGone: !document.getElementById('viewTabs') && !document.getElementById('viewPerf'),
  };
});
ui.tag.includes('Colton.ink') && ui.title.includes('Colton.ink') && !ui.tag.includes('RobCo')
  ? ok('rebranded to Colton.ink (header + title)') : bad('branding: ' + JSON.stringify([ui.tag, ui.title]));
ui.themeBtnGone && ui.ytKeyBtnGone ? ok('themeBtn and ytKeyBtn removed from main page') : bad('stale buttons remain');
ui.inspectorGone ? ok('desktop inspector column removed') : bad('#inspector still present');
ui.stageFlowsCorrectly ? ok('stage order: search → controls → now playing → split view → rack')
  : bad('stage order wrong');
ui.togglesInTransport ? ok('simplify/mini-diagram toggles live in the control board')
  : bad('display toggles not inside #transport');
ui.instTabsPlacement && ui.onlyOneInstTabs
  ? ok('instrument tabs sit above ⚙ Process Song and stay visible before a video is attached')
  : bad('inst-tabs placement: ' + JSON.stringify(ui));
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
// No bundled song bank ships anymore — synthesize a minimal song directly,
// same shape a real import would produce, rather than clicking a library row.
const loadTestSong = () => {
  st.song = { id: 'test-song', title: 'Test Song', artist: 'Test Artist', bpm: 104, sig: [4, 4], key: 'Am',
    sections: [['VERSE', [['Am', 4], ['F', 4], ['C', 4], ['G', 4]]]] };
  st.cells = buildCells(st.song);
  st.mode = 'synth';
  $('shTitle').textContent = st.song.title.toUpperCase();
  $('shArtist').textContent = st.song.artist.toUpperCase();
  renderGrid();
};
await page.evaluate(loadTestSong);
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
await page.evaluate(loadTestSong);
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
const ytLyrResult = await page.evaluate(async () => {
  CFY.yt.title = 'Oasis - Wonderwall (Official Video)';
  CFY.yt.videoId = 'bx1Bh8ZvH84';
  document.getElementById('ytStage').style.display = 'flex';
  await refetchLyrics(null);   // btn-optional: this is how ⚙ Process Song calls it
  return {
    msg: document.getElementById('ytMsg').textContent,
    lines: document.querySelectorAll('#lyrics .tr-line').length,
  };
});
ytLyrResult.msg.includes('LYRICS') && ytLyrResult.lines > 20
  ? ok(`lyrics fetch (folded into ⚙ Process Song) pulls on demand: ${ytLyrResult.lines} lines`)
  : bad('refetchLyrics(null) result: ' + JSON.stringify(ytLyrResult));

// --- Process Song: ONE TAP → offset 0 + auto-scale tempo to the video's length
await page.evaluate(loadTestSong);
const process1 = await page.evaluate(async () => {
  // 16 beats over the full 13s duration (offset now defaults to 0, not a tapped
  // downbeat) = ~73.8bpm — inside the [30,300] clamp. getCurrentTime is 5, which
  // must NOT be captured as the offset anymore.
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 5; this.getDuration = () => 13; this.setPlaybackRate = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  trSave('vid-process-test', { lines: [{ t: 0, text: 'seed' }] });   // keep Process Song's lyric fetch off the network
  const totalBefore = totalUnits();
  await ytAttach('vid-process-test', 'Test Video Title', 'Test Channel');
  await new Promise(r => setTimeout(r, 30));
  const shArtistAfterAttach = document.getElementById('shArtist').textContent;
  document.getElementById('ytSyncBtn').click();
  await new Promise(r => setTimeout(r, 80));   // handler is async (awaits waitForDuration)
  return {
    shArtistAfterAttach,
    bpm: st.song.bpm,
    offset: CFY.yt.offset,
    expectedBpm: totalBefore * 60 / 13,
    ytBpmLcd: document.getElementById('ytBpmLcd').textContent,
  };
});
process1.shArtistAfterAttach === '▶ TEST VIDEO TITLE — TEST CHANNEL'
  ? ok('Now Playing artist line updates to the attached YouTube title + channel')
  : bad('shArtist after attach: ' + process1.shArtistAfterAttach);
process1.offset === 0
  ? ok('⚙ Process Song auto-sets offset to 0 — one tap, no downbeat timing required')
  : bad('offset should be 0 (not the playhead), got: ' + process1.offset);
Math.abs(process1.bpm - process1.expectedBpm) < 0.01
  ? ok(`⚙ Process Song auto-scales BPM to span the full video length (${process1.bpm.toFixed(1)} bpm)`)
  : bad(`auto-scale bpm: got ${process1.bpm}, expected ${process1.expectedBpm}`);
process1.ytBpmLcd === String(Math.round(process1.bpm))
  ? ok('BPM readout reflects the auto-scaled value')
  : bad('ytBpmLcd: ' + process1.ytBpmLcd);

// Process Song works even when tapped before the player reports a duration
// (getDuration() reads 0 until loaded) — the handler awaits waitForDuration.
const processWait = await page.evaluate(async () => {
  let t0 = null;
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 0;
    this.getDuration = () => { if (t0 === null) t0 = performance.now(); return (performance.now() - t0 > 160) ? 20 : 0; };
    this.setPlaybackRate = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  trSave('vid-wait-test', { lines: [{ t: 0, text: 'seed' }] });
  const total = totalUnits();
  await ytAttach('vid-wait-test', 'Wait Video', 'Chan');
  await new Promise(r => setTimeout(r, 30));
  document.getElementById('ytSyncBtn').click();
  await new Promise(r => setTimeout(r, 500));   // let waitForDuration poll past the 160ms stub gap
  return { bpm: st.song.bpm, expected: total * 60 / 20 };
});
Math.abs(processWait.bpm - processWait.expected) < 0.01
  ? ok('⚙ Process Song waits for the duration when tapped early, then scales correctly')
  : bad(`waitForDuration path: got ${processWait.bpm}, expected ${processWait.expected}`);

// Guards: no video attached → helpful status; no chart loaded + grabber down →
// auto-chart degrades gracefully with instructions and creates no song.
const processGuards = await page.evaluate(async () => {
  ytDetach(true);
  document.getElementById('ytSyncBtn').click();
  await new Promise(r => setTimeout(r, 20));
  const noVideo = document.getElementById('statusTxt').textContent;
  // now attach a video but clear the chart, with the grabber unreachable
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 0; this.getDuration = () => 100; this.setPlaybackRate = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  trSave('vid-guard0000', { lines: [{ t: 0, text: 'seed' }] });
  await ytAttach('vid-guard0000', 'Guard Video', 'Chan');
  await new Promise(r => setTimeout(r, 30));
  st.song = null; st.cells = [];
  const origFetch = window.fetch;
  window.fetch = (u, o) => String(u).includes(':8934')
    ? Promise.reject(new TypeError('connection refused'))
    : origFetch(u, o);
  document.getElementById('ytSyncBtn').click();
  for (let i = 0; i < 40 && document.getElementById('ytSyncBtn').disabled; i++)
    await new Promise(r => setTimeout(r, 50));
  window.fetch = origFetch;
  const noChart = document.getElementById('statusTxt').textContent;
  return { noVideo, noChart, noSongCreated: !st.song,
           panelOpen: document.getElementById('grabPanel').classList.contains('open'),
           shortcutUrl: grabShortcutUrl('vid-guard0000'),
           btnRestored: document.getElementById('ytSyncBtn').textContent.includes('Process Song') };
});
processGuards.noVideo.includes('ATTACH A YOUTUBE VIDEO')
  ? ok('⚙ Process Song with no video attached asks the user to attach one')
  : bad('no-video guard status: ' + processGuards.noVideo);
processGuards.panelOpen && processGuards.noChart.includes('GRAB AUDIO')
  && processGuards.noSongCreated && processGuards.btnRestored
  ? ok('⚙ Process Song with no grabber opens the phone grab panel (no server needed)')
  : bad('no-grabber fallback: ' + JSON.stringify(processGuards));
processGuards.shortcutUrl.startsWith('shortcuts://run-shortcut?name=Chordify%20Grab')
  && processGuards.shortcutUrl.includes(encodeURIComponent('https://www.youtube.com/watch?v=vid-guard0000'))
  ? ok('grab step 1 deep-links the Chordify Grab shortcut with the video URL')
  : bad('shortcut deep link: ' + processGuards.shortcutUrl);

// --- grab step 2: the picked file charts the attached video ------------------
const grabImport = await page.evaluate(async () => {
  const origDecode = window.chartFromAudioBytes;
  window.chartFromAudioBytes = async (ab, onProgress) => {   // stand in for the DSP; the detector has its own tests
    onProgress(0.5);
    return { res: { bpm: 120, key: 'C', phaseSec: 1.5, chords: [['C', 4], ['G', 4], ['Am', 4], ['F', 4]] } };
  };
  st.song = null; st.cells = [];
  st.imported = []; localStorage.removeItem('cfy_imported');
  const input = document.getElementById('grabFile');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(64)], 'cfy-vid-guard0000.m4a', { type: 'audio/mp4' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  for (let i = 0; i < 60 && !st.song; i++) await new Promise(r => setTimeout(r, 50));
  window.chartFromAudioBytes = origDecode;
  const beats = st.song && st.song.sections[0][1];
  return {
    videoId: st.song && st.song.videoId,
    bpm: st.song && st.song.bpm,
    beatsAreBeats: !!beats && beats[0][1] === 4 * (120 / 60),   // beat-denominated, not seconds
    offset: CFY.yt.offset,
    saved: JSON.parse(localStorage.getItem('cfy_imported') || '[]').length,
    panelClosed: !document.getElementById('grabPanel').classList.contains('open'),
    status: document.getElementById('statusTxt').textContent,
  };
});
grabImport.videoId === 'vid-guard0000' && grabImport.bpm === 120 && grabImport.beatsAreBeats
  && grabImport.saved === 1 && grabImport.panelClosed && grabImport.offset === 1.5
  && grabImport.status.includes('AUTO-CHARTED')
  ? ok('grab step 2 charts the picked file, attaches it to the video, and saves it')
  : bad('grab import: ' + JSON.stringify(grabImport));

// --- returning from the shortcut (#grabbed) puts you on step 2 ---------------
const grabbedReturn = await page.evaluate(async () => {
  st.song = null; st.cells = [];
  st.imported = []; localStorage.removeItem('cfy_imported');
  localStorage.setItem('cfy_pendgrab', 'vid-guard0000');
  location.hash = '#grabbed';
  await new Promise(r => setTimeout(r, 250));   // hashchange → checkGrabbedHash (async: may re-attach)
  return {
    panelOpen: document.getElementById('grabPanel').classList.contains('open'),
    msg: document.getElementById('grabMsg').textContent,
    pendCleared: !localStorage.getItem('cfy_pendgrab'),
    hashCleared: location.hash === '',
  };
});
grabbedReturn.panelOpen && grabbedReturn.msg.includes('cfy-vid-guard0000.m4a')
  && grabbedReturn.pendCleared && grabbedReturn.hashCleared
  ? ok('returning from the grab shortcut (#grabbed) reopens the panel on step 2')
  : bad('#grabbed return: ' + JSON.stringify(grabbedReturn));

// --- one button: Process Song fetches lyrics when missing, skips when cached --
const oneBtn = await page.evaluate(async () => {
  window.__origRefetch = refetchLyrics;
  const origFetch = window.fetch;
  window.fetch = (u, o) => String(u).includes(':8934')
    ? Promise.reject(new TypeError('connection refused'))   // keep the grabber out of this test
    : origFetch(u, o);
  let calls = 0;
  refetchLyrics = async () => { calls++; };
  trClear(CFY.yt.videoId);                                   // lyrics missing
  document.getElementById('ytSyncBtn').click();
  for (let i = 0; i < 60 && document.getElementById('ytSyncBtn').disabled; i++)
    await new Promise(r => setTimeout(r, 50));
  const whenMissing = calls;
  trSave(CFY.yt.videoId, { lines: [{ t: 0, text: 'cached' }] });   // lyrics cached
  document.getElementById('ytSyncBtn').click();
  for (let i = 0; i < 60 && document.getElementById('ytSyncBtn').disabled; i++)
    await new Promise(r => setTimeout(r, 50));
  const whenCached = calls;
  refetchLyrics = window.__origRefetch;
  window.fetch = origFetch;
  return { whenMissing, whenCached };
});
oneBtn.whenMissing === 1 && oneBtn.whenCached === 1
  ? ok('⚙ Process Song fetches lyrics when missing and skips when already cached (one button)')
  : bad('one-button lyrics: ' + JSON.stringify(oneBtn));
await page.evaluate(loadTestSong);   // restore a chart for the drag tests below

// --- Drag-to-adjust the OFFSET / BPM readout windows -------------------------
const dragOff = await page.evaluate(async () => {
  CFY.yt.offset = 2; document.getElementById('ytOffLcd').textContent = '2.00';
  const cell = document.getElementById('ytOffCell');
  const fire = (type, x) => cell.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 0, bubbles: true, pointerId: 1, button: 0 }));
  fire('pointerdown', 100); fire('pointermove', 200);       // +100px * 0.05 = +5.0s
  await new Promise(r => setTimeout(r, 40)); fire('pointerup', 200);
  const afterRight = CFY.yt.offset, lcdRight = document.getElementById('ytOffLcd').textContent;
  fire('pointerdown', 100); fire('pointermove', -100000);   // drag far left → clamp at 0
  await new Promise(r => setTimeout(r, 40)); fire('pointerup', -100000);
  return { afterRight, lcdRight, afterClamp: CFY.yt.offset };
});
Math.abs(dragOff.afterRight - 7) < 0.01 && dragOff.lcdRight === '7.00'
  ? ok(`dragging the OFFSET window adjusts it (2.00→${dragOff.lcdRight}s) and the ± buttons still fine-tune`)
  : bad('offset drag: ' + JSON.stringify(dragOff));
dragOff.afterClamp === 0
  ? ok('dragging OFFSET below zero clamps at 0')
  : bad('offset clamp: ' + dragOff.afterClamp);

const dragBpm = await page.evaluate(async () => {
  st.song.bpm = 100; updateYtBpmLcd();
  const cell = document.getElementById('ytBpmCell');
  const fire = (type, x) => cell.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 0, bubbles: true, pointerId: 1, button: 0 }));
  fire('pointerdown', 100); fire('pointermove', 200);       // +100px * 0.5 = +50 bpm
  await new Promise(r => setTimeout(r, 40)); fire('pointerup', 200);
  const afterRight = st.song.bpm, lcdRight = document.getElementById('ytBpmLcd').textContent;
  fire('pointerdown', 100); fire('pointermove', 100000);    // clamp high
  await new Promise(r => setTimeout(r, 40)); fire('pointerup', 100000);
  const clampHigh = st.song.bpm;
  fire('pointerdown', 100); fire('pointermove', -100000);   // clamp low
  await new Promise(r => setTimeout(r, 40)); fire('pointerup', -100000);
  const clampLow = st.song.bpm;
  // no throw when no chart is loaded
  const prevSong = st.song; st.song = null;
  let threw = false;
  try { fire('pointerdown', 100); fire('pointermove', 200); await new Promise(r => setTimeout(r, 40)); fire('pointerup', 200); }
  catch (e) { threw = true; }
  st.song = prevSong;
  return { afterRight, lcdRight, clampHigh, clampLow, threw };
});
Math.abs(dragBpm.afterRight - 150) < 0.01 && dragBpm.lcdRight === '150'
  ? ok(`dragging the BPM window adjusts it (100→${dragBpm.lcdRight} bpm)`)
  : bad('bpm drag: ' + JSON.stringify(dragBpm));
dragBpm.clampHigh === 300 && dragBpm.clampLow === 30
  ? ok('dragging BPM clamps to the [30, 300] range')
  : bad('bpm clamp: high=' + dragBpm.clampHigh + ' low=' + dragBpm.clampLow);
dragBpm.threw === false
  ? ok('dragging BPM with no chart loaded is a safe no-op (no crash)')
  : bad('bpm drag threw with st.song null');

// --- auto-chart end-to-end: Process Song with no chart downloads (stubbed) ----
// audio and builds a detected chord chart. The grabber fetch is stubbed with an
// in-page WAV click track at 120bpm; REAL decodeAudioData + analyzeBuffer run.
await page.evaluate(async () => {
  st.song = null; st.cells = [];
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 0; this.getDuration = () => 20; this.setPlaybackRate = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  trSave('vid-autochart', { lines: [{ t: 0, text: 'seed' }] });
  await ytAttach('vid-autochart', 'Auto Chart Video', 'Auto Channel');
  await new Promise(r => setTimeout(r, 30));
  // 20s mono 16-bit WAV, clicks every 0.5s (120bpm) from t=0.2
  const sr = 22050, dur = 20, n = sr * dur;
  const pcm = new Int16Array(n);
  for (let t = 0.2; t < dur; t += 0.5) {
    const start = Math.floor(t * sr);
    for (let i = 0; i < 400 && start + i < n; i++)
      pcm[start + i] += Math.round(Math.sin(i * 0.5) * Math.exp(-i / 60) * 20000);
  }
  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(wav);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(wav, 44).set(pcm);
  window.__origFetchAC = window.fetch;
  window.fetch = (u, o) => {
    const s = String(u);
    if (s.includes(':8934/health')) return Promise.resolve({ ok: true, json: async () => ({ ok: true, ytdlp: 'stub' }) });
    if (s.includes(':8934/grab')) return Promise.resolve({ ok: true, arrayBuffer: async () => wav });
    return window.__origFetchAC(u, o);
  };
  document.getElementById('ytSyncBtn').click();
});
await page.evaluate(async () => {
  for (let i = 0; i < 600 && document.getElementById('ytSyncBtn').disabled; i++)
    await new Promise(r => setTimeout(r, 100));
});
const autoChart = await page.evaluate(() => {
  window.fetch = window.__origFetchAC;
  return {
    hasSong: !!st.song,
    artist: st.song ? st.song.artist : null,
    bpm: st.song ? st.song.bpm : null,
    totalBeats: totalUnits(),
    offset: CFY.yt.offset,
    videoId: CFY.yt.videoId,
    status: document.getElementById('statusTxt').textContent,
    inLibrary: st.imported.some(s => s.artist && s.artist.includes('AUTO-CHARTED')),
  };
});
autoChart.hasSong && autoChart.artist && autoChart.artist.includes('AUTO-CHARTED')
  ? ok('⚙ Process Song with no chart auto-builds a detected chart from the video audio')
  : bad('auto-chart song: ' + JSON.stringify(autoChart));
autoChart.bpm && Math.abs(autoChart.bpm - 120) < 6
  ? ok(`auto-chart detects the real tempo (${autoChart.bpm} bpm from a 120bpm click track)`)
  : bad('auto-chart bpm: ' + autoChart.bpm);
autoChart.totalBeats / 20 > 1.5
  ? ok(`auto-chart cells are beats-denominated (${autoChart.totalBeats.toFixed(1)} beats over 20s of audio)`)
  : bad('cells look seconds-denominated: totalUnits=' + autoChart.totalBeats);
autoChart.offset >= 0 && autoChart.offset < 0.6 && autoChart.videoId === 'vid-autochart'
  ? ok(`auto-chart re-attaches the video and sets the downbeat offset (${autoChart.offset}s)`)
  : bad('offset/videoId: ' + autoChart.offset + ' / ' + autoChart.videoId);
autoChart.status.includes('AUTO-CHARTED') && autoChart.inLibrary
  ? ok('auto-charted song lands in the library with a summary status')
  : bad('status/library: ' + JSON.stringify(autoChart));

// --- persistence: the processed chart survives a full reload, and re-attaching
// the same video restores it (open app → tap recent → playing)
const persisted = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem('cfy_imported') || '[]')).some(s => s.videoId === 'vid-autochart'));
persisted
  ? ok('processed chart persisted to localStorage with its videoId')
  : bad('cfy_imported missing the auto-charted song');
await page.reload();
await page.waitForSelector('#app');
const resumed = await page.evaluate(async () => {
  const hydrated = st.imported.some(s => s.videoId === 'vid-autochart');
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 0; this.getDuration = () => 20; this.setPlaybackRate = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  await ytAttach('vid-autochart', 'Auto Chart Video', 'Auto Channel');
  await new Promise(r => setTimeout(r, 30));
  return { hydrated,
           songArtist: st.song ? st.song.artist : null,
           recentShown: getComputedStyle(document.getElementById('ytRecent')).display !== 'none',
           recentChips: document.querySelectorAll('#ytRecent .yt-recent-chip').length };
});
resumed.hydrated && resumed.songArtist && resumed.songArtist.includes('AUTO-CHARTED')
  ? ok('after a reload, re-attaching the video auto-restores its processed chart')
  : bad('resume: ' + JSON.stringify(resumed));
resumed.recentShown && resumed.recentChips >= 1
  ? ok(`recent-videos quick-resume row shows ${resumed.recentChips} chip(s)`)
  : bad('recent row: ' + JSON.stringify(resumed));

// --- declutter: synth-only modules hide in play-along mode, return on detach --
const declutter = await page.evaluate(() => {
  const disp = id => getComputedStyle(document.getElementById(id)).display;
  const attached = { mix: disp('mixMod'), countIn: disp('countInSw') };
  CFY.yt.player.getCurrentTime = () => 5;
  ytDetach(false);
  const detached = { mix: disp('mixMod'), countIn: disp('countInSw'),
                     shArtist: document.getElementById('shArtist').textContent };
  return { attached, detached };
});
declutter.attached.mix === 'none' && declutter.attached.countIn === 'none'
  ? ok('mixer and count-in hide while a video is attached (the video is the band)')
  : bad('declutter attached: ' + JSON.stringify(declutter.attached));
declutter.detached.mix !== 'none' && declutter.detached.countIn !== 'none'
  ? ok('mixer and count-in return after detaching')
  : bad('declutter detached: ' + JSON.stringify(declutter.detached));
declutter.detached.shArtist.includes('▶') === false
  ? ok('detaching restores the loaded song\'s own artist line')
  : bad('shArtist after detach: ' + declutter.detached.shArtist);

// --- importing an audio file auto-searches YouTube for it (⤺ Title, automated)
const importSearch = await page.evaluate(async () => {
  window.__origSearch2 = doYtSearch;
  let fired = null;
  doYtSearch = () => { fired = document.getElementById('ytQuery').value; };
  const sr = 22050, dur = 12, n = sr * dur;      // 12s click-track WAV, messy filename
  const pcm = new Int16Array(n);
  for (let t = 0.2; t < dur; t += 0.5) { const s = Math.floor(t * sr);
    for (let i = 0; i < 400 && s + i < n; i++) pcm[s + i] += Math.round(Math.sin(i * 0.5) * Math.exp(-i / 60) * 20000); }
  const wav = new ArrayBuffer(44 + n * 2); const dv = new DataView(wav);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  new Int16Array(wav, 44).set(pcm);
  const file = new File([wav], 'Wonderwall (Official Video).wav', { type: 'audio/wav' });
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('fileInput');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
  for (let i = 0; i < 300 && fired === null; i++) await new Promise(r => setTimeout(r, 100));
  const res = { fired, imported: st.imported.some(s => s.title.includes('Wonderwall')) };
  doYtSearch = window.__origSearch2;
  return res;
});
importSearch.fired && importSearch.fired.toLowerCase().includes('wonderwall') && importSearch.imported
  ? ok(`importing audio auto-searches YouTube for it ("${importSearch.fired}")`)
  : bad('import auto-search: ' + JSON.stringify(importSearch));

// --- no song bank: attaching a video with nothing loaded replaces the -------
// "NOW PLAYING - *" placeholder title, and Play works with no chords at all
const noBank = await page.evaluate(async () => {
  st.song = null; st.cells = []; st.mode = 'synth';
  st.imported = []; localStorage.removeItem('cfy_imported'); renderLibrary();   // drop charts from the tests above
  $('shTitle').textContent = 'NOW PLAYING - *';
  $('shArtist').textContent = 'SEARCH YOUTUBE TO BEGIN, OR IMPORT AUDIO';
  window.YT = { Player: function (el, opts) {
    this.getCurrentTime = () => 0; this.getDuration = () => 200; this.setPlaybackRate = () => {};
    this.playVideo = () => {};
    setTimeout(() => { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 0);
  }, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };
  window.loadYtApi = () => Promise.resolve();
  await ytAttach('vid-no-bank', 'Fresh Video Title', 'Some Channel');
  await new Promise(r => setTimeout(r, 30));
  document.getElementById('playBtn').click();
  await new Promise(r => setTimeout(r, 50));
  return {
    songBankEmpty: SONGS.length === 0,
    libraryNoEntries: document.getElementById('songlist').textContent.includes('NO ENTRIES'),
    shTitle: document.getElementById('shTitle').textContent,
    shArtist: document.getElementById('shArtist').textContent,
    playing: st.playing,
  };
});
noBank.songBankEmpty ? ok('bundled song bank removed (SONGS is empty)') : bad('SONGS still has entries');
noBank.libraryNoEntries ? ok('empty library shows "NO ENTRIES" with nothing imported') : bad('library not empty as expected');
noBank.shTitle === 'NOW PLAYING - FRESH VIDEO TITLE'
  ? ok('"NOW PLAYING - *" placeholder is replaced by the attached video\'s title')
  : bad('shTitle with no song loaded: ' + noBank.shTitle);
noBank.shArtist === 'SOME CHANNEL' ? ok('artist line shows the channel when no song is loaded') : bad('shArtist: ' + noBank.shArtist);
noBank.playing ? ok('▶ PLAY works in YouTube mode with no chord chart loaded at all') : bad('play did not start with no song loaded');

// --- analyzeBuffer exposes phaseSec (used by ⚙ auto-chart's downbeat offset) -
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

// --- tuner: readout opacity tracks signal, holds + fades instead of blanking --
const tunerFade = await page.evaluate(async () => {
  if (!ensureCtx()) return { err: 'no ctx' };
  micBuf = new Float32Array(8192);
  let signal = true;
  micAnalyser = { getFloatTimeDomainData(b) {
    const w = 2 * Math.PI * 440 / ctx.sampleRate;
    for (let i = 0; i < b.length; i++) b[i] = signal ? Math.sin(i * w) * 0.15 : 0;
  } };
  const step = () => { tunerLoop(); cancelAnimationFrame(tunerRaf); tunerRaf = null; };
  const note = () => document.getElementById('tunNote').textContent;
  const op = () => parseFloat(document.getElementById('tunNote').style.opacity);
  for (let i = 0; i < 8; i++) step();                    // loud 440Hz sine
  const loud = { note: note(), op: op() };
  signal = false;
  for (let i = 0; i < 8; i++) step();                    // signal stops
  const fading = { note: note(), op: op() };
  for (let i = 0; i < 250; i++) step();                  // fade completes (~160 frames @0.985)
  const cleared = { note: note(), op: op() };
  micAnalyser = null; micBuf = null;                     // restore
  return { loud, fading, cleared };
});
tunerFade.loud && tunerFade.loud.note.startsWith('A') && tunerFade.loud.op > 0.8
  ? ok(`tuner shows A4 at high opacity while the note is loud (${tunerFade.loud.op})`)
  : bad('tuner loud state: ' + JSON.stringify(tunerFade));
tunerFade.fading && tunerFade.fading.note.startsWith('A') && tunerFade.fading.op < tunerFade.loud.op
  ? ok(`tuner holds the last note and fades when the signal stops (${tunerFade.loud.op}→${tunerFade.fading.op})`)
  : bad('tuner fade state: ' + JSON.stringify(tunerFade));
tunerFade.cleared && tunerFade.cleared.note.startsWith('--') && Math.abs(tunerFade.cleared.op - 0.55) < 0.01
  ? ok('tuner clears to the dim idle display only after the fade completes')
  : bad('tuner cleared state: ' + JSON.stringify(tunerFade));

// sensitivity: a quiet 440Hz sine (rms ≈ 0.0057, below the old 0.008 gate)
// now registers; pseudo-random noise at a similar level still rejects.
const tunerSens = await page.evaluate(() => {
  if (!ensureCtx()) return { err: 'no ctx' };
  const n = 8192, sr = ctx.sampleRate;
  const quiet = new Float32Array(n);
  const w = 2 * Math.PI * 440 / sr;
  for (let i = 0; i < n; i++) quiet[i] = Math.sin(i * w) * 0.008;
  let seed = 42;                                          // seeded LCG noise, rms ≈ 0.01
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = (rand() * 2 - 1) * 0.017;
  return { quietHz: detectPitch(quiet, sr), noiseHz: detectPitch(noise, sr) };
});
tunerSens.quietHz > 0 && Math.abs(tunerSens.quietHz - 440) < 5
  ? ok(`tuner picks up a quiet note below the old gate (${tunerSens.quietHz.toFixed(1)} Hz ≈ 440)`)
  : bad('quiet-note sensitivity: ' + JSON.stringify(tunerSens));
tunerSens.noiseHz === -1
  ? ok('tuner confidence guard still rejects noise at the same level (no false notes)')
  : bad('noise leaked through as a pitch: ' + tunerSens.noiseHz);

// --- 🎙 push-to-talk voice search -----------------------------------------------
const pttHold = await page.evaluate(async () => {
  window.SpeechRecognition = function () {
    window.__pttInst = this;
    this.start = () => { window.__pttStarted = true; };
    this.stop = () => { window.__pttStopped = true; if (this.onend) this.onend(); };
  };
  window.__origSearch = doYtSearch;
  doYtSearch = () => { window.__searched = document.getElementById('ytQuery').value; };
  const btn = document.getElementById('ytPttBtn');
  btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }));
  const litWhileHeld = btn.classList.contains('lit');
  const listening = document.getElementById('ytQuery').placeholder.includes('Listening');
  window.__pttInst.onresult({ resultIndex: 0,
    results: [Object.assign([{ transcript: 'wonderwall oasis' }], { isFinal: true })] });
  btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  await new Promise(r => setTimeout(r, 20));
  return { started: !!window.__pttStarted, litWhileHeld, listening,
           query: document.getElementById('ytQuery').value,
           searched: window.__searched,
           litAfter: btn.classList.contains('lit'),
           placeholderRestored: document.getElementById('ytQuery').placeholder.includes('Search YouTube') };
});
pttHold.started && pttHold.litWhileHeld && pttHold.listening
  ? ok('🎙 hold starts voice recognition with a Listening… placeholder')
  : bad('ptt hold: ' + JSON.stringify(pttHold));
pttHold.query === 'wonderwall oasis' && pttHold.searched === 'wonderwall oasis'
  && !pttHold.litAfter && pttHold.placeholderRestored
  ? ok('🎙 release fills the query with the transcript and fires the search')
  : bad('ptt release: ' + JSON.stringify(pttHold));

// bound hardware key drives the same hold-to-talk (Bluetooth pedals/keyboards)
const pttKeyTest = await page.evaluate(async () => {
  localStorage.setItem('cfy_ptt', 'KeyV');
  window.__pttStarted = false; window.__pttStopped = false; window.__searched = null;
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
  const started = window.__pttStarted;
  window.__pttInst.onresult({ resultIndex: 0,
    results: [Object.assign([{ transcript: 'hallelujah' }], { isFinal: true })] });
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV' }));
  await new Promise(r => setTimeout(r, 20));
  return { started, stopped: window.__pttStopped, searched: window.__searched };
});
pttKeyTest.started && pttKeyTest.stopped && pttKeyTest.searched === 'hallelujah'
  ? ok('bound key (KeyV) holds-to-talk and searches on release')
  : bad('ptt key binding: ' + JSON.stringify(pttKeyTest));

// settings: rebinding captures the next key press
const pttRebind = await page.evaluate(() => {
  document.getElementById('stPttBtn').click();
  const capturing = document.getElementById('stPttBtn').textContent.includes('Press any key');
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9' }));
  const bound = localStorage.getItem('cfy_ptt');
  const label = document.getElementById('stPttBtn').textContent;
  document.getElementById('stPttClr').click();
  const cleared = !localStorage.getItem('cfy_ptt');
  delete window.SpeechRecognition; doYtSearch = window.__origSearch;
  return { capturing, bound, label, cleared };
});
pttRebind.capturing && pttRebind.bound === 'F9' && pttRebind.label === 'F9' && pttRebind.cleared
  ? ok('settings rebind captures the next key (F9) and ✕ clears the binding')
  : bad('ptt rebind: ' + JSON.stringify(pttRebind));

// --- mic permission priming on load ------------------------------------------
const priming = await page.evaluate(async () => {
  localStorage.removeItem('cfy_perm');
  const orig = navigator.mediaDevices.getUserMedia;
  let asked = false;
  navigator.mediaDevices.getUserMedia = () => { asked = true;
    return Promise.resolve({ getTracks: () => [{ stop() {} }] }); };
  await primePermissions();
  navigator.mediaDevices.getUserMedia = orig;
  return { asked, flagSet: !!localStorage.getItem('cfy_perm'),
           status: document.getElementById('statusTxt').textContent };
});
priming.asked && priming.flagSet && priming.status.includes('MIC READY')
  ? ok('permission priming asks for the mic once and reports readiness')
  : bad('priming: ' + JSON.stringify(priming));

// --- settings: grabber URL round-trip (phone tunnel setup) --------------------
const grabSettings = await page.evaluate(() => {
  settingsOpen(true);
  document.getElementById('stGrabIn').value = 'https://my-tunnel.trycloudflare.com/';
  document.getElementById('stGrabSave').click();
  const saved = localStorage.getItem('cfy_grab');
  const base1 = grabBase();
  document.getElementById('stGrabIn').value = '';
  document.getElementById('stGrabSave').click();
  const cleared = localStorage.getItem('cfy_grab');
  const base2 = grabBase();
  settingsOpen(false);
  return { saved, base1, cleared, base2 };
});
grabSettings.saved === 'https://my-tunnel.trycloudflare.com' && grabSettings.base1 === grabSettings.saved
  && grabSettings.cleared === null && grabSettings.base2.includes('127.0.0.1:8934')
  ? ok('settings grabber URL saves (slash-trimmed), and clearing falls back to the desktop default')
  : bad('grabber settings: ' + JSON.stringify(grabSettings));

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
