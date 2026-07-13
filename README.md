# Chordify

Chord charts from any YouTube video, built on the phone, for free.

Search a song → attach the video → tap **⚙ Process Song**. The app pulls the audio,
detects the chords, tempo and key, syncs the chart to the video, and fetches the
lyrics. Then you play along: scrolling chord grid, fretboard diagrams, transpose,
capo, loops, a tuner and a metronome.

**Live at [unorthabox.github.io/chordify](https://unorthabox.github.io/chordify/)** —
add it to your iPhone home screen and it works offline.

No server. No account. No API key. No build step. Nothing to pay for.

---

## What it is

One `index.html` — all the HTML, CSS and JavaScript inline — plus a service worker,
a manifest and some icons. Zero runtime dependencies. Deploying is `git push`.

The chord detection runs **in the browser**, on your phone: a hand-written FFT feeds
a log-frequency spectrogram, harmonic peeling strips each note's overtones, and 84
chord templates are matched against beat-synchronous chroma and decoded with Viterbi.
It reads major, minor, 7th, m7, maj7, sus2 and sus4 chords, and finds the tempo, the
key and the offset that syncs the chart to the video.

## The one awkward bit: getting the audio

Chord detection needs the song's raw audio, and **a browser cannot pull that off
YouTube** — no CORS, and the streams are ciphered. So the audio has to come from
somewhere else. There are two ways in.

### On the iPhone (no computer involved)

The phone downloads it itself. [a-Shell](https://apps.apple.com/app/a-shell/id1473805438)
(free) runs `yt-dlp` on the phone; a Shortcut wires it up. Setup is a one-time thing
and it's written up in **[SETUP-PHONE.md](SETUP-PHONE.md)** (also mirrored in the app,
under the grab panel's *SET IT UP* link).

Then ⚙ Process Song opens a two-step panel:

1. **Grab Audio** — hands the video to the Shortcut. a-Shell downloads the m4a and
   bounces back to the app.
2. **Chart It** — pick that file. The analyzer runs and the chart appears.

**That second tap cannot be removed**, and it's worth knowing why before you try:
iOS Safari has no Web Share Target, so a Shortcut *cannot* hand a file to a web app;
and a little server running on the phone is out too, because iOS Safari blocks HTTPS
pages from fetching `http://127.0.0.1` ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934),
open since 2017). Every other browser allows it. So: two taps.

### On a desktop (one tap)

Run the optional helper and Process Song does everything in one tap, no file picking:

```bash
node grab-server.mjs        # listens on 127.0.0.1:8934, shells out to yt-dlp
```

It's a convenience, not a requirement. Point ⚙ Settings → *Audio grabber URL* at
something else if you want to host it elsewhere.

## Running it locally

```bash
./serve.sh              # http://127.0.0.1:8000
./serve.sh --secure     # same, but through a cloudflared tunnel
```

Use `127.0.0.1`, not a LAN IP: the microphone (tuner, chord trainer) and the service
worker both need a **secure context**, and `localhost` counts as one while
`192.168.x.x` does not. That's what `--secure` is for when you want to test from a
phone on the same wifi.

## Tests

```bash
npm test                 # all four suites
npm run test:detect      # just the chord-detection accuracy harness
```

| suite | what it proves |
|---|---|
| `pwa` | the shell precaches, and the app boots **with the browser offline** |
| `update` | a new `index.html` reaches an already-installed app |
| `feature` | ~70 assertions over the real UI — needs network (it hits live Piped mirrors) |
| `detect` | chord-detection **accuracy**, against synthesized songs with known chords |

`run-tests.mjs` starts each suite's server itself, and **refuses a port it doesn't
own** — a leftover server from an earlier run will answer a readiness poll perfectly
happily while serving a stale copy of the site, and then the suites pass against code
that isn't the code you just wrote. That happened. Hence the check.

### Measuring the detector

`detect-test.mjs` renders ~24 songs with known chord progressions into an
`OfflineAudioContext` and asserts the detector recovers them. It works without
touching `index.html` because `analyzeBuffer()` is a pure function of an AudioBuffer.

Current accuracy, against the synthetic corpus:

| metric | | |
|---|---|---|
| **CSR-triad** | 92.7% | root + major/minor. The floor — it must never regress. |
| **CSR-7th** | 91.5% | root + full quality. The number the vocabulary work moved. |
| **over-extension** | 0.9% | false 7ths on chords that are plain triads. |

`detect-baseline.json` holds the reference; a run that drops triad accuracy fails.
`node tune-detect.mjs W_BASS=0,0.2` sweeps scoring weights — **on the dev split**, since
tuning on the numbers you then quote is how you fit knobs to 24 songs and learn nothing.

**This corpus is synthetic, and that is a real limitation.** It catches regressions and
gross failures reliably. It cannot tell you the true accuracy on a record with vocals,
distortion and reverb, because it has never seen one. If the phone disagrees with these
numbers, believe the phone.

## Deploying

`git push`. GitHub Pages serves `main` at `/`. Every path in the manifest and the
service worker is relative, so the `/chordify/` subpath works and would keep working
from a root domain.

Updates propagate on their own — `sw.js` is stale-while-revalidate, so a new
`index.html` is picked up on the launch *after* an online launch. You don't need to
bump `VERSION`; that constant exists only to force-evict the whole cache if something
gets wedged.

## Things that will look like bugs and aren't

- **The installed app has its own storage, separate from Safari.** Songs you saved
  while testing in a browser tab will not be in the installed app. Use export/import
  to carry them over. This looks exactly like data loss.
- **Home-screen apps are exempt from iOS's 7-day storage eviction.** A Safari *tab*
  gets its `localStorage` purged after 7 days unused; an installed app doesn't. So the
  library is durable — but only once installed.
- **Only YouTube needs the network.** Search, thumbnails and the iframe player are all
  cross-origin; the service worker passes them straight through and never caches them.
  Offline they fail and the app degrades. Playback of a chart, transpose, capo, the
  tuner and export all work with no network at all.
- **The iOS download stack churns.** `yt-dlp-apple-webkit-jsi` is what solves YouTube's
  JS challenge using Apple's built-in engine (iOS forbids shipping your own). When
  YouTube changes something, re-running the `pip install -U` line in a-Shell is almost
  always the entire fix.
