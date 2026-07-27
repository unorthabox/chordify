"""Chord + beat inference, run as a SUBPROCESS.

Same VRAM discipline as stems.py: these GPUs are shared with LLM workloads, and
process exit is the only reliable way to hand the memory back. Both models run
here so one spawn covers both and the exit frees everything at once.

Reads two audio paths, writes one JSON object to stdout:
  {chords: [[start, end, label], ...], beats: [...], downbeats: [...]}
Chord labels are raw BTC large-voca ("G#", "F:min", "D#:min7", "N"); mapping
them to the app's vocabulary happens in chords.py, which needs no torch.

Usage: btc_runner.py <chord-audio> <beat-audio> <weights.pt>
"""
from __future__ import annotations

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

BTC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "btc")


def _patch_2019_isms() -> None:
    """BTC is 2019 code: three things it assumes no longer exist."""
    import numpy as np
    # np.float and friends were removed in numpy 1.24.
    for name, typ in [("float", float), ("int", int), ("bool", bool),
                      ("object", object), ("complex", complex), ("str", str)]:
        if not hasattr(np, name):
            setattr(np, name, typ)
    # yaml.load without a Loader is an error, not a warning, in modern pyyaml.
    import yaml
    original = yaml.load
    yaml.load = lambda stream, Loader=yaml.SafeLoader, **kw: original(stream, Loader=Loader, **kw)


def chords(audio: str, weights: str) -> list:
    import numpy as np
    import torch
    from btc_model import BTC_model, HParams
    from utils.mir_eval_modules import audio_file_to_features, idx2voca_chord

    cfg = HParams.load(os.path.join(BTC_DIR, "run_config.yaml"))
    cfg.feature["large_voca"] = True
    cfg.model["num_chords"] = 170
    idx_to_chord = idx2voca_chord()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = BTC_model(config=cfg.model).to(dev)
    # weights_only=False: this checkpoint carries its feature mean/std alongside
    # the state dict, and it is a file we vendored, not untrusted input.
    ck = torch.load(weights, map_location=dev, weights_only=False)
    mean, std = ck["mean"], ck["std"]
    model.load_state_dict(ck["model"])
    model.eval()

    feature, fps, _song_len = audio_file_to_features(audio, cfg)
    feature = (feature.T - mean) / std
    n_ts = cfg.model["timestep"]
    pad = n_ts - (feature.shape[0] % n_ts)
    feature = np.pad(feature, ((0, pad), (0, 0)), mode="constant")
    n_inst = feature.shape[0] // n_ts

    out, start, prev = [], 0.0, None
    with torch.no_grad():
        f = torch.tensor(feature, dtype=torch.float32).unsqueeze(0).to(dev)
        for t in range(n_inst):
            enc, _ = model.self_attn_layers(f[:, n_ts * t:n_ts * (t + 1), :])
            pred, _ = model.output_layer(enc)
            pred = pred.squeeze()
            for i in range(n_ts):
                at = fps * (n_ts * t + i)
                if t == 0 and i == 0:
                    prev = pred[i].item()
                    continue
                if pred[i].item() != prev:
                    out.append([round(start, 3), round(at, 3), idx_to_chord[prev]])
                    start, prev = at, pred[i].item()
                if t == n_inst - 1 and i + pad == n_ts:
                    if start != at:
                        out.append([round(start, 3), round(at, 3), idx_to_chord[prev]])
                    break
    return out


def beats(audio: str) -> tuple[list, list]:
    from beat_this.inference import File2Beats
    # dbn=True would pull in madmom, which cannot build here (no C compiler).
    f2b = File2Beats(checkpoint_path="final0",
                     device="cuda" if _cuda() else "cpu", dbn=False)
    b, db = f2b(audio)
    return [round(float(x), 3) for x in b], [round(float(x), 3) for x in db]


def _cuda() -> bool:
    import torch
    return torch.cuda.is_available()


def main() -> int:
    chord_audio, beat_audio, weights = sys.argv[1], sys.argv[2], sys.argv[3]
    sys.path.insert(0, BTC_DIR)
    _patch_2019_isms()
    result = {"chords": chords(chord_audio, weights)}
    b, db = beats(beat_audio)
    result["beats"], result["downbeats"] = b, db
    # stdout is the channel; anything the libraries printed went to stderr.
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
