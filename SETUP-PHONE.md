# Phone setup

There isn't any.

Install the app (Share → **Add to Home Screen** at
[unorthabox.github.io/chordify](https://unorthabox.github.io/chordify/)), make sure
the phone is on the tailnet (Tailscale app → toggle on), and tap **⚙ Process Song**.
The analysis server at `https://thing3.tail8931ed.ts.net` does the audio fetching —
no shortcuts, no a-Shell, no on-phone yt-dlp.

If the server URL ever changes, set it once in **⚙ Settings → Audio server URL**.

The old a-Shell + Shortcuts setup this file used to describe was retired in July
2026 when the analysis server (see [`server/README.md`](server/README.md)) replaced
it; the write-up lives on in git history if it's ever needed again.
