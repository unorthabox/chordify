/* Chord-detection accuracy harness.
 *
 * analyzeBuffer() is a pure function of an AudioBuffer — it touches no ctx, no st,
 * no globals — so we can render known progressions with OfflineAudioContext and
 * measure what comes back, with zero changes to index.html.
 *
 * Four traps this deliberately avoids:
 *
 *  1. It does NOT reuse the app's padVoice(). That calls simpl(), which collapses
 *     Am7 -> Am *before rendering*. The test would triumphantly prove the detector
 *     recovers Am from an Am. The renderer below is self-contained.
 *  2. The synth's harmonic model is never the detector's harmonic model. If we
 *     rendered a geometric partial decay and the detector peeled a geometric comb,
 *     suppression would be perfect and the score fiction. Timbres here have
 *     non-geometric, formant-dipped partials and vary across songs.
 *  3. The noise is seeded. Math.random() would make this flake.
 *  4. dev / held-out split. Tuning weights on the songs you report on is cheating.
 *
 * The honest limitation: this is synthetic. It catches regressions and gross
 * failures reliably; it will NOT tell you true real-world accuracy on records with
 * vocals, distortion and reverb. If the phone disagrees with these numbers, believe
 * the phone.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8935/';
const BASELINE = 'detect-baseline.json';
const WRITE_BASELINE = process.argv.includes('--save-baseline');

const fail = [];
const ok  = (m) => console.log('  \x1b[32mPASS\x1b[0m  ' + m);
const bad = (m) => { fail.push(m); console.log('  \x1b[31mFAIL\x1b[0m  ' + m); };

/* ── corpus ────────────────────────────────────────────────────────────────────
   Each song: 8 bars, one chord per bar unless `perBar` says otherwise, strummed on
   every beat so the onset envelope has something at beat rate to lock a tempo to.
   `split` keeps hyperparameter tuning honest.                                   */
