"""ML chord recognition + beat tracking, and the music theory that makes the
result look like a chart a person would write.

Two models, both run once per song in one subprocess (see btc_runner.py):
  chords  BTC-ISMIR19 large-vocabulary bi-directional transformer (MIT)
  beats   beat-this (MIT, ISMIR 2024)

Chords are read from the ACCOMPANIMENT (other+bass), not the full mix: with the
vocal and drums gone the harmony is most of what is left, which is the whole
reason separation runs first. Beats are read from the FULL mix, where the drums
that define the pulse are still present.

Everything after inference is plain arithmetic — snapping chord edges to the
detected beats, merging repeats, and spelling roots to fit the key (so a song in
Ab reads Ab/Db/Eb rather than G#/C#/D#).
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "btc_runner.py"
WEIGHTS_NAME = "btc_model_large_voca.pt"
# The ChordMini fork hosts the MIT-licensed checkpoint as a plain file; the
# original repo's link is a Google Drive interstitial that cannot be curled.
WEIGHTS_URL = ("https://raw.githubusercontent.com/ptnghia-j/ChordMini/main/"
               "checkpoints/btc_model_large_voca.pt")

CHORD_MODEL = "BTC-ISMIR19 large-voca"
BEAT_MODEL = "beat-this final0"

SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# BTC's large vocabulary -> the suffixes index.html can actually voice and draw
# (its QUAL table). minmaj7 has no entry there, so it degrades to a plain minor
# rather than rendering as an unknown symbol.
QUALITY = {
    "maj": "", "min": "m", "dim": "dim", "aug": "aug",
    "min6": "m6", "maj6": "6", "min7": "m7", "minmaj7": "m",
    "maj7": "maj7", "7": "7", "dim7": "dim7", "hdim7": "m7b5",
    "sus2": "sus2", "sus4": "sus4",
}
NO_CHORD = "N.C."

_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Scale degrees and the triad quality each degree wants, used only for scoring.
_MAJOR = ([0, 2, 4, 5, 7, 9, 11], ["", "m", "m", "", "", "m", "dim"])
_MINOR = ([0, 2, 3, 5, 7, 8, 10], ["m", "dim", "", "m", "m", "", ""])
# Sharps in the key signature of each major key, by tonic pitch class.
# Negative = flats. Decides whether the chart reads in sharps or flats.
_FIFTHS = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6,
           1: -5, 8: -4, 3: -3, 10: -2, 5: -1}


def ensure_weights(model_dir: Path) -> Path:
    """Download the checkpoint once (12MB). Kept out of git with the demucs
    weights — a clean clone should not carry model binaries."""
    model_dir.mkdir(parents=True, exist_ok=True)
    path = model_dir / WEIGHTS_NAME
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    tmp = path.with_suffix(".part")
    urllib.request.urlretrieve(WEIGHTS_URL, tmp)  # noqa: S310 — fixed https URL
    tmp.replace(path)
    return path


def _parse(label: str) -> tuple[int, str] | None:
    """'D#:min7' -> (3, 'm7'); 'N'/'X'/unknown -> None."""
    if not label or label in ("N", "X"):
        return None
    label = label.split("/", 1)[0]            # drop inversions: the bass note is
    root, _, qual = label.partition(":")      # not something the grid shows
    if not root or root[0] not in _PC:
        return None
    pc = (_PC[root[0]] + root[1:].count("#") - root[1:].count("b")) % 12
    return pc, QUALITY.get(qual or "maj", "")


def estimate_key(segments: list[tuple[int, str, float]]) -> tuple[int, bool]:
    """Score all 24 keys by how much chord TIME they explain. Returns
    (tonic pitch class, is_major)."""
    best, best_score = (0, True), -1.0
    for tonic in range(12):
        for scale, wanted in (_MAJOR, _MINOR):
            score = 0.0
            for pc, qual, dur in segments:
                degree = (pc - tonic) % 12
                if degree not in scale:
                    continue
                score += dur
                if wanted[scale.index(degree)] == qual:
                    score += dur * 0.5            # right chord on the right degree
                if degree == 0:
                    score += dur * 0.3            # tonic carries the key
            if score > best_score:
                best, best_score = (tonic, scale is _MAJOR[0]), score
    return best


def _spell(pc: int, tonic: int, is_major: bool) -> str:
    relative_major = tonic if is_major else (tonic + 3) % 12
    return (SHARP if _FIFTHS.get(relative_major, 0) >= 0 else FLAT)[pc]


def _snap(value: float, grid: list[float], tolerance: float) -> float:
    """Pull a chord edge onto the nearest beat, but only if it is already close;
    a boundary far from any beat is real (pickup bars, free intros)."""
    if not grid:
        return value
    nearest = min(grid, key=lambda b: abs(b - value))
    return nearest if abs(nearest - value) <= tolerance else value


def postprocess(raw: dict, duration: float | None) -> dict:
    """Model output -> the chart the app renders."""
    beats = raw.get("beats") or []
    downbeats = raw.get("downbeats") or []

    bpm = None
    if len(beats) > 1:
        gaps = [b - a for a, b in zip(beats, beats[1:]) if b > a]
        if gaps:
            median = statistics.median(gaps)
            if median > 0:
                bpm = round(60.0 / median, 2)

    # tolerance: half a beat, so an edge can only be pulled to the beat it is
    # genuinely nearest to and never hop across one.
    tolerance = (30.0 / bpm) if bpm else 0.25

    parsed: list[tuple[float, float, int | None, str]] = []
    for start, end, label in raw.get("chords") or []:
        start = _snap(float(start), beats, tolerance)
        end = _snap(float(end), beats, tolerance)
        if end - start <= 0.01:
            continue
        got = _parse(label)
        parsed.append((start, end, got[0] if got else None, got[1] if got else ""))

    key_input = [(pc, qual, end - start) for start, end, pc, qual in parsed if pc is not None]
    tonic, is_major = estimate_key(key_input) if key_input else (0, True)

    chords: list[list] = []
    for start, end, pc, qual in parsed:
        sym = NO_CHORD if pc is None else _spell(pc, tonic, is_major) + qual
        # snapping can make neighbours identical; a chart repeats a chord across
        # bars, it does not print it twice in a row
        if chords and chords[-1][0] == sym and abs(chords[-1][1] + chords[-1][2] - start) < 0.02:
            chords[-1][2] = round(end - chords[-1][1], 3)
            continue
        chords.append([sym, round(start, 3), round(end - start, 3)])

    return {
        "chords": chords,
        "beats": beats,
        "downbeats": downbeats,
        "bpm": bpm,
        "key": _spell(tonic, tonic, is_major) + ("" if is_major else "m"),
        "chord_model": CHORD_MODEL,
        "beat_model": BEAT_MODEL,
        "duration_s": duration,
    }


async def _ffmpeg(args: list[str], what: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-v", "error", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        tail = (stdout or b"").decode(errors="replace").strip()[-500:]
        raise RuntimeError(f"{what} failed: {tail}")


async def _decode_wav(source: Path, out: Path) -> Path:
    """beat-this reads PCM only — handed the raw m4a it fails, then falls back to
    madmom, which is not installable here, so the error surfaces as a confusing
    ModuleNotFoundError. Decode first and it never gets there."""
    await _ffmpeg(["-i", str(source), "-ac", "1", "-ar", "44100", str(out)],
                  "beat-track decode")
    return out


async def _mix_accompaniment(flacs: dict[str, Path], out: Path) -> Path:
    """other + bass -> one 44.1k mono wav. Two inputs at half gain each: amix
    normalises by input count, which would duck the whole thing otherwise."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-v", "error",
        "-i", str(flacs["other"]), "-i", str(flacs["bass"]),
        "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0[a]",
        "-map", "[a]", "-ac", "1", "-ar", "44100", str(out),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        tail = (stdout or b"").decode(errors="replace").strip()[-500:]
        raise RuntimeError(f"accompaniment mix failed: {tail}")
    return out


async def analyze(source: Path, flacs: dict[str, Path], workdir: Path,
                  model_dir: Path, gpu_index: int | None,
                  duration: float | None) -> dict:
    """Run both models and return the finished chart section of analysis.json."""
    weights = await asyncio.to_thread(ensure_weights, model_dir)
    accomp = await _mix_accompaniment(flacs, workdir / "accomp.wav")
    full = await _decode_wav(source, workdir / "beats.wav")

    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = "" if gpu_index is None else str(gpu_index)
    env["PYTHONIOENCODING"] = "utf-8"
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(RUNNER), str(accomp), str(full), str(weights),
        env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    accomp.unlink(missing_ok=True)
    full.unlink(missing_ok=True)
    if proc.returncode != 0:
        tail = (err or b"").decode(errors="replace").strip()[-800:]
        raise RuntimeError(f"chord/beat inference failed (exit {proc.returncode}): {tail}")
    try:
        raw = json.loads(out.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise RuntimeError(f"chord/beat runner returned non-JSON: {out[:300]!r}") from e
    return postprocess(raw, duration)
