"""Read the rendered files back from disk and check them against the Roku constraints.

Nothing here trusts the generator: WAV headers are parsed byte by byte (and cross-checked with
Python's ``wave`` module), MP3s are walked frame by frame and decoded with ffmpeg.
"""
from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from dsp import db, loudness_db

# MPEG audio header tables (Layer III only).
_BITRATES = {3: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),      # MPEG-1
             2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),          # MPEG-2
             0: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)}          # MPEG-2.5
_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}


@dataclass
class Report:
    name: str
    size: int = 0
    ms: float = 0.0
    peak_db: float = -240.0
    rms_db: float = -240.0
    loud_db: float = -240.0       # dsp.loudness_db: loudest 125 ms for effects, whole-file average for music
    dc: float = 0.0               # mean sample value, fraction of full scale
    problems: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def _measure(rep: Report, pcm: np.ndarray, rate: int, window: float | None) -> np.ndarray:
    x = pcm.astype(np.float64) / 32768.0
    rep.ms = 1000.0 * len(x) / rate
    rep.peak_db = db(float(np.max(np.abs(x)))) if len(x) else -240.0
    rep.rms_db = db(math.sqrt(float(np.mean(x * x)))) if len(x) else -240.0
    rep.dc = float(np.mean(x)) if len(x) else 0.0
    rep.loud_db = loudness_db(x, rate, window) if len(x) else -240.0
    return x


