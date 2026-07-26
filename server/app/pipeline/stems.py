"""Stem separation + transcode.

audio-separator runs as a SUBPROCESS with CUDA_VISIBLE_DEVICES pinned: process
exit is the only reliable way to hand VRAM back to the LLMs sharing these GPUs.
FLAC intermediates are transcoded to m4a/AAC (iOS decodeAudioData can't do
Opus) and then deleted.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

STEM_MODEL = "htdemucs_ft.yaml"
STEMS = ("vocals", "drums", "bass", "other")
AAC_BITRATE = "160k"


def _separator_exe() -> str:
    scripts = Path(sys.executable).parent
    exe = scripts / ("audio-separator.exe" if os.name == "nt" else "audio-separator")
    if not exe.exists():
        raise RuntimeError(f"audio-separator not found at {exe}")
    return str(exe)


async def _run(cmd: list[str], env: dict | None = None, what: str = "command") -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        tail = (out or b"").decode(errors="replace").strip()[-800:]
        raise RuntimeError(f"{what} failed (exit {proc.returncode}): {tail}")


async def separate(source: Path, workdir: Path, model_dir: Path,
                   gpu_index: int | None) -> dict[str, Path]:
    """Split source into stems; returns {stem_name: flac_path}."""
    raw = workdir / "stems_raw"
    raw.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    # "" hides every GPU -> torch falls back to CPU (slow but correct)
    env["CUDA_VISIBLE_DEVICES"] = "" if gpu_index is None else str(gpu_index)
    await _run(
        [_separator_exe(), str(source),
         "--model_filename", STEM_MODEL,
         "--model_file_dir", str(model_dir),
         "--output_dir", str(raw),
         "--output_format", "FLAC"],
        env=env, what="audio-separator",
    )
    found: dict[str, Path] = {}
    for f in raw.glob("*.flac"):
        for stem in STEMS:  # files look like: name_(Vocals)_htdemucs_ft.flac
            if f"({stem.capitalize()})" in f.name:
                found[stem] = f
    missing = [s for s in STEMS if s not in found]
    if missing:
        raise RuntimeError(f"separation produced no {missing} stem(s) in {raw}")
    return found


async def transcode(flacs: dict[str, Path], outdir: Path) -> dict[str, Path]:
    """FLAC -> m4a/AAC per stem, then drop the intermediates."""
    outdir.mkdir(parents=True, exist_ok=True)
    out: dict[str, Path] = {}
    for stem, flac in flacs.items():
        m4a = outdir / f"{stem}.m4a"
        await _run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(flac),
             "-c:a", "aac", "-b:a", AAC_BITRATE, "-movflags", "+faststart", str(m4a)],
            what=f"ffmpeg transcode ({stem})",
        )
        out[stem] = m4a
    for flac in flacs.values():
        flac.unlink(missing_ok=True)
    return out