const CORPUS = [
  // --- the bread and butter: pure triads. These must not regress, ever. --------
  { name: 'I-V-vi-IV in C',        split: 'dev',  bpm: 120, timbre: 'guitar',
    prog: ['C','G','Am','F','C','G','Am','F'] },
  { name: 'I-V-vi-IV in G',        split: 'held', bpm: 108, timbre: 'piano',
    prog: ['G','D','Em','C','G','D','Em','C'] },
  { name: 'I-V-vi-IV in E',        split: 'held', bpm: 132, timbre: 'guitar',
    prog: ['E','B','C#m','A','E','B','C#m','A'] },
  { name: 'i-VI-III-VII in Am',    split: 'dev',  bpm: 96,  timbre: 'piano',
    prog: ['Am','F','C','G','Am','F','C','G'] },

  // --- THE ANTI-HALLUCINATION GATE --------------------------------------------
  // Pure triads through a harmonically rich, sawtooth-like voice. The root's 5th
  // partial IS a major third and its 7th partial IS a minor seventh, so without
  // harmonic suppression this comes back full of 7ths that were never played.
  // Over-extension here is a hard failure.
  { name: 'pure triads, rich saw',  split: 'dev',  bpm: 120, timbre: 'saw', gate: 'noExtensions',
    prog: ['C','F','G','C','Am','Dm','G','C'] },
  { name: 'pure triads, saw, in D', split: 'held', bpm: 100, timbre: 'saw', gate: 'noExtensions',
    prog: ['D','G','A','D','Bm','Em','A','D'] },

  // --- the target case: sevenths ----------------------------------------------
  { name: 'ii-V-I jazz in C',      split: 'dev',  bpm: 120, timbre: 'piano',
    prog: ['Dm7','G7','Cmaj7','Cmaj7','Dm7','G7','Cmaj7','Cmaj7'] },
  { name: 'ii-V-I jazz in F',      split: 'held', bpm: 92,  timbre: 'ep',
    prog: ['Gm7','C7','Fmaj7','Fmaj7','Gm7','C7','Fmaj7','Fmaj7'] },
  { name: 'blues in A (dom 7ths)', split: 'dev',  bpm: 104, timbre: 'guitar',
    prog: ['A7','A7','D7','D7','A7','E7','D7','A7'] },
  { name: 'minor 7th vamp',        split: 'held', bpm: 110, timbre: 'ep',
    prog: ['Am7','Am7','Dm7','Dm7','Am7','Am7','Em7','Em7'] },
  { name: 'maj7 vs dom7 in G',     split: 'dev',  bpm: 88,  timbre: 'piano',
    prog: ['Gmaj7','G7','Cmaj7','C7','Gmaj7','G7','Cmaj7','Cmaj7'] },

  // --- sus: only decidable with a bass note ------------------------------------
  { name: 'sus resolution in D',   split: 'dev',  bpm: 116, timbre: 'guitar',
    prog: ['Dsus4','D','Dsus2','D','Asus4','A','Dsus4','D'] },
  { name: 'sus4 pop in A',         split: 'held', bpm: 124, timbre: 'guitar',
    prog: ['A','Asus4','A','Asus4','E','Esus4','E','E'] },

  // --- inversions: the bass is NOT the root. Must still report C, not Em. -------
  { name: 'inversions (C/E, G/B)', split: 'dev',  bpm: 100, timbre: 'piano',
    prog: ['C','C','G','G','Am','Am','F','F'],
    bass: ['E','C','B','G','C','A','A','F'] },

  // --- tuning: a YouTube rip or a down-tuned band. Today this is catastrophic:
  //     energy gets round()ed into the WRONG pitch class and the song is garbage.
  { name: 'detuned -40 cents',     split: 'dev',  bpm: 120, timbre: 'guitar', cents: -40,
    prog: ['C','G','Am','F','C','G','Am','F'] },
  { name: 'detuned +30 cents',     split: 'held', bpm: 112, timbre: 'piano', cents: +30,
    prog: ['G','D','Em','C','G','D','Em','C'] },

  // --- tempo extremes -----------------------------------------------------------
  { name: 'slow, 60 bpm',          split: 'held', bpm: 62,  timbre: 'ep',
    prog: ['Fmaj7','Fmaj7','Em7','Em7','Dm7','Dm7','Cmaj7','Cmaj7'] },
  { name: 'fast, 170 bpm',         split: 'dev',  bpm: 170, timbre: 'guitar',
    prog: ['E','A','B','E','C#m','A','B','E'] },
  { name: 'two chords per bar',    split: 'held', bpm: 120, timbre: 'piano', perBar: 2,
    prog: ['C','Am','F','G','C','Am','Dm7','G7'] },

  // --- mix variants: the bass term must help when there is a bass, and must not
  //     wreck anything when there isn't.
  { name: 'bass-heavy mix',        split: 'dev',  bpm: 100, timbre: 'guitar', bassGain: 2.2,
    prog: ['C','G','Am','F','Dm7','G7','C','C'] },
  { name: 'no bass at all',        split: 'held', bpm: 100, timbre: 'piano', bassGain: 0,
    prog: ['C','G','Am','F','Dm7','G7','C','C'] },

  // --- distractors ---------------------------------------------------------------
  { name: 'with a drum kit',       split: 'dev',  bpm: 128, timbre: 'guitar', drums: true,
    prog: ['Am','F','C','G','Am','F','C','G'] },
  { name: 'odd-harmonic voice',    split: 'held', bpm: 118, timbre: 'clarinet',
    prog: ['C','Em','F','G','Am','Em','F','G'] },
  { name: 'noisy / hissy source',  split: 'dev',  bpm: 96,  timbre: 'guitar', noise: 0.02,
    prog: ['D','A','Bm','G','D','A','Bm','G'] },
];

