"""One asyncio worker, jobs strictly serialized — peak VRAM stays one model at
a time (the original plan's GPU discipline)."""
from __future__ import annotations

import asyncio
import json
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import db
from .gpu import pick_gpu
from .pipeline import chords, grab, stems

ANALYSIS_VERSION = 2   # 2 adds ML chords + beats


@dataclass
class Job:
    id: str
    video_id: str
    state: str = "queued"  # queued|grabbing|separating|charting|transcoding|done|error
    progress: float = 0.0
    gpu_index: int | None = None
    error: str | None = None

    def as_dict(self) -> dict:
        return {"id": self.id, "video_id": self.video_id, "status": self.state,
                "progress": self.progress, "gpu": self.gpu_index, "error": self.error}


def _duration_s(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30)
        return round(float(out.stdout.strip()), 3)
    except Exception:
        return None


class JobManager:
    def __init__(self, data_dir: Path, con, model_dir: Path | None = None):
        self.data = data_dir
        self.model_dir = model_dir or data_dir / "models"
        self.con = con
        self.jobs: dict[str, Job] = {}
        self.by_vid: dict[str, str] = {}
        self.queue: asyncio.Queue[Job] = asyncio.Queue()

    def song_dir(self, vid: str) -> Path:
        return self.data / vid

    def is_done(self, vid: str) -> bool:
        """Cached only if the results are current. A song analyzed by an older
        version predates the chord/beat stage, and would otherwise be pinned to a
        stem-only result forever — re-running is what upgrades it."""
        d = self.song_dir(vid)
        if not all((d / "stems" / f"{s}.m4a").exists() for s in stems.STEMS):
            return False
        try:
            got = json.loads((d / "analysis.json").read_text())
        except (OSError, json.JSONDecodeError):
            return False
        if got.get("chord_error"):
            # A transient failure (a GPU busy with an LLM, say) must not pin this
            # song to a stem-only result for good. Re-run and it gets its chart.
            return False
        return got.get("analysis_version", 0) >= ANALYSIS_VERSION

    def submit(self, vid: str) -> tuple[Job | None, bool]:
        """Returns (job, cached). cached=True means results already exist."""
        if self.is_done(vid):
            return None, True
        live = self.by_vid.get(vid)
        if live and self.jobs[live].state not in ("done", "error"):
            return self.jobs[live], False
        job = Job(uuid.uuid4().hex[:12], vid)
        self.jobs[job.id] = job
        self.by_vid[vid] = job.id
        self.queue.put_nowait(job)
        return job, False

    async def worker(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                await self._run(job)
            except Exception as e:  # noqa: BLE001 — job errors must not kill the worker
                job.state, job.error = "error", str(e)[:500]
                db.upsert_song(self.con, job.video_id, status="error", error=job.error)

    async def _run(self, job: Job) -> None:
        d = self.song_dir(job.video_id)
        source = d / "source.m4a"
        db.upsert_song(self.con, job.video_id, status="pending", error=None)

        job.state, job.progress = "grabbing", 0.05
        await grab.grab(job.video_id, source)

        job.state, job.progress = "separating", 0.15
        job.gpu_index = pick_gpu()
        model_dir = self.model_dir
        try:
            flacs = await stems.separate(source, d, model_dir, job.gpu_index)
        except RuntimeError:
            if job.gpu_index is None:
                raise
            # NVML free-VRAM is a heuristic under WDDM — OOM here is expected.
            # One retry on the other card, then CPU.
            other = 1 - job.gpu_index
            job.gpu_index = other
            try:
                flacs = await stems.separate(source, d, model_dir, other)
            except RuntimeError:
                job.gpu_index = None
                flacs = await stems.separate(source, d, model_dir, None)

        duration = _duration_s(source)

        # Chords read the accompaniment FLACs, so this must happen before the
        # transcode step deletes them.
        job.state, job.progress = "charting", 0.6
        chart: dict = {}
        try:
            chart = await chords.analyze(source, flacs, d, model_dir,
                                         job.gpu_index, duration)
        except Exception as e:  # noqa: BLE001
            # Separated stems are useful on their own, and the app still has its
            # in-browser detector. Losing the chart must not lose the song.
            chart = {"chord_error": str(e)[:300]}

        job.state, job.progress = "transcoding", 0.8
        await stems.transcode(flacs, d / "stems")

        analysis = {
            "video_id": job.video_id,
            "analysis_version": ANALYSIS_VERSION,
            "stem_model": stems.STEM_MODEL,
            "stems": list(stems.STEMS),
            "duration_s": duration,
            **chart,
        }
        (d / "analysis.json").write_text(json.dumps(analysis, indent=2))
        db.upsert_song(self.con, job.video_id, status="done", duration_s=duration,
                       stem_model=stems.STEM_MODEL, analysis_version=ANALYSIS_VERSION)
        job.state, job.progress = "done", 1.0