# ----------------------------------------------------------------------------- WAV
def check_wav(path: Path, rate: int, peak_db: float, max_seconds: float) -> Report:
    """PCM 16-bit mono at ``rate`` with the canonical 44-byte header, sane level, clean edges."""
    rep = Report(path.name)
    bad = rep.problems.append
    if not path.is_file():
        bad("file missing")
        return rep
    raw = path.read_bytes()
    rep.size = len(raw)
    if len(raw) < 46:
        bad("too small to be a WAV file")
        return rep
    riff, riff_size, wave_id, fmt_id, fmt_size, tag, channels, sample_rate, byte_rate, align, bits, data_id, data_size = \
        struct.unpack("<4sI4s4sIHHIIHH4sI", raw[:44])
    if (riff, wave_id, fmt_id, data_id) != (b"RIFF", b"WAVE", b"fmt ", b"data") or fmt_size != 16:
        bad("not a canonical RIFF/WAVE file (fmt chunk immediately followed by data chunk)")
        return rep
    if tag != 1:
        bad(f"format tag {tag}, expected 1 (PCM)")
    if channels != 1:
        bad(f"{channels} channels, expected mono")
    if sample_rate != rate:
        bad(f"sample rate {sample_rate}, expected {rate}")
    if bits != 16 or align != 2 or byte_rate != rate * 2:
        bad(f"expected 16-bit samples (bits={bits}, block align={align}, byte rate={byte_rate})")
    if riff_size != len(raw) - 8 or data_size != len(raw) - 44 or data_size % 2:
        bad("chunk sizes do not match the file size (extra chunks or truncated data)")
    try:
        with wave.open(str(path), "rb") as wf:
            params = (wf.getnchannels(), wf.getsampwidth(), wf.getframerate(), wf.getnframes(), wf.getcomptype())
        if params != (1, 2, rate, (len(raw) - 44) // 2, "NONE"):
            bad(f"wave module reads {params}")
    except (wave.Error, EOFError) as exc:
        bad(f"wave module cannot open it: {exc}")
    if rep.problems:
        return rep

    pcm = np.frombuffer(raw[44:], dtype="<i2")
    x = _measure(rep, pcm, rate, 0.125)
    peak = float(np.max(np.abs(x)))
    if not 30.0 <= rep.ms <= 1000.0 * max_seconds + 0.5:
        bad(f"duration {rep.ms:.0f} ms outside 30..{1000.0 * max_seconds:.0f} ms")
    if abs(rep.peak_db - peak_db) > 0.3:
        bad(f"peak {rep.peak_db:.2f} dBFS, expected about {peak_db:.1f}")
    if int(np.max(np.abs(pcm.astype(np.int32)))) >= 32767:
        bad("clipped (full-scale samples)")
    if rep.rms_db < -45.0:
        bad(f"nearly silent (rms {rep.rms_db:.1f} dBFS)")
    if abs(rep.dc) > 0.003:
        bad(f"DC offset {rep.dc:+.4f} of full scale")
    if max(abs(x[0]), abs(x[-1])) > 0.01 * peak:
        bad("does not start and end at zero (would click)")
    live = np.nonzero(np.abs(x) >= peak * 10.0 ** (-50.0 / 20.0))[0]
    head_ms = 1000.0 * live[0] / rate
    tail_ms = 1000.0 * (len(x) - 1 - live[-1]) / rate
    if head_ms > 5.0:
        bad(f"{head_ms:.0f} ms of leading silence")
    if tail_ms > 12.0:
        bad(f"{tail_ms:.0f} ms of trailing silence")
    return rep


# ----------------------------------------------------------------------------- MP3
def mp3_frames(raw: bytes) -> tuple[list, list]:
    """Walk an MP3 byte stream. Returns (frames, notes): frames are (version, bitrate kbps, sample
    rate, mono?) tuples; notes lists anything that is not a plain Layer III frame."""
    notes: list = []
    frames: list = []
    pos = 0
    if raw[:3] == b"ID3" and len(raw) > 10:
        size = (raw[6] << 21) | (raw[7] << 14) | (raw[8] << 7) | raw[9]
        notes.append(f"ID3v2 tag ({size + 10} bytes)")
        pos = size + 10
    while pos + 4 <= len(raw):
        if raw[pos:pos + 3] == b"TAG" and len(raw) - pos == 128:
            notes.append("ID3v1 tag (128 bytes)")
            pos = len(raw)
            break
        head = int.from_bytes(raw[pos:pos + 4], "big")
        version, layer = (head >> 19) & 3, (head >> 17) & 3
        bitrate_i, rate_i, padding, mode = (head >> 12) & 15, (head >> 10) & 3, (head >> 9) & 1, (head >> 6) & 3
        if (head >> 21) != 0x7FF or version == 1 or layer != 1 or bitrate_i in (0, 15) or rate_i == 3:
            notes.append(f"{len(raw) - pos} bytes that are not Layer III frames at offset {pos}")
            break
        kbps, rate = _BITRATES[version][bitrate_i], _RATES[version][rate_i]
        length = (144 if version == 3 else 72) * kbps * 1000 // rate + padding
        if raw[pos + 4:pos + 40].find(b"Xing") >= 0 or raw[pos + 4:pos + 40].find(b"Info") >= 0:
            notes.append("Xing/Info header frame")
        frames.append((version, kbps, rate, mode == 3))
        pos += length
    if pos > len(raw):
        notes.append("last frame is truncated")
    return frames, notes


def decode_mp3(raw: bytes, rate: int) -> tuple[np.ndarray, str]:
    """Decode with ffmpeg to mono int16 at ``rate``. Returns (samples, decoder messages)."""
    run = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-f", "mp3", "-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le",
         "-ac", "1", "-ar", str(rate), "pipe:1"],
        input=raw, capture_output=True, check=False)
    return np.frombuffer(run.stdout[: len(run.stdout) // 2 * 2], dtype="<i2"), run.stderr.decode("utf-8", "replace").strip()


def check_mp3(path: Path, rate: int, kbps: int, peak_db: float, seconds: float, edge_fade: float) -> Report:
    """MPEG-2 Layer III, mono, ``rate`` Hz, constant ``kbps``; decodes cleanly; quiet at both ends."""
    rep = Report(path.name)
    bad = rep.problems.append
    if not path.is_file():
        bad("file missing")
        return rep
    raw = path.read_bytes()
    rep.size = len(raw)
    frames, notes = mp3_frames(raw)
    for note in notes:
        bad(note)
    if not frames:
        bad("no MPEG audio frames")
        return rep
    kinds = sorted(set(frames))
    if kinds != [(2, kbps, rate, True)]:
        bad("frames are not all MPEG-2 Layer III mono %d Hz at %d kbps: %s" % (rate, kbps, kinds[:4]))
    if shutil.which("ffprobe"):
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels",
                                "-of", "json", str(path)], capture_output=True, check=False)
        try:
            stream = json.loads(probe.stdout)["streams"][0]
            got = (stream.get("codec_name"), int(stream.get("sample_rate", 0)), int(stream.get("channels", 0)))
            if got != ("mp3", rate, 1):
                bad(f"ffprobe reads {got}")
        except (ValueError, KeyError, IndexError):
            bad("ffprobe cannot read it")
    pcm, messages = decode_mp3(raw, rate)
    if messages:
        bad("ffmpeg decoder: " + messages.splitlines()[0])
    if len(pcm) == 0:
        bad("decodes to nothing")
        return rep

    x = _measure(rep, pcm, rate, None)
    if abs(rep.ms / 1000.0 - seconds) > 0.25:
        bad(f"duration {rep.ms / 1000.0:.2f} s, expected about {seconds:.2f}")
    if abs(rep.peak_db - peak_db) > 0.6:
        bad(f"decoded peak {rep.peak_db:.2f} dBFS, expected about {peak_db:.1f}")
    if int(np.max(np.abs(pcm.astype(np.int32)))) >= 32767:
        bad("clipped (full-scale samples)")
    if rep.rms_db < -40.0:
        bad(f"nearly silent (rms {rep.rms_db:.1f} dBFS)")
    if abs(rep.dc) > 0.003:
        bad(f"DC offset {rep.dc:+.4f} of full scale")
    edge = int(0.1 * rate)
    for label, part in (("start", x[:edge]), ("end", x[-edge:])):
        level = db(math.sqrt(float(np.mean(part * part))))
        if level > -45.0:
            bad(f"{label} of the loop is not near silence ({level:.1f} dBFS in the outer 100 ms)")
    body = db(math.sqrt(float(np.mean(x[int(2 * edge_fade * rate): -int(2 * edge_fade * rate)] ** 2))))
    if body < rep.rms_db - 3.0:
        bad("body of the track is quieter than its edges")
    return rep
