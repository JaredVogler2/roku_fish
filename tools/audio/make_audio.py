#!/usr/bin/env python3
"""Render the complete REEFBOUND audio set for the Roku channel.

    python3 tools/audio/make_audio.py            # from the repo root (any cwd works)

Roku cannot synthesise audio the way the browser game does (Web Audio), so every sound is
pre-rendered here, offline and deterministically (fixed seeds, no downloaded samples -- the
recipes mirror REEFBOUND/src/game/audio/audio.ts). The script writes into ``channel/sounds/``:

    <id>.wav            36 sound effects for roAudioResource
    music_reef.mp3      lagoon / menu loop for roAudioPlayer
    music_deep.mp3      wreck / deep water / night loop
    sounds.json         {"sfx": {id: {file, ms, vol}}, "music": {id: {file, ms}}}

Constraints it builds to, and then verifies by reading every file back from disk:

* Effects: WAV, PCM 16-bit, mono, 16000 Hz, canonical 44-byte RIFF header (no extra chunks),
  peak -3 dBFS (ui_move: -12), 2 ms / 5 ms raised-cosine fades, no silent head or tail, no DC.
* Music: MP3 (MPEG-2 Layer III), mono, 22050 Hz, CBR 40 kbps, bare frames (no ID3 / Xing);
  decoded peak about -6 dBFS; 1.5 s fades to silence at both ends, because roAudioPlayer
  loops by restarting the file.
* Size (1 KB = 1000 bytes): effects <= 260 KB, music <= 340 KB, whole folder <= 600 KB.
  A 16 kHz WAV costs 32 KB per second and a 40 kbps MP3 5 KB per second, so the budget buys
  about 8.1 s of effects and 68 s of music in total. That is what sets the lengths in
  sfx.SFX and music.TRACKS -- lengthen one sound and another has to give.

The run ends with a table (file, ms, peak dBFS, rms, loudness, volume, bytes) and the totals
against the budget, and exits non-zero if any file is invalid or a budget is exceeded.

``vol`` in the manifest is a mixing suggestion for roAudioResource.Trigger(vol), assuming the
volume is a linear gain (vol / 100). The values sit the effects on a few loudness levels,
measured rather than heard -- see the note above sfx.SFX and the 'loud' / '@vol' columns.

Options: ``--check-only`` verifies the existing files without rendering. ``--kbps`` and
``--reef-seconds`` / ``--deep-seconds`` trade MP3 quality for loop length inside the same
budget (the chords simply stretch), e.g. ``--kbps 32 --reef-seconds 45.5 --deep-seconds 38``.

Where to tweak: ``sfx.py`` (one function per effect + the SFX table: length, volume, tone),
``music.py`` (chords, layers, track lengths), ``dsp.py`` (primitives). ``analyze_audio.py``
then re-checks the design intent numerically (pitch contours, notes, spectra, loop seam).

Needs Python 3.9+, numpy, and ffmpeg with libmp3lame (ffprobe is used too when present).
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True          # keep tools/audio free of __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import music  # noqa: E402
import sfx  # noqa: E402
import verify  # noqa: E402
from dsp import db, to_pcm16, undb, wav_bytes  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "channel" / "sounds"
MANIFEST = "sounds.json"

# Size budget in bytes (decimal kilobytes: the stricter reading of "KB").
SFX_BUDGET = 260_000
MUSIC_BUDGET = 340_000
TOTAL_BUDGET = 600_000

MUSIC_KBPS = 40


# ----------------------------------------------------------------------------- MP3 encoding
def encode_mp3(pcm: np.ndarray, rate: int, kbps: int) -> bytes:
    """PCM -> WAV -> ffmpeg/libmp3lame -> bare CBR MP3 frames (no ID3, no Xing header), all via pipes."""
    cmd = ["ffmpeg", "-hide_banner", "-v", "error", "-f", "wav", "-i", "pipe:0",
           "-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-ar", str(rate), "-ac", "1", "-compression_level", "2",
           "-map_metadata", "-1", "-id3v2_version", "0", "-write_xing", "0", "-bitexact", "-f", "mp3", "pipe:1"]
    run = subprocess.run(cmd, input=wav_bytes(pcm, rate), capture_output=True, check=False)
    if run.returncode != 0 or not run.stdout:
        raise RuntimeError("ffmpeg failed: " + run.stderr.decode("utf-8", "replace").strip())
    return run.stdout


def render_music_mp3(track: music.Track, seconds: float, kbps: int) -> bytes:
    """Synthesise a track and encode it so that the *decoded* peak sits at music.PEAK_DB.

    Lossy coding moves peaks by a few tenths of a dB, so the gain is corrected and the track
    re-encoded up to twice; the attempt closest to the target is kept."""
    y = music.render(track, seconds)
    best, best_error = b"", float("inf")
    for _ in range(3):
        data = encode_mp3(to_pcm16(y), music.MUSIC_RATE, kbps)
        decoded, _messages = verify.decode_mp3(data, music.MUSIC_RATE)
        error = music.PEAK_DB - db(float(np.max(np.abs(decoded))) / 32768.0)
        if abs(error) < best_error:
            best, best_error = data, abs(error)
        if abs(error) <= 0.1:
            break
        y = y * undb(error)
    return best


# ----------------------------------------------------------------------------- generate
def generate(out: Path, kbps: int, seconds: dict) -> None:
    """Render everything and write the files plus the manifest."""
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"sfx": {}, "music": {}}
    for e in sfx.SFX:
        pcm = to_pcm16(sfx.render(e))
        (out / f"{e.id}.wav").write_bytes(wav_bytes(pcm, sfx.SFX_RATE))
        manifest["sfx"][e.id] = {"file": f"{e.id}.wav", "ms": round(1000.0 * len(pcm) / sfx.SFX_RATE), "vol": e.vol}
    for tr in music.TRACKS:
        data = render_music_mp3(tr, seconds[tr.id], kbps)
        name = f"music_{tr.id}.mp3"
        (out / name).write_bytes(data)
        frames, _notes = verify.mp3_frames(data)
        manifest["music"][tr.id] = {"file": name, "ms": round(1000.0 * len(frames) * 576 / music.MUSIC_RATE)}
    # One entry per line: easy to read and to diff.
    lines = ["{"]
    for section in ("sfx", "music"):
        lines.append(f'  "{section}": {{')
        entries = [f'    "{key}": {json.dumps(entry)}' for key, entry in manifest[section].items()]
        lines.append(",\n".join(entries))
        lines.append("  }," if section == "sfx" else "  }")
    lines.append("}")
    (out / MANIFEST).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ----------------------------------------------------------------------------- verify + report
def check(out: Path, kbps: int, seconds: dict) -> bool:
    """Read every file back, print the table and the budget, return True if all is well."""
    problems: list = []
    sfx_reports = [verify.check_wav(out / f"{e.id}.wav", sfx.SFX_RATE, e.peak_db, e.dur) for e in sfx.SFX]
    music_reports = [verify.check_mp3(out / f"music_{tr.id}.mp3", music.MUSIC_RATE, kbps, music.PEAK_DB,
                                      seconds[tr.id], music.EDGE_FADE) for tr in music.TRACKS]

    # Manifest: exact shape, lowercase keys, every sound listed once, durations matching the files.
    manifest_path = out / MANIFEST
    manifest_size = manifest_path.stat().st_size if manifest_path.is_file() else 0
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if list(manifest) != ["sfx", "music"]:
            problems.append(f"{MANIFEST}: top-level keys are {list(manifest)}")
        if list(manifest["sfx"]) != [e.id for e in sfx.SFX] or list(manifest["music"]) != [t.id for t in music.TRACKS]:
            problems.append(f"{MANIFEST}: entries do not match the sound list")
        for e, rep in zip(sfx.SFX, sfx_reports):
            entry = manifest["sfx"].get(e.id, {})
            if entry != {"file": rep.name, "ms": round(rep.ms), "vol": e.vol} or not 0 <= e.vol <= 100 or e.id != e.id.lower():
                problems.append(f"{MANIFEST}: bad entry for {e.id}: {entry}")
        for tr, rep in zip(music.TRACKS, music_reports):
            entry = manifest["music"].get(tr.id, {})
            if entry != {"file": rep.name, "ms": round(rep.ms)}:
                problems.append(f"{MANIFEST}: bad entry for {tr.id}: {entry} (file is {rep.ms:.0f} ms)")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        problems.append(f"{MANIFEST}: unreadable ({exc})")

    expected = {r.name for r in sfx_reports + music_reports} | {MANIFEST}
    for p in sorted(out.iterdir()):
        if p.name not in expected:
            problems.append(f"unexpected file in {out.name}/: {p.name} ({p.stat().st_size} bytes)")

    print(f"{'file':<16}{'ms':>7}{'peak dBFS':>11}{'rms dBFS':>10}{'loud':>7}{'vol':>5}{'@vol':>7}{'bytes':>9}  status")
    for e, rep in zip(sfx.SFX, sfx_reports):
        at_vol = rep.loud_db + 20.0 * math.log10(max(e.vol, 1) / 100.0)
        print(f"{rep.name:<16}{rep.ms:>7.0f}{rep.peak_db:>11.2f}{rep.rms_db:>10.1f}{rep.loud_db:>7.1f}{e.vol:>5}{at_vol:>7.1f}{rep.size:>9}"
              f"  {'ok' if rep.ok else 'FAIL: ' + '; '.join(rep.problems)}")
    for rep in music_reports:
        print(f"{rep.name:<16}{rep.ms:>7.0f}{rep.peak_db:>11.2f}{rep.rms_db:>10.1f}{rep.loud_db:>7.1f}{'-':>5}{rep.loud_db:>7.1f}{rep.size:>9}"
              f"  {'ok' if rep.ok else 'FAIL: ' + '; '.join(rep.problems)}")
    print("(loud: perceived-level proxy in dB re full scale, see dsp.loudness_db -- loudest 125 ms of an effect,")
    print(" whole-file average of a music track; @vol: the same at the suggested playback volume)")

    sfx_bytes = sum(r.size for r in sfx_reports)
    music_bytes = sum(r.size for r in music_reports)
    folder_bytes = sum(p.stat().st_size for p in out.iterdir() if p.is_file())
    print()
    rows = (
        (f"effects  ({len(sfx_reports)} wav, {sum(r.ms for r in sfx_reports) / 1000.0:.2f} s)", sfx_bytes, SFX_BUDGET),
        (f"music    ({len(music_reports)} mp3, {sum(r.ms for r in music_reports) / 1000.0:.1f} s, {kbps} kbps)", music_bytes, MUSIC_BUDGET),
        (f"folder   (effects + music + {MANIFEST} {manifest_size} B)", folder_bytes, TOTAL_BUDGET),
    )
    for label, used, budget in rows:
        over = used > budget
        print(f"{label:<46}{used:>8} / {budget} bytes  {100.0 * used / budget:5.1f} %  {'OVER BUDGET' if over else 'ok'}")
        if over:
            problems.append(f"over budget: {label.split()[0]} {used} > {budget} bytes")
    problems += [f"{r.name}: {p}" for r in sfx_reports + music_reports for p in r.problems]

    print()
    if problems:
        print(f"FAILED ({len(problems)} problem{'s' if len(problems) != 1 else ''}):")
        for p in problems:
            print("  - " + p)
        return False
    print(f"OK: {len(sfx_reports)} effects + {len(music_reports)} music tracks verified in {out}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Render and verify the REEFBOUND Roku audio set.")
    ap.add_argument("--out", type=Path, default=OUT_DIR, help="output folder (default: channel/sounds)")
    ap.add_argument("--check-only", action="store_true", help="verify the existing files without re-rendering")
    ap.add_argument("--kbps", type=int, default=MUSIC_KBPS, help="MP3 bitrate (default: %(default)s)")
    for tr in music.TRACKS:
        ap.add_argument(f"--{tr.id}-seconds", type=float, default=tr.seconds,
                        help=f"length of music_{tr.id}.mp3 (default: %(default)s)")
    args = ap.parse_args()
    if not shutil.which("ffmpeg"):
        print("error: ffmpeg (with libmp3lame) is required", file=sys.stderr)
        return 2
    seconds = {tr.id: getattr(args, f"{tr.id}_seconds") for tr in music.TRACKS}
    if not args.check_only:
        generate(args.out, args.kbps, seconds)
    if not args.out.is_dir():
        print(f"error: {args.out} does not exist", file=sys.stderr)
        return 2
    return 0 if check(args.out, args.kbps, seconds) else 1


if __name__ == "__main__":
    sys.exit(main())
