# Chordify analysis server

FastAPI backend on **thing3** (this Windows PC). Supersedes `grab-server.mjs` on
port 8934: same `/health` + `/grab?v=` contract the v1 client already speaks,
plus the v2 pipeline — yt-dlp grab → GPU stem separation (`htdemucs_ft` via
audio-separator) → AAC/m4a stems + `analysis.json`, cached forever per video id.

## Endpoints

| route | auth | purpose |
|---|---|---|
| `GET /health` | none | `{ok, ytdlp, v2:true, stems:true}` — v1 reads `.ok`, v2 clients feature-detect |
| `GET /grab?v=<id>` | none (v1 compat) | stream bestaudio m4a; serves the cached source when analyzed |
| `POST /analyze {v}` | key | queue the pipeline → `{job, cached}` |
| `GET /job/{id}` | key | `{status: queued\|grabbing\|separating\|transcoding\|done\|error, progress, gpu}` |
| `GET /song/{v}/analysis.json` | key | stem list + metadata (chords/beats arrive in Phase 3) |
| `GET /song/{v}/stem/{name}.m4a` | key | vocals/drums/bass/other; supports Range |

Auth = `X-Chordify-Key` header or `?k=`. The key is auto-generated into
`server/.env` on first start. Require it on `/grab` too once the Phase-2 client
sends it (until then `/grab` stays open so the unmodified v1 phone flow works
over the funnel).

## Running

```powershell
.\start.ps1        # upgrades yt-dlp, then uvicorn on 127.0.0.1:8934, logs to logs\server.log
```

Environment overrides: `CHORDIFY_DATA` (default `server/data`), `CHORDIFY_MODELS`
(default `data/models` — 321MB of htdemucs_ft weights live there), `CHORDIFY_KEY`.

Venv is uv-managed — see `requirements.txt` for the exact recreate steps and the
**torch cu126 pin trap** (PyPI torch on Windows is CPU-only; installing
audio-separator afterwards silently downgrades CUDA torch).

## Service-ification

A Task Scheduler at-logon task (`ChordifyAnalysisServer`) exists, but it's
"interactive only" — it will NOT start while the box sits at the lock screen.
For a real boot-time service, run **once, in an elevated PowerShell**:

```powershell
winget install NSSM.NSSM
nssm install ChordifyServer powershell.exe "-NoProfile -ExecutionPolicy Bypass -File C:\Users\Colto\chordify\server\start.ps1"
nssm set ChordifyServer ObjectName ".\Colto" <password>   # run as Colto so uv/yt-dlp/model paths resolve
nssm start ChordifyServer
# then remove the interim task:
Unregister-ScheduledTask -TaskName ChordifyAnalysisServer -Confirm:$false
```

## Exposure to the phone

`tailscale funnel --bg http://127.0.0.1:8934` → public `https://<machine>.<tailnet>.ts.net`.
Set that URL (and later the key) in the PWA's settings on the iPhone.

## GPU discipline

Jobs are strictly serialized; each separation runs as a subprocess with
`CUDA_VISIBLE_DEVICES` pinned to whichever card has the most free VRAM
(pynvml), so VRAM provably returns to the LLMs on exit. OOM → retry other
card → CPU. ~42s per 3.5-min song on the 2080 Ti.

## Tests

`npm run test:server` (repo root) — opt-in suite; boots this server on :8939
with a throwaway data dir, seeds `fixtures/*.m4a`, and runs the real pipeline
including a GPU separation. Needs the venv and a fixture.
