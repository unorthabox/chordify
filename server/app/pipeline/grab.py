"""yt-dlp: locate the binary, report its version, download audio for a video id.

m4a/AAC is preferred deliberately — iOS decodeAudioData can't decode Opus/WebM
(same constraint grab-server.mjs documents).
"""
from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

FORMAT = "bestaudio[ext=m4a]/bestaudio"


def find_ytdlp() -> str | None:
    p = shutil.which("yt-dlp")
    if p:
        return p
    for name in ("yt-dlp.exe", "yt-dlp"):
        cand = Path.home() / ".local" / "bin" / name
        if cand.exists():
            return str(cand)
    return None


def ytdlp_version() -> str | None:
    exe = find_ytdlp()
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip() or None
    except Exception:
        return None


async def grab(video_id: str, dest: Path) -> None:
    """Download bestaudio m4a for video_id to dest. No-op if already cached."""
    if dest.exists():
        return
    exe = find_ytdlp()
    if not exe:
        raise RuntimeError("yt-dlp not found (PATH or ~/.local/bin)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        exe, "-f", FORMAT, "--no-playlist", "-o", str(dest),
        f"https://www.youtube.com/watch?v={video_id}",
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0 or not dest.exists():
        tail = (err or b"").decode(errors="replace").strip()[-500:]
        raise RuntimeError(f"yt-dlp failed (exit {proc.returncode}): {tail}")