/* ── the renderer + scorer, evaluated in the page ───────────────────────────── */
const measure = async (page, song) => page.evaluate(async (song) => {
  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const QUAL  = { '':[0,4,7], 'm':[0,3,7], '7':[0,4,7,10], 'm7':[0,3,7,10],
                  'maj7':[0,4,7,11], 'sus4':[0,5,7], 'sus2':[0,2,7] };
  const parse = (sym) => {
    const m = /^([A-G]#?)(.*)$/.exec(sym);
    if (!m) return null;
    return { pc: NOTES.indexOf(m[1]), q: m[2] };
  };

  // seeded PRNG — Math.random() would make this flake
  let seed = 0x9e3779b9;
  for (const c of song.name) seed = (seed ^ c.charCodeAt(0)) * 0x85ebca6b >>> 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
                      return ((seed >>> 0) / 4294967296); };

  /* Timbres: real partial amplitudes, deliberately NOT geometric, with a formant
     dip, so no harmonic-suppression model can trivially invert them. */
  const TIMBRE = {
    guitar:   [0, 1.00, 0.52, 0.38, 0.14, 0.22, 0.09, 0.11, 0.04, 0.06, 0.03],
    piano:    [0, 1.00, 0.44, 0.26, 0.19, 0.07, 0.10, 0.05, 0.03, 0.04, 0.02],
    ep:       [0, 1.00, 0.30, 0.12, 0.20, 0.05, 0.03, 0.06, 0.02, 0.01, 0.01],
    saw:      [0, 1.00, 0.60, 0.42, 0.33, 0.27, 0.22, 0.19, 0.16, 0.14, 0.12], // rich: 5th partial = maj 3rd, 7th = min 7th
    clarinet: [0, 1.00, 0.04, 0.55, 0.03, 0.32, 0.02, 0.20, 0.02, 0.12, 0.01], // odd-harmonic
  };
  const waveOf = (ctx, name) => {
    const amps = TIMBRE[name] || TIMBRE.guitar;
    const real = new Float32Array(amps.length), imag = new Float32Array(amps.length);
    for (let i = 0; i < amps.length; i++) imag[i] = amps[i];
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  };

  const beat  = 60 / song.bpm;
  const perBar = song.perBar || 1;
  const barSec = beat * 4;
  const chordSec = barSec / perBar;
  const dur = song.prog.length * chordSec + 0.5;
  const SR = 44100;
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
  const cents = song.cents || 0;
  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200);

  const master = ctx.createGain(); master.gain.value = 0.25; master.connect(ctx.destination);
  const wave = waveOf(ctx, song.timbre);

  const pluck = (midi, t, len, gain, w) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.setPeriodicWave(w || wave);
    o.frequency.value = hz(midi);
    o.detune.value = (rnd() - 0.5) * 9;                 // real players are not in perfect tune
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);    // attack
    g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + len + 0.02);
  };

  const truth = [];
  for (let i = 0; i < song.prog.length; i++) {
    const sym = song.prog[i], c = parse(sym);
    const t0 = i * chordSec;
    truth.push([sym, t0, t0 + chordSec]);

    // bass: root unless the song specifies an inversion
    const bassSym = song.bass ? song.bass[i] : NOTES[c.pc];
    const bassPc = parse(bassSym).pc;
    const bassGain = song.bassGain === undefined ? 1 : song.bassGain;
    if (bassGain > 0) {
      // MIDI 36 = C2 = 65 Hz. Stays inside the 55-220 Hz band the bass chroma can see.
      pluck(36 + bassPc, t0, chordSec * 0.95, 0.5 * bassGain);
    }

    // re-strum every beat: gives the onset envelope something at beat rate, which
    // is what estimateTempo() locks to. A pad held for a whole bar gives it nothing.
    for (let b = 0; b < 4 / perBar; b++) {
      const t = t0 + b * beat + rnd() * 0.006;
      const len = beat * 1.6;
      c.q === undefined && (c.q = '');
      const ivs = QUAL[c.q];
      // MIDI 48 and 72 are C, so `48 + pitchClass` really is that pitch class.
      // (52 would be E — that silently transposes every chord up a major third
      // while the bass stays put, and the whole harness becomes a liar.)
      ivs.forEach((iv, n) => {
        const midi = 48 + ((c.pc + iv) % 12) + (n >= 2 ? 12 : 0);  // voice across 2 octaves
        pluck(midi, t, len, 0.34 / Math.sqrt(ivs.length));
      });
      // a top voice an octave up, quieter — real arrangements are not one register
      pluck(72 + ((c.pc + ivs[ivs.length - 1]) % 12), t, len * 0.7, 0.10);
    }

    if (song.drums) {
      for (let b = 0; b < 4; b++) {
        const t = t0 + b * beat;
        if (b % 2 === 0) {                                  // kick
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.setValueAtTime(110, t);
          o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
          g.gain.setValueAtTime(0.7, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
          o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.16);
        } else {                                            // snare
          const n = ctx.createBufferSource(), nb = ctx.createBuffer(1, SR * 0.12, SR);
          const d = nb.getChannelData(0);
          for (let j = 0; j < d.length; j++) d[j] = (rnd() * 2 - 1) * Math.pow(1 - j / d.length, 3);
          n.buffer = nb;
          const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
          const g = ctx.createGain(); g.gain.value = 0.35;
          n.connect(hp); hp.connect(g); g.connect(master); n.start(t);
        }
      }
    }
  }

  if (song.noise) {
    const n = ctx.createBufferSource(), nb = ctx.createBuffer(1, Math.ceil(SR * dur), SR);
    const d = nb.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = (rnd() * 2 - 1) * song.noise;
    n.buffer = nb; n.connect(master); n.start(0);
  }

  const buf = await ctx.startRendering();

  const t0 = performance.now();
  const res = await window.analyzeBuffer(buf, () => {});
  const ms = performance.now() - t0;

  // detector returns [[sym, durSec], ...] — make it a timeline
  const got = []; let acc = 0;
  for (const [sym, d] of res.chords) { got.push([sym, acc, acc + d]); acc += d; }

  // ── scoring on a 10 ms grid ────────────────────────────────────────────────
  const at = (tl, t) => { for (const [s, a, b] of tl) if (t >= a && t < b) return s; return null; };
  const triad = (sym) => {                       // root + maj/min only
    const c = parse(sym); if (!c) return null;
    const minor = (c.q === 'm' || c.q === 'm7');
    return c.pc + (minor ? ':m' : ':M');
  };
  const isExt = (sym) => { const c = parse(sym); return !!c && c.q !== '' && c.q !== 'm'; };

  let n = 0, exact = 0, triadHit = 0, rootHit = 0;
  let gtPlain = 0, overExt = 0, gtExt = 0, missExt = 0;
  const confusion = {};
  for (let t = 0.05; t < song.prog.length * chordSec; t += 0.01) {
    const g = at(truth, t), p = at(got, t);
    if (!g) continue;
    n++;
    const gc = parse(g), pc_ = p && parse(p);
    if (p === g) exact++;
    if (pc_ && triad(g) === triad(p)) triadHit++;
    if (pc_ && gc.pc === pc_.pc) rootHit++;
    if (!isExt(g)) { gtPlain++; if (p && isExt(p)) overExt++; }
    else           { gtExt++;   if (p && !isExt(p)) missExt++; }
    const k = (gc.q || 'maj') + ' -> ' + (pc_ ? (pc_.q || 'maj') : 'N.C.');
    confusion[k] = (confusion[k] || 0) + 1;
  }
  const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : null;
  return {
    name: song.name, split: song.split, gate: song.gate || null, ms: Math.round(ms),
    bpmTrue: song.bpm, bpmGot: res.bpm, key: res.key, nSeg: res.chords.length,
    csrExact: pct(exact, n), csrTriad: pct(triadHit, n), csrRoot: pct(rootHit, n),
    overExt: pct(overExt, gtPlain), missExt: pct(missExt, gtExt),
    confusion,
  };
}, song);

