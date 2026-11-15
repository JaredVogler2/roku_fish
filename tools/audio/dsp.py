"""Small numpy-only synthesis toolkit for the REEFBOUND Roku audio set.

Everything here is deterministic and offline: oscillators, envelopes, filters, a resampler, WAV
writing and a few measurement helpers. No scipy, no samples -- sound is built from sines and noise.

The pieces a sound designer touches most are on :class:`Synth`, the scratch canvas each effect in
``sfx.py`` draws on (``s.osc``, ``s.sweep``, ``s.perc``, ``s.bp`` ...). Effects are rendered
oversampled and then decimated, so glides, FM and bright harmonics never alias.
"""
from __future__ import annotations

import math
import struct

import numpy as np

TAU = 2.0 * math.pi


# ----------------------------------------------------------------------------- small maths
def mtof(m: float) -> float:
    """MIDI note number -> Hz (same helper as audio.ts)."""
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def db(x: float) -> float:
    """Linear amplitude -> dB (floored at -240 dB)."""
    return 20.0 * math.log10(max(float(x), 1e-12))


def undb(d: float) -> float:
    """dB -> linear amplitude."""
    return 10.0 ** (d / 20.0)


def norm(x: np.ndarray, peak: float = 1.0) -> np.ndarray:
    """Scale to a given absolute peak, so layer gains inside an effect mean what they say."""
    m = float(np.max(np.abs(x))) if len(x) else 0.0
    return x if m < 1e-12 else x * (peak / m)


def soft_clip(x: np.ndarray, drive: float) -> np.ndarray:
    """Gentle tanh saturation of a peak-normalised signal: rounds the peaks off, which thickens
    bass (more level and more harmonics for the same peak). ``drive`` ~1 is subtle, ~3 is fat."""
    return np.tanh(drive * norm(x)) / math.tanh(drive)


def fast_len(n: int) -> int:
    """Smallest 5-smooth integer >= n (keeps numpy FFTs fast for awkward lengths)."""
    n = max(1, int(n))
    best = 1 << (n - 1).bit_length()
    p5 = 1
    while p5 < best:
        p35 = p5
        while p35 < best:
            q = -(-n // p35)
            cand = p35 * (1 << (q - 1).bit_length() if q > 1 else 1)
            best = min(best, cand)
            p35 *= 3
        p5 *= 5
    return best


def raised_cos(n: int) -> np.ndarray:
    """0 -> 1 raised-cosine ramp of n samples (click-free fade shape)."""
    n = max(1, int(n))
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)


def fade_edges(x: np.ndarray, sr: int, fade_in: float, fade_out: float) -> np.ndarray:
    """Raised-cosine fade-in / fade-out in place of the first / last few milliseconds."""
    y = np.array(x, dtype=float)
    ni = min(len(y), int(round(fade_in * sr)))
    no = min(len(y), int(round(fade_out * sr)))
    if ni > 0:
        y[:ni] *= raised_cos(ni)
    if no > 0:
        y[len(y) - no:] *= raised_cos(no)[::-1]
    return y


# ----------------------------------------------------------------------------- static filters (FFT)
# Analog-prototype 2nd-order responses evaluated on the FFT grid: exact, causal, no per-sample loop.
def lp2(fc: float, q: float = 0.7071):
    return lambda f: 1.0 / (1.0 - (f / fc) ** 2 + 1j * (f / fc) / q)


def hp2(fc: float, q: float = 0.7071):
    return lambda f: -((f / fc) ** 2) / (1.0 - (f / fc) ** 2 + 1j * (f / fc) / q)


def fft_filter(x: np.ndarray, sr: int, *responses, tail: float = 0.1) -> np.ndarray:
    """Apply one or more static filter responses (callables of frequency in Hz) to x."""
    n = len(x)
    m = fast_len(n + int(tail * sr))
    spec = np.fft.rfft(x, m)
    f = np.fft.rfftfreq(m, 1.0 / sr)
    for h in responses:
        spec = spec * h(f)
    return np.fft.irfft(spec, m)[:n]


