# Chordify on the phone — one-time setup

Everything in Chordify already runs on your phone for free: the voice search, the
YouTube search, the chord detection, the lyrics, the playback. **One step needs
help:** a browser can't pull the raw audio off YouTube (no CORS, ciphered
streams), and Chordify needs those bytes to detect chords.

So the phone does it itself. **a-Shell** — a free terminal app — runs `yt-dlp`
right on the iPhone, and a Shortcut wires it to Chordify. No computer at home, no
cloud server, no account, no bill. The phone's own connection is also *better* at
this than a server would be: YouTube's bot-blocking mostly targets datacenter IPs,
not phones on cell/Wi-Fi.

Set this up once. After that, a new song is two taps.

---

## 1 · Install a-Shell

App Store → search **a-Shell** → install (free). Open it once so it finishes
setting itself up.

## 2 · Install the downloader

In a-Shell, paste this and hit return. It takes a minute or two.

```
pip install -U "yt-dlp[default]" yt-dlp-ejs yt-dlp-apple-webkit-jsi
```

- `yt-dlp` is the downloader.
- `yt-dlp-ejs` + `yt-dlp-apple-webkit-jsi` are what make it work **on iOS at all**.
  Since late 2025 YouTube requires solving a JavaScript challenge, and iOS won't
  let apps run a downloaded JS engine — the `apple-webkit-jsi` plugin gets around
  that by using Apple's own built-in JavaScript engine. Without it, downloads fail.

Sanity check (should print a version):

```
yt-dlp --version
```

## 3 · Build the "Chordify Grab" shortcut

Shortcuts app → **+** → name it exactly **Chordify Grab** (the app deep-links to
it by name). Add two actions, in order:

**Action 1 — a-Shell ▸ Execute Command**, with the command:

```
yt-dlp -f 'bestaudio[ext=m4a]/bestaudio' --no-playlist -o '~/Documents/cfy-%(id)s.m4a' "[Shortcut Input]"
```

(`[Shortcut Input]` is the *Shortcut Input* variable — insert it from the variable
bar, don't type it literally. Chordify passes the video's watch URL there.)

`m4a` matters: iOS Safari's audio decoder can't handle the Opus/WebM that YouTube
otherwise serves, so we ask for AAC specifically.

**Action 2 — Open URLs**, with:

```
https://unorthabox.github.io/chordify/#grabbed
```

That's what bounces you back to Chordify when the download finishes. (The exact
URL for your install is shown in the app: the grab panel's **SET IT UP** link.)

This action is a convenience, not a requirement. iOS may open it in Safari rather
than your home-screen app — if it does, just switch back to Chordify yourself; the
panel is still sitting on step 2. You can leave the action out entirely if you'd
rather always switch back by hand.

---

## Using it

1. Search a song, pick the video, tap **⚙ Process Song**.
   - If you've charted this video before, it just loads — nothing else to do.
2. Tap **1 Grab Audio**. The Shortcut runs; a-Shell comes to the front and
   downloads the song — usually 10–30 seconds. **Leave it in the foreground**; iOS
   suspends background apps and the download will stall if you switch away.
3. You land back in Chordify. Tap **2 Chart It** and pick the `cfy-<id>.m4a` file
   under **a-Shell ▸ Documents** in the file picker.
4. Chordify analyzes it (progress on the button), builds the chart, and syncs it
   to the video. Lyrics fetch alongside. Press play.

The file picker step is unavoidable: iOS Safari has no Web Share Target, so a
Shortcut can't hand a file straight to a web app. One extra tap is the price of
needing no machine anywhere.

---

## When it breaks

YouTube changes things every few months and the whole yt-dlp world scrambles.
The fixes, in the order to try them:

**Downloads suddenly fail / "unable to extract" / it hangs.**
Re-run the install line — it's a new-version problem 90% of the time:

```
pip install -U "yt-dlp[default]" yt-dlp-ejs yt-dlp-apple-webkit-jsi
```

**The YouTube app hijacks the screen mid-download** ("video unavailable").
Known quirk of the JS-challenge plugin. Tap **◀ a-Shell** at the top-left — the
download is still running and will finish.

**"Sign in to confirm you're not a bot".**
Rare on a phone, but it happens. Export your YouTube cookies and point yt-dlp at
them: in the Shortcut's command, add `--cookies ~/Documents/cookies.txt` and put a
cookies.txt (exported from a browser where you're signed into YouTube) in a-Shell's
Documents. Use a throwaway Google account if you'd rather not risk your real one —
Google can flag accounts used this way. Cookies expire every couple of weeks.

**Nothing works and you want a second opinion.**
[SW-DLT](https://github.com/net00-1/SW-DLT) is a maintained community shortcut
around the same a-Shell + yt-dlp stack. Download the m4a with it, then use
**2 Chart It** to feed the file to Chordify — the app doesn't care which shortcut
produced the file.

---

## The desktop shortcut (optional)

On a computer you can skip all of this: run `node grab-server.mjs` and leave it.
Chordify finds it at `127.0.0.1:8934` automatically and **⚙ Process Song** becomes
one tap — it downloads and charts with no file picking. That's a convenience for
desktop only; the phone can't reach a server on your computer without you keeping
that computer online, which is exactly what this setup exists to avoid.
