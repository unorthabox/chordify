# Chordify

Chord charts from any YouTube video, in one tap.

Search a song → attach the video → tap **⚙ Process Song**. The app pulls the audio,
detects the chords, tempo and key, syncs the chart to the video, and fetches the
lyrics. Then you play along: scrolling chord grid, fretboard diagrams, transpose,
capo, loops, a tuner and a metronome.

**Live at [unorthabox.github.io/chordify](https://unorthabox.github.io/chordify/)** —
add it to your iPhone home screen and it works offline. Devices **on the
tailnet** can skip Pages entirely: the analysis server serves the app itself at
`https://thing3.tail8931ed.ts.net` — one link, same origin as the audio server,
zero settings.

No account. No API key. No build step. The one moving part is a home
analysis server (see [`server/`](server/README.md)) that fetches audio — and soon
separates stems and runs ML chord detection — reachable from every device over
Tailscale HTTPS.

---

## What it is

One `index.html` — all the HTML, CSS and JavaScript inline — plus a service worker,
a manifest and some icons. Zero runtime dependencies. Deploying is `git push`.

The chord detection runs **in the browser**, on your phone: a hand-written FFT feeds
a log-frequency spectrogram, harmonic peeling strips each note's overtones, and 84
chord templates are matched against beat-synchronous chroma and decoded with Viterbi.
It reads major, minor, 7th, m7, maj7, sus2 and sus4 chords, and finds the tempo, the
key and the offset that syncs the chart to the video.

## Getting the audio

Chord detection needs the song's raw audio, and **a browser cannot pull that off
YouTube** — no CORS, and the streams are ciphered. The
**[analysis server](server/README.md)** does it instead: an always-on FastAPI
service on the home GPU box, reached over Tailscale HTTPS
(`https://thing3.tail8931ed.ts.net`), so the same one-tap flow works on the
iPhone, the iPad and any desktop. ⚙ Process Song asks the server for the audio,
charts it, and that's the whole flow.

If no server answers (off the tailnet, server down), the app falls back to a
plain file picker: pick any m4a/mp3/wav of the song and it charts that instead.
⚙ Settings → *Audio server URL* overrides the default if the server ever moves.

History note: before the server existed, the iPhone downloaded audio *itself*
via an a-Shell + Shortcuts contraption (see git history for `SETUP-PHONE.md`).
The server retired all of it — iOS Safari blocking HTTPS→`http://127.0.0.1`
fetches ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)) is
why the server must be remote HTTPS rather than something running on the phone.

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
npm test                 # the four default suites
npm run test:detect      # just the chord-detection accuracy harness
npm run test:ios         # opt-in: the phone path, in Safari's engine
```

| suite | what it proves |
|---|---|
| `pwa` | the shell precaches, and the app boots **with the browser offline** |
| `update` | a new `index.html` reaches an already-installed app |
| `feature` | ~70 assertions over the real UI — needs network (it hits live Piped mirrors) |
| `detect` | chord-detection **accuracy**, against synthesized songs with known chords |
| `ios` | the whole phone flow, in **WebKit** — opt-in, see below |

### The iOS suite

WebKit is the engine Safari uses, and the only one iOS allows — so running the app
there exercises the same code the iPhone runs. `ios-test.mjs` boots the app on an
iPhone UA, proves the service worker installs, and then runs the one check that
actually decides whether the phone works — **`decodeAudioData` on a real yt-dlp
m4a** (the server streams yt-dlp output as-is, so the phone gets a DASH container).
That is the narrowest part of the whole design, and no amount of UI testing would
have told us about it.

It's opt-in because it needs two things a clean checkout doesn't have:

```bash
npx playwright install webkit          # on Linux also: npx playwright install-deps webkit
mkdir -p fixtures && yt-dlp -f 'bestaudio[ext=m4a]/bestaudio' \
  -o 'fixtures/cfy-%(id)s.m4a' 'https://youtube.com/watch?v=<id>'
npm run test:ios
```

Caveat: Playwright's **Windows** WebKit build ships without Web Audio, so the
decode check runs on Linux WebKit only (it skips loudly elsewhere) — the real
iPhone is the source of truth for the decode path.

`fixtures/` is gitignored; the suite finds any `.m4a` in there (or takes `M4A=`), and
skips the decode checks loudly if there isn't one. Result on a real 3½-minute track:
WebKit decodes it in ~0.8s and the full chart lands in ~2.4s, so a phone (2–4× slower)
is comfortable.

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
- **Only YouTube (and the analysis server) need the network.** Search, thumbnails and
  the iframe player are all cross-origin; the service worker passes them straight
  through and never caches them. Offline they fail and the app degrades. Playback of a
  chart, transpose, capo, the tuner and export all work with no network at all.
- **YouTube's download stack churns.** When Process Song stops fetching audio, the fix
  is almost always just updating yt-dlp on the server — which happens automatically on
  every service start (`uv tool upgrade yt-dlp` in `server/start.ps1`).
