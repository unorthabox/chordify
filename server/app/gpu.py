"""Pick the idler GPU for a job, or None to run on CPU.

Two cards share this box with LLM workloads (Ollama / LM Studio). NVML free-VRAM
is only a heuristic under WDDM paging, so callers must treat OOM as expected:
retry on the other card, then fall back to CPU.
"""
from __future__ import annotations

MIN_FREE_MB = 5000  # htdemucs_ft peaks ~4-6GB


def pick_gpu(min_free_mb: int = MIN_FREE_MB) -> int | None:
    try:
        import pynvml

        pynvml.nvmlInit()
        try:
            best, best_free = None, 0
            for i in range(pynvml.nvmlDeviceGetCount()):
                h = pynvml.nvmlDeviceGetHandleByIndex(i)
                free_mb = pynvml.nvmlDeviceGetMemoryInfo(h).free // (1024 * 1024)
                if free_mb > best_free:
                    best, best_free = i, free_mb
            return best if best is not None and best_free >= min_free_mb else None
        finally:
            pynvml.nvmlShutdown()
    except Exception:
        return None
