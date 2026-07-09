# Chordify → installable iPhone app: handoff

**Date:** 2026-07-09
**Goal:** Make Chordify a real app on the iPhone home screen that launches with the
desktop powered off, works on any wifi, and works with no wifi at all.

**Decisions already made:** iPhone (not Android). PWA hosted on a free static
HTTPS host (not an ephemeral tunnel, not a wrapped `.apk`).

---

## Where things stand

### Done — files are written, not yet verified

The app was one self-contained `index.html`. It is now four files, because a
service worker **must** be a real same-origin `.js` file (you cannot register one
from a `data:` or `blob:` URL), and a `data:` URI manifest gives `start_url`/`scope`
nothing sane to resolve against.

| File | State | Notes |
|---|---|---|
| `index.html` | **edited** | 231KB → 195KB. Icon + manifest data-URIs pulled out to files; SW registration added before `</body>` |
| `sw.js` | **new** | Offline shell. Precache + stale-while-revalidate |
| `manifest.webmanifest` | **new** | `display: standalone`, relative `start_url`/`scope` |
| `icon-180.png` | **new** | Extracted from the old `apple-touch-icon` data-URI |
| `serve.sh` | **edited** | Comments corrected — `localhost` is a secure context, so SW works there too |
| `index.html.orig` | **backup** | The original single-file version, md5 `170ceba6829612476ee4e8ed27244236`. Delete once you're happy |
| `pwa-test.mjs` | **new** | End-to-end Playwright test. **Never actually run.** |

### Not done

1. **Run the test.** This is the next thing. Nothing below is confirmed working.
2. **Deploy** to a static HTTPS host.
3. **Install** on the iPhone and confirm offline launch.

---

## Step 1 — run the end-to-end test

Playwright's Chromium is already cached at `~/.cache/ms-playwright` (chromium-1223),
but the npm package is not installed in this project. It was installed into a job
temp dir that is now gone.

```bash
cd /home/thing2/chordify
npm i playwright@1.61.1 --no-audit --no-fund     # ~2s, browser already cached

python3 -m http.server 8931 --bind 127.0.0.1 &
SRV=$!
sleep 2
node pwa-test.mjs; RC=$?
kill $SRV
exit $RC
```

`127.0.0.1` matters — it's a secure context, so the service worker will register
there. A LAN IP will not.

The test asserts, in order: index/manifest/icon/sw all serve 200 → manifest is
`standalone` → the service worker reaches `activated` → the shell is genuinely in
the Cache Storage → **then flips the browser offline, opens a fresh page, and
requires the app to boot from cache** (`#app`, `#stage`, and `window.CFY` all
present). Last check confirms a cross-origin YouTube fetch *rejects* offline
rather than hanging.

If the offline reload fails, suspect the `fetch` handler in `sw.js` — specifically
the `req.mode === 'navigate'` fallback to `./index.html`.

## Step 2 — deploy

`gh` is installed but **not logged in**. That step is interactive; run it yourself:

```
! gh auth login
```

Then:

```bash
cd /home/thing2/chordify
git init && git add -A && git commit -m "Chordify PWA"
gh repo create chordify --public --source=. --push
gh api -X POST repos/:owner/chordify/pages -f 'source[branch]=main' -f 'source[path]=/'
```

Live at `https://<user>.github.io/chordify/` after a minute or two. All paths in
the manifest and SW are relative, so the subpath is fine — it'll work unchanged if
you later move it to a root domain or to Cloudflare Pages / Netlify.

**This publishes the source publicly.** That was checked and is safe: there is no
API key in the file. The YouTube key is read from `localStorage` at runtime
(`index.html:2794`, key `cfy_ytkey`), so it never leaves the device.

If you'd rather not publish, Cloudflare Pages and Netlify both serve private repos
on a free tier.

## Step 3 — install on the iPhone

Open the URL **in Safari** (not Chrome — on iOS only Safari can install to the home
screen). Share → Add to Home Screen. Then turn on airplane mode and launch it. It
should come up fullscreen with no browser chrome.

---

## Gotchas worth knowing before you debug something that isn't broken

- **Installing gives you the tuner back.** The mic needs a secure context, which is
  why `serve.sh` had to warn about it over LAN http. Served over HTTPS, `getUserMedia`
  works — including inside an installed iOS home-screen app (that was fixed in iOS 14.3).

- **The installed app has its own storage bucket, separate from Safari.** Any songs
  you saved while testing in Safari will *not* appear in the installed app. Use the
  app's own export/import to carry them across. This will look like data loss and
  isn't.

- **Home-screen web apps are exempt from iOS's 7-day storage eviction.** A Safari
  *tab* would get its `localStorage` purged after 7 days unused; an installed app
  won't. So the song library is safe once installed, and only once installed.

- **Updates propagate on their own.** `sw.js` uses stale-while-revalidate, so a new
  `index.html` is picked up on the launch *after* an online launch. You do not need
  to bump `VERSION` for content edits — that constant only exists to force-evict the
  whole cache if something gets wedged.

- **Only YouTube needs the network.** Search, thumbnails (`i.ytimg.com`), the Piped
  fallbacks, and the iframe API are all cross-origin; the SW passes them straight
  through and never caches them. Offline they fail and the app degrades. Playback,
  transpose, capo, tuner, and export all run with no network.

- **The icon is 180×180 only.** Correct for iOS. If you ever want Android's install
  prompt, it wants a 192px and a 512px icon in the manifest — no image tooling on
  this box (no ImageMagick, no Pillow), so that needs a plan.

- **This is not a git repo yet.** `index.html.orig` is your only undo.
