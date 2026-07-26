"""SQLite cache index. Files live on disk under data/<video_id>/; the DB only
records state, so a wiped data dir just means re-analysis."""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs(
  video_id         TEXT PRIMARY KEY,
  title            TEXT,
  duration_s       REAL,
  status           TEXT,              -- pending|done|error
  stem_model       TEXT,
  analysis_version INTEGER,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT,
  error            TEXT
);
"""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


def upsert_song(con: sqlite3.Connection, video_id: str, **fields) -> None:
    fields["updated_at"] = "datetime('now')"
    con.execute(
        "INSERT INTO songs(video_id) VALUES(?) ON CONFLICT(video_id) DO NOTHING",
        (video_id,),
    )
    sets = ", ".join(f"{k}=?" for k in fields if k != "updated_at")
    vals = [v for k, v in fields.items() if k != "updated_at"]
    con.execute(
        f"UPDATE songs SET {sets}, updated_at=datetime('now') WHERE video_id=?",
        (*vals, video_id),
    )
    con.commit()


def get_song(con: sqlite3.Connection, video_id: str) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM songs WHERE video_id=?", (video_id,)).fetchone()
