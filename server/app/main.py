"""Chordify analysis server — supersedes grab-server.mjs on port 8934.

Preserves the v1 contract (GET /health, GET /grab?v=) so the current
index.html works unmodified, and adds the v2 surface:

  POST /analyze {v}            -> {job, cached}
  GET  /job/{id}               -> {status, progress, ...}
  GET  /song/{v}/analysis.json
  GET  /song/{v}/stem/{name}.m4a

Auth: X-Chordify-Key header (or ?k=) on the v2 endpoints. /health and /grab
stay keyless for v1-client compatibility; require the key on /grab too once
the Phase-2 client sends it. The key lives in server/.env (auto-generated).

Also serves the PWA shell itself (an allowlist of files from the repo root),
so a tailnet device needs only https://thing3.…ts.net — no settings, and the
client's same-origin probe finds the server automatically.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import secrets
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse

from . import db
from .jobs import JobManager
from .pipeline.grab import FORMAT, find_ytdlp, ytdlp_version

ROOT = Path(__file__).resolve().parent.parent  # server/
DATA = Path(os.environ.get("CHORDIFY_DATA", ROOT / "data"))
VID_RE = re.compile(r"^[\w-]{11}$", re.ASCII)  # ASCII: \w is unicode-aware by
#                                                default, and these become paths


def _load_key() -> str:
    if os.environ.get("CHORDIFY_KEY"):
        return os.environ["CHORDIFY_KEY"]
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("CHORDIFY_KEY="):
                return line.split("=", 1)[1].strip()
    key = secrets.token_urlsafe(24)
    env_file.write_text(f"CHORDIFY_KEY={key}\n")
    return key


KEY = _load_key()
app = FastAPI(title="chordify-analysis-server")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

manager: JobManager | None = None


@app.on_event("startup")
async def _startup() -> None:
    global manager
    DATA.mkdir(parents=True, exist_ok=True)
    con = db.connect(DATA / "chordify.db")
    models = os.environ.get("CHORDIFY_MODELS")
    manager = JobManager(DATA, con, Path(models) if models else None)
    asyncio.get_running_loop().create_task(manager.worker())


def _auth(req: Request, k: str | None = None) -> None:
    if (req.headers.get("x-chordify-key") or k) != KEY:
        raise HTTPException(401, "missing or bad X-Chordify-Key")


def _vid(v: str) -> str:
    if not VID_RE.match(v or ""):
        raise HTTPException(400, "bad video id")
    return v


@app.get("/health")
async def health():
    return {"ok": True, "ytdlp": ytdlp_version(), "v2": True, "stems": True}


@app.get("/grab")
async def grab_stream(v: str):
    """v1-compatible: stream bestaudio m4a. Serves the cached file when the
    pipeline has already grabbed this id."""
    vid = _vid(v)
    cached = DATA / vid / "source.m4a"
    if cached.exists():
        return FileResponse(cached, media_type="audio/mp4")
    exe = find_ytdlp()
    if not exe:
        raise HTTPException(502, "yt-dlp not available on the server")
    proc = await asyncio.create_subprocess_exec(
        exe, "-f", FORMAT, "--no-playlist", "-o", "-",
        f"https://www.youtube.com/watch?v={vid}",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )

    async def body():
        try:
            while chunk := await proc.stdout.read(64 * 1024):
                yield chunk
        finally:  # client gone or stream done — never leave yt-dlp running
            if proc.returncode is None:
                proc.kill()
                with contextlib.suppress(Exception):
                    await proc.wait()

    return StreamingResponse(body(), media_type="audio/mp4")


@app.post("/analyze")
async def analyze(req: Request, v: str = Body(embed=True), k: str | None = None):
    _auth(req, k)
    vid = _vid(v)
    job, cached = manager.submit(vid)
    return {"job": job.id if job else None, "cached": cached}


@app.get("/job/{job_id}")
async def job_status(req: Request, job_id: str, k: str | None = None):
    _auth(req, k)
    job = manager.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    return job.as_dict()


@app.get("/song/{v}/analysis.json")
async def song_analysis(req: Request, v: str, k: str | None = None):
    _auth(req, k)
    f = DATA / _vid(v) / "analysis.json"
    if not f.exists():
        raise HTTPException(404, "not analyzed yet")
    return FileResponse(f, media_type="application/json")


@app.get("/song/{v}/stem/{name}.m4a")
async def song_stem(req: Request, v: str, name: str, k: str | None = None):
    _auth(req, k)
    if name not in ("vocals", "drums", "bass", "other"):
        raise HTTPException(404, "unknown stem")
    f = DATA / _vid(v) / "stems" / f"{name}.m4a"
    if not f.exists():
        raise HTTPException(404, "stem not ready")
    return FileResponse(f, media_type="audio/mp4")  # FileResponse honours Range


# ── the app itself ────────────────────────────────────────────────────────────
# Serve the PWA shell so tailnet devices need only https://thing3.…ts.net —
# same-origin, so the client's grab probe finds the server with zero settings.
# A strict allowlist, not a static mount: the repo root also holds server/.env
# and the working tree, none of which may ever be reachable. These routes are
# registered last, so the API always matches first.

SITE = ROOT.parent  # the repo root (server/ 's parent)
SHELL_FILES = {
    "index.html": "text/html; charset=utf-8",
    "sw.js": "text/javascript; charset=utf-8",
    "manifest.webmanifest": "application/manifest+json",
    "icon-180.png": "image/png",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "icon-maskable-512.png": "image/png",
}
_NO_CACHE = {"Cache-Control": "no-cache"}  # the service worker does its own caching


def _is_navigation(req: Request) -> bool:
    """True when this looks like the browser loading the app, not a script on
    some other page fetching it.

    This gate matters because CORS here is `*`: without it, ANY page open in a
    browser on the tailnet could fetch('https://thing3…/') , read the body
    through that permissive header, and scrape the injected key — the victim's
    own browser doing the "reaching the server" the key model assumes only the
    owner can do. Browsers omit Origin on top-level GET navigations and on
    same-origin GETs (the service worker precaching './'), and always send it on
    a cross-origin fetch, so this cleanly separates the two.
    """
    origin = req.headers.get("origin")
    if not origin:
        return True
    host = (req.headers.get("host") or "").lower()
    return origin.split("://", 1)[-1].lower().rstrip("/") == host


@app.get("/")
async def shell_index(req: Request):
    """Serve the app, with the API key injected for real navigations.

    Loading this page in a browser already means reaching a tailnet-only server
    — the same bar as /grab, which is keyless — so handing the page its key
    saves every device from typing one.
    """
    html = (SITE / "index.html").read_text(encoding="utf-8")
    if _is_navigation(req):
        # json.dumps handles quotes and backslashes; "<" is escaped separately
        # so a hand-set key containing "</script>" can't break out of the tag.
        literal = json.dumps(KEY).replace("<", "\\u003c")
        html = html.replace("window.CFY_KEY=null;/*CFY_KEY*/",
                            f"window.CFY_KEY={literal};/*CFY_KEY*/", 1)
    return HTMLResponse(html, headers=_NO_CACHE)


@app.get("/{name}")
async def shell_file(req: Request, name: str):
    if name not in SHELL_FILES:
        raise HTTPException(404, "not found")
    if name == "index.html":
        # sw.js precaches both './' and './index.html'; a device whose first hit
        # is this path would otherwise get a shell with no key.
        return await shell_index(req)
    return FileResponse(SITE / name, media_type=SHELL_FILES[name], headers=_NO_CACHE)