/* ── run ───────────────────────────────────────────────────────────────────── */
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('#app');

const hasFn = await page.evaluate(() => typeof window.analyzeBuffer === 'function');
if (!hasFn) { bad('analyzeBuffer is not reachable from the page — harness cannot run'); process.exit(1); }

const rows = [];
for (const song of CORPUS) {
  const r = await measure(page, song);
  rows.push(r);
  const bpmOff = r.bpmGot ? Math.abs(r.bpmGot - r.bpmTrue) : null;
  // half/double time is a legitimate read of the same groove, not an error
  const bpmOk = r.bpmGot && [1, 2, 0.5].some(k => Math.abs(r.bpmGot - r.bpmTrue * k) < r.bpmTrue * 0.06);
  console.log(
    `  ${r.split === 'dev' ? 'dev ' : 'held'}  ${r.name.padEnd(24)}` +
    `  triad ${String(r.csrTriad).padStart(5)}%  7th ${String(r.csrExact).padStart(5)}%` +
    `  root ${String(r.csrRoot).padStart(5)}%  over+ ${String(r.overExt).padStart(5)}%` +
    `  bpm ${r.bpmGot ? Math.round(r.bpmGot) : '—'}${bpmOk ? '' : '!'}  ${r.ms}ms`);
}
await browser.close();