def convolve(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    """FFT convolution, output truncated to len(x) (used for the music reverb)."""
    n = len(x)
    m = fast_len(n + len(ir))
    return np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[:n]


# ----------------------------------------------------------------------------- time-varying filter
def svf(x: np.ndarray, fc, q: float, sr: int, mode: str = "lp") -> np.ndarray:
    """State-variable filter (trapezoidal / TPT form) whose cutoff may change every sample.

    Stays stable and click-free under fast sweeps, which is what the whooshes need. ``fc`` is a
    scalar or a per-sample array in Hz; ``mode`` is 'lp', 'hp' or 'bp' (0 dB peak gain).
    The recursion is a plain Python loop: fine for sub-second effects, not meant for music.
    """
    n = len(x)
    fc = np.clip(np.broadcast_to(np.asarray(fc, dtype=float), (n,)), 10.0, 0.45 * sr)
    g = np.tan(np.pi * fc / sr)
    k = 1.0 / q
    a1 = 1.0 / (1.0 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
    v1o = [0.0] * n
    v2o = [0.0] * n
    ic1 = ic2 = 0.0
    i = 0
    for x0, c1, c2, c3 in zip(x.tolist(), a1.tolist(), a2.tolist(), a3.tolist()):
        v3 = x0 - ic2
        v1 = c1 * ic1 + c2 * v3
        v2 = ic2 + c2 * ic1 + c3 * v3
        ic1 = 2.0 * v1 - ic1
        ic2 = 2.0 * v2 - ic2
        v1o[i] = v1
        v2o[i] = v2
        i += 1
    v1a = np.asarray(v1o)
    v2a = np.asarray(v2o)
    if mode == "lp":
        return v2a
    if mode == "bp":
        return k * v1a
    if mode == "hp":
        return x - k * v1a - v2a
    raise ValueError(f"unknown filter mode {mode!r}")


# ----------------------------------------------------------------------------- resampling
def decimate(x: np.ndarray, sr_in: int, sr_out: int, guard: float = 0.02) -> np.ndarray:
    """Integer-factor FFT resampler with a raised-cosine transition band ending at the new Nyquist."""
    if sr_in % sr_out:
        raise ValueError("decimate() needs an integer rate ratio")
    r = sr_in // sr_out
    if r == 1:
        return np.array(x, dtype=float)
    n_out = -(-len(x) // r)
    pad = int(guard * sr_out)                       # guard band (output samples) against wrap-around
    m = fast_len(n_out + 2 * pad)
    buf = np.zeros(m * r)
    buf[pad * r: pad * r + len(x)] = x
    spec = np.fft.rfft(buf)
    f = np.fft.rfftfreq(m * r, 1.0 / sr_in)
    f1, f2 = 0.43 * sr_out, 0.495 * sr_out
    taper = np.where(f <= f1, 1.0, np.where(f >= f2, 0.0, 0.5 + 0.5 * np.cos(np.pi * (f - f1) / (f2 - f1))))
    y = np.fft.irfft((spec * taper)[: m // 2 + 1], m) / r
    return y[pad: pad + n_out]


# ----------------------------------------------------------------------------- WAV / PCM
def to_pcm16(x: np.ndarray) -> np.ndarray:
    """Float (-1..1) -> int16, rounded, never wrapping."""
    return np.clip(np.round(x * 32767.0), -32767, 32767).astype("<i2")


def wav_bytes(pcm: np.ndarray, sr: int) -> bytes:
    """Canonical 44-byte RIFF/WAVE header (fmt + data only, PCM 16-bit mono) followed by the samples."""
    data = np.asarray(pcm, dtype="<i2").tobytes()
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(data), b"WAVE",
        b"fmt ", 16, 1, 1, sr, sr * 2, 2, 16,
        b"data", len(data),
    )
    return header + data


# ----------------------------------------------------------------------------- measurement
def a_weight(f: np.ndarray) -> np.ndarray:
    """IEC 61672 A-weighting as a linear gain (roughly how loud a band is at living-room level)."""
    f2 = np.maximum(f, 1e-3) ** 2
    ra = (12194.0 ** 2 * f2 ** 2) / ((f2 + 20.6 ** 2) * np.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194.0 ** 2))
    return ra * 10.0 ** (2.0 / 20.0)


def k_weight(f: np.ndarray) -> np.ndarray:
    """ITU-R BS.1770 K-weighting (the curve behind LUFS) as a complex gain: flat through the bass,
    +4 dB shelf above ~1.7 kHz. Roughly how loud a band is on a full-range system."""
    a = 10.0 ** (3.99984 / 40.0)
    s = 1j * f / 1681.97
    shelf = a * (a * s * s + (math.sqrt(a) / 0.7071752) * s + 1.0) / (s * s + (math.sqrt(a) / 0.7071752) * s + a)
    s = 1j * f / 38.135
    return shelf * (s * s) / (s * s + s / 0.5003 + 1.0)


def _level_db(x: np.ndarray, sr: int, weight, window: float | None) -> float:
    """Weighted level in dB re full scale: loudest ``window`` seconds, or whole-signal average if None."""
    if window is None:
        y = fft_filter(x, sr, weight, tail=0.05)
        return 10.0 * math.log10(max(float(np.mean(y * y)), 1e-24))
    w = max(1, int(window * sr))
    y = fft_filter(np.concatenate((np.zeros(w), x, np.zeros(w))), sr, weight, tail=0.05)
    c = np.concatenate(([0.0], np.cumsum(y * y)))
    return 10.0 * math.log10(max(float(((c[w:] - c[:-w]) / w).max()), 1e-24))


def loudness_db(x: np.ndarray, sr: int, window: float | None = 0.125) -> float:
    """Rough perceived level in dB re full scale, used only to balance the suggested volumes.

    It is the mean of the A-weighted and the K-weighted level of the loudest ``window`` seconds
    (whole-signal average if ``window`` is None). A-weighting discounts bass the way a small TV
    speaker does, K-weighting keeps it as a full-range system would; the mean splits the difference.
    With the 125 ms window a short tick reads quieter than a sustained tone of the same peak, as it
    does to the ear. A proxy for mixing by numbers -- not a psychoacoustic model.
    """
    return 0.5 * (_level_db(x, sr, a_weight, window) + _level_db(x, sr, k_weight, window))


# ----------------------------------------------------------------------------- the canvas
class Synth:
    """Scratch canvas for one sound: a mono float buffer at the (oversampled) render rate.

    Times are in seconds, frequencies in Hz. Oscillators are additive (a tuple of harmonic
    amplitudes), so they are band-limited by construction: harmonics above ``fmax`` fade out.
    """

    def __init__(self, dur: float, sr: int, seed: int, fmax: float | None = None):
        self.dur = dur
        self.sr = sr
        self.n = int(round(dur * sr))
        self.buf = np.zeros(self.n)
        self.rng = np.random.default_rng(seed)
        self.fmax = fmax if fmax is not None else 0.45 * sr

    # -- bookkeeping
    def samples(self, sec: float) -> int:
        return max(1, int(round(sec * self.sr)))

    def t(self, sec: float) -> np.ndarray:
        return np.arange(self.samples(sec)) / self.sr

    def add(self, x: np.ndarray, at: float = 0.0, gain: float = 1.0) -> None:
        """Mix a layer into the canvas at ``at`` seconds (anything past the end is dropped)."""
        i = int(round(at * self.sr))
        j = min(self.n, i + len(x))
        if j > i >= 0:
            self.buf[i:j] += gain * x[: j - i]

    def saturate(self, drive: float) -> None:
        """Soft-clip everything drawn so far (see soft_clip)."""
        self.buf[:] = soft_clip(self.buf, drive)

    # -- sources
    def sweep(self, f0: float, f1: float, dur: float, curve: float = 1.0, total: float | None = None) -> np.ndarray:
        """Exponential glide f0 -> f1 over ``dur`` (curve > 1 leaves most of the movement to the
        end, < 1 to the start), then held at f1 until ``total``."""
        n = self.samples(dur)
        u = (np.arange(n) / n) ** curve
        f = f0 * (f1 / f0) ** u
        if total is not None and self.samples(total) > n:
            f = np.concatenate((f, np.full(self.samples(total) - n, float(f1))))
        return f

    def phase(self, freq: np.ndarray) -> np.ndarray:
        """Running phase (radians) of a per-sample frequency track, starting at zero."""
        return TAU * (np.cumsum(freq) - freq[0]) / self.sr

    def osc(self, freq, harm=(1.0,), dur: float | None = None, spread: bool = False) -> np.ndarray:
        """Additive oscillator. ``freq`` is a scalar (needs ``dur``) or a per-sample track;
        ``harm`` lists harmonic amplitudes (1st, 2nd, ...). ``spread`` staggers the harmonic
        phases, which lowers the crest factor (more level for the same peak; used for bass)."""
        if np.isscalar(freq):
            if dur is None:
                raise ValueError("osc(): a constant frequency needs dur=")
            freq = np.full(self.samples(dur), float(freq))
        ph = self.phase(freq)
        out = np.zeros(len(ph))
        nh = len(harm)
        lo, hi = float(np.min(freq)), float(np.max(freq))
        for k, a in enumerate(harm, 1):
            if a == 0.0 or k * lo >= self.fmax:      # silent, or entirely above the band edge
                continue
            p0 = -math.pi * k * (k - 1) / nh if spread else 0.0
            part = a * np.sin(k * ph + p0)
            if k * hi > 0.92 * self.fmax:            # fade a harmonic out as it nears the band edge
                part *= np.clip((self.fmax - k * freq) / (0.08 * self.fmax), 0.0, 1.0)
            out += part
        return out

    def noise(self, dur: float) -> np.ndarray:
        """White noise (unit variance) from this sound's own seeded generator."""
        return self.rng.standard_normal(self.samples(dur))

    # -- envelopes
    def perc(self, dur: float, attack: float = 0.003, tau: float = 0.03, hold: float = 0.0) -> np.ndarray:
        """Raised-cosine attack, optional hold, then exponential decay with time constant ``tau``.
        The last few milliseconds are faded to exactly zero, so a layer that stops before its
        decay has finished never leaves a step (= a click) in the middle of a sound."""
        n = self.samples(dur)
        t = np.arange(n) / self.sr
        e = np.exp(-np.maximum(0.0, t - attack - hold) / tau)
        na = min(n, self.samples(attack))
        e[:na] *= raised_cos(na)
        nr = min(n // 4, self.samples(0.006))
        if nr > 0:
            e[n - nr:] *= raised_cos(nr)[::-1]
        return e

    def asr(self, dur: float, attack: float, release: float) -> np.ndarray:
        """Raised-cosine attack, flat sustain, raised-cosine release ending at zero."""
        n = self.samples(dur)
        e = np.ones(n)
        na = min(n, self.samples(attack))
        nr = min(n, self.samples(release))
        e[:na] *= raised_cos(na)
        e[n - nr:] *= raised_cos(nr)[::-1]
        return e

    def swell(self, dur: float, peak_at: float = 0.35) -> np.ndarray:
        """Smooth bump: sin^2 rise to the peak at ``peak_at`` (fraction of dur), cos^2 fall to zero."""
        n = self.samples(dur)
        npk = int(np.clip(round(peak_at * n), 1, n - 1))
        rise = np.sin(0.5 * np.pi * np.arange(npk) / npk) ** 2
        fall = np.cos(0.5 * np.pi * np.arange(n - npk) / (n - npk)) ** 2
        return np.concatenate((rise, fall))

    # -- filters (cutoff may be a per-sample track)
    def lp(self, x, fc, q: float = 0.7071) -> np.ndarray:
        return svf(x, fc, q, self.sr, "lp")

    def hp(self, x, fc, q: float = 0.7071) -> np.ndarray:
        return svf(x, fc, q, self.sr, "hp")

    def bp(self, x, fc, q: float = 1.0) -> np.ndarray:
        return svf(x, fc, q, self.sr, "bp")