const mean = (f, set = rows) => {
  const v = set.map(f).filter(x => x !== null && x !== undefined);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
};
const held = rows.filter(r => r.split === 'held');
const summary = {
  csrTriad: mean(r => r.csrTriad), csrExact: mean(r => r.csrExact),
  csrRoot: mean(r => r.csrRoot), overExt: mean(r => r.overExt), missExt: mean(r => r.missExt),
  heldTriad: mean(r => r.csrTriad, held), heldExact: mean(r => r.csrExact, held),
  msTotal: rows.reduce((a, r) => a + r.ms, 0),
};

console.log('\n  ── overall ───────────────────────────────────────────────');
console.log(`  CSR-triad      ${summary.csrTriad}%   (held-out ${summary.heldTriad}%)`);
console.log(`  CSR-7th        ${summary.csrExact}%   (held-out ${summary.heldExact}%)`);
console.log(`  root           ${summary.csrRoot}%`);
console.log(`  over-extension ${summary.overExt}%   <- false 7ths on plain triads`);
console.log(`  missed-ext     ${summary.missExt}%`);
console.log(`  analysis time  ${summary.msTotal}ms total`);

// aggregate quality confusion, worst first — a scalar says you regressed, this says why
const conf = {};
for (const r of rows) for (const [k, v] of Object.entries(r.confusion)) conf[k] = (conf[k] || 0) + v;
const wrong = Object.entries(conf).filter(([k]) => k.split(' -> ')[0] !== k.split(' -> ')[1])
                    .sort((a, b) => b[1] - a[1]).slice(0, 8);
if (wrong.length) {
  console.log('\n  top quality confusions (ground truth -> detected):');
  for (const [k, v] of wrong) console.log(`    ${k.padEnd(22)} ${v}`);
}

// ── hard gates ───────────────────────────────────────────────────────────────
console.log('');
for (const r of rows.filter(r => r.gate === 'noExtensions')) {
  r.overExt !== null && r.overExt <= 15
    ? ok(`anti-hallucination: "${r.name}" stays ${r.overExt}% over-extended (<=15%)`)
    : bad(`anti-hallucination: "${r.name}" is ${r.overExt}% over-extended — the detector is ` +
          `inventing 7ths that were never played. Harmonic suppression is not working.`);
}

if (existsSync(BASELINE) && !WRITE_BASELINE) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const drop = base.summary.csrTriad - summary.csrTriad;
  drop <= 1.0
    ? ok(`no triad regression: ${base.summary.csrTriad}% -> ${summary.csrTriad}% (baseline ${base.label})`)
    : bad(`TRIAD REGRESSION: ${base.summary.csrTriad}% -> ${summary.csrTriad}% (-${drop.toFixed(1)}pt). ` +
          `Triad accuracy is the floor; it must not fall to buy sevenths.`);
  const gain = summary.csrExact - base.summary.csrExact;
  console.log(`  \x1b[2mnote\x1b[0m  CSR-7th ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}pt vs baseline ` +
              `(${base.summary.csrExact}% -> ${summary.csrExact}%)`);
} else {
  console.log('  \x1b[2mno baseline on disk — run with --save-baseline to record one\x1b[0m');
}

if (WRITE_BASELINE) {
  const label = process.env.LABEL || 'unlabelled';
  writeFileSync(BASELINE, JSON.stringify({ label, summary, rows }, null, 2));
  console.log(`\n  baseline written to ${BASELINE} (label: ${label})`);
}

console.log('\npage errors: ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : 'none'));
console.log(fail.length ? `\n${fail.length} FAILURE(S)` : '\nDETECTION CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
