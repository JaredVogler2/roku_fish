#!/usr/bin/env python3
"""Numeric listening test for the rendered REEFBOUND sounds.

    python3 tools/audio/analyze_audio.py            # checks channel/sounds, exits non-zero on failure

make_audio.py already proves the files are valid (format, level, size). This script asks the
other question: does each file still *sound like its design*? Since nobody can listen in a build,
it reads the rendered files back from disk and measures them: pitch contours, note sequences,
where the energy sits, how many hits there are, how the music fades and which chords it plays.

Each line is one sound: the design intent in words, the numbers measured, PASS or FAIL.
If you retune an effect on purpose, update its expectation here in the same change.
"""
from __future__ import annotations

import argparse
import math
import sys
import wave
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import music  # noqa: E402
import sfx  # noqa: E402
import verify  # noqa: E402
from dsp import db, fast_len, mtof  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[2] / "channel" / "sounds"


def semis(f1: float, f0: float) -> float:
    """Interval from f0 up to f1 in semitones."""
    return 12.0 * math.log2(max(f1, 1e-9) / max(f0, 1e-9))


def midi(f: float) -> float:
    return 69.0 + semis(f, 440.0)


class Clip:
    """One decoded sound plus the measurements the checks share."""

    def __init__(self, x: np.ndarray, sr: int):
        self.x = x
        self.sr = sr
        self.dur = len(x) / sr
        self.peak = float(np.max(np.abs(x)))
        self._spec: dict = {}

    def spec(self, win: float = 0.016, hop: float = 0.004):
        """Magnitude spectrogram (frames x bins), bin frequencies, frame times."""
        key = (win, hop)
        if key not in self._spec:
            nw, nh = int(win * self.sr), int(hop * self.sr)
            nfft = max(4096, fast_len(4 * nw))
            pad = np.concatenate((np.zeros(nw // 2), self.x, np.zeros(nw)))
            frames = 1 + len(self.x) // nh
            idx = np.arange(nw)[None, :] + nh * np.arange(frames)[:, None]
            mag = np.abs(np.fft.rfft(pad[idx] * np.hanning(nw), nfft, axis=1))
            self._spec[key] = (mag, np.fft.rfftfreq(nfft, 1.0 / self.sr), np.arange(frames) * nh / self.sr)
        return self._spec[key]

    def _span(self, a: float, b: float, win: float):
        mag, f, t = self.spec(win)
        rows = (t >= a * self.dur) & (t <= b * self.dur)
        return mag[rows], f

    def pitch(self, lo: float, hi: float, a: float = 0.0, b: float = 1.0, win: float = 0.016) -> float:
        """Strongest frequency between lo..hi Hz, energy-weighted over the fraction a..b of the clip."""
        mag, f = self._span(a, b, win)
        band = (f >= lo) & (f <= hi)
        sub = mag[:, band]
        k = np.argmax(sub, axis=1)
        w = sub[np.arange(len(k)), k] ** 2
        return float(np.sum(f[band][k] * w) / max(float(np.sum(w)), 1e-30))

    def centroid(self, a: float = 0.0, b: float = 1.0) -> float:
        """Spectral centre of gravity (Hz) over the fraction a..b of the clip."""
        mag, f = self._span(a, b, 0.016)
        p = np.sum(mag ** 2, axis=0)
        return float(np.sum(p * f) / max(float(np.sum(p)), 1e-30))

    def share(self, lo: float, hi: float, a: float = 0.0, b: float = 1.0) -> float:
        """Fraction of the energy that lies between lo..hi Hz (over the fraction a..b of the clip)."""
        mag, f = self._span(a, b, 0.016)
        p = np.sum(mag ** 2, axis=0)
        return float(np.sum(p[(f >= lo) & (f <= hi)]) / max(float(np.sum(p)), 1e-30))

    def hits(self, lo: float = 100.0, hi: float = 7000.0, thresh: float = 0.25, gap: float = 0.03,
             win: float = 0.016) -> list:
        """Onset times (s): peaks of the positive spectral flux between lo..hi Hz. Bass needs a
        window longer than its pitch period (win=0.05), or every cycle looks like a hit."""
        mag, f, t = self.spec(win, win / 4.0)
        sub = mag[:, (f >= lo) & (f <= hi)]
        flux = np.maximum(np.diff(sub, axis=0, prepend=np.zeros((1, sub.shape[1]))), 0.0).sum(axis=1)
        flux = flux / max(float(flux.max()), 1e-30)
        out: list = []
        for i in np.argsort(-flux):
            if flux[i] < thresh:
                break
            if all(abs(t[i] - u) >= gap for u in out):
                out.append(float(t[i]))
        return sorted(out)

    def notes(self, lo: float, hi: float, thresh: float = 0.25, gap: float = 0.03, settle: float = 0.028,
              win: float = 0.016) -> list:
        """MIDI pitch of whatever *appears* at each onset: the peak of the spectrum that is new
        ``settle`` seconds after the hit compared with just before it. Low notes that follow each
        other closely need the longer window (win=0.032) to be told apart."""
        mag, f, t = self.spec(win)
        band = (f >= lo) & (f <= hi)
        out = []
        for at in self.hits(lo, hi, thresh, gap):
            after = mag[min(len(t) - 1, int(np.searchsorted(t, at + settle)))]
            i0 = int(np.searchsorted(t, at - 0.75 * win))
            before = mag[i0] if at >= win and i0 >= 0 else np.zeros_like(after)
            new = np.maximum(after - before, 0.0)[band]
            out.append(midi(float(f[band][int(np.argmax(new))])))
        return out

    def f0(self, t0: float, t1: float, lo: float, hi: float) -> float:
        """Fundamental (Hz) of the stretch t0..t1 seconds by autocorrelation -- works for bass whose
        fundamental is weaker than its harmonics."""
        seg = self.x[int(t0 * self.sr): int(t1 * self.sr)]
        seg = seg - np.mean(seg)
        ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
        lags = np.arange(int(self.sr / hi), int(self.sr / lo) + 1)
        k = int(lags[int(np.argmax(ac[lags]))])
        y0, y1, y2 = ac[k - 1], ac[k], ac[k + 1]
        k_fine = k + 0.5 * (y0 - y2) / (y0 - 2.0 * y1 + y2) if (y0 - 2.0 * y1 + y2) != 0 else k
        return self.sr / k_fine

    def tone_share(self, freqs, t0: float, t1: float, tol: float = 0.04) -> float:
        """Fraction of the 100 Hz - 2 kHz energy of the stretch t0..t1 seconds that sits within
        +-tol of the given frequencies (one long FFT, so close tones are resolved)."""
        seg = self.x[int(t0 * self.sr): int(t1 * self.sr)]
        n = fast_len(4 * len(seg))
        p = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n)) ** 2
        f = np.fft.rfftfreq(n, 1.0 / self.sr)
        hit = np.zeros(len(f), dtype=bool)
        for fr in freqs:
            hit |= np.abs(f - fr) <= tol * fr
        band = (f >= 100.0) & (f <= 2000.0)
        return float(np.sum(p[band & hit]) / max(float(np.sum(p[band])), 1e-30))

    def level(self, t0: float, t1: float) -> float:
        """RMS level in dBFS of the stretch t0..t1 seconds."""
        seg = self.x[int(t0 * self.sr): max(int(t0 * self.sr) + 1, int(t1 * self.sr))]
        return db(math.sqrt(float(np.mean(seg * seg))))


def near(got: list, want: list, tol: float = 0.6) -> bool:
    return len(got) == len(want) and all(abs(g - w) <= tol for g, w in zip(got, want))


def names(seq: list) -> str:
    return " ".join("C C# D D# E F F# G G# A A# B".split()[int(round(m)) % 12] + str(int(round(m)) // 12 - 1) for m in seq)


# ----------------------------------------------------------------------------- design checks, one per effect
# Each returns (passed, "what was measured").
def _notes_check(c: Clip, want: tuple, lo: float = 200.0, hi: float = 2200.0, **kw):
    got = c.notes(lo, hi, **kw)
    return near(got, list(want)), f"notes {names(got)} (want {names(want)})"


def _contour(c: Clip, lo: float, hi: float, a=(0.0, 0.25), b=(0.7, 1.0)):
    return semis(c.pitch(lo, hi, *b), c.pitch(lo, hi, *a))


def chk_bite(c):
    c0, c1 = c.centroid(0.0, 0.3), c.centroid(0.5, 1.0)
    return c.dur <= 0.11 and c1 < 0.8 * c0, f"centroid {c0:.0f} -> {c1:.0f} Hz"


def chk_gulp(c):
    down = _contour(c, 100, 700, (0.0, 0.15), (0.4, 0.6))
    pop0, pop1 = c.pitch(450, 2000, 0.66, 0.78), c.pitch(450, 2000, 0.82, 0.95)
    return down < -8 and pop1 > 1.3 * pop0, f"body falls {down:.1f} st, closing bubble {pop0:.0f} -> {pop1:.0f} Hz"


def chk_nibble(c):
    st = _contour(c, 300, 1200, (0.0, 0.3), (0.5, 1.0))
    return c.dur <= 0.06 and st < -2, f"{1000 * c.dur:.0f} ms, pitch {st:+.1f} st"


def chk_rising_noise(c):
    c0, c1 = c.centroid(0.0, 0.35), c.centroid(0.65, 1.0)
    return c1 > 1.25 * c0, f"centroid {c0:.0f} -> {c1:.0f} Hz"


def chk_falling_noise(c):
    c0, c1 = c.centroid(0.0, 0.35), c.centroid(0.65, 1.0)
    return c1 < 0.7 * c0 and c.share(0, 2000) > 0.75, f"centroid {c0:.0f} -> {c1:.0f} Hz, {100 * c.share(0, 2000):.0f} % below 2 kHz"


def chk_toxic(c):
    st = _contour(c, 100, 320)
    env = np.abs(c.x[: int(0.16 * c.sr)])
    n = 4096
    spec = np.abs(np.fft.rfft((env - env.mean()) * np.hanning(len(env)), n * 4))
    f = np.fft.rfftfreq(n * 4, 1.0 / c.sr)
    rough = float(f[(f >= 8) & (f <= 40)][int(np.argmax(spec[(f >= 8) & (f <= 40)]))])
    return st < -4 and 6 <= rough <= 30, f"pitch {st:+.1f} st, beating at {rough:.0f} Hz"


def chk_hurt(c):
    low = c.share(0, 700)
    burst0, burst1 = c.share(700, 3000, 0.0, 0.2), c.share(700, 3000, 0.4, 1.0)
    return c.dur <= 0.2 and low > 0.7 and burst0 > 2 * burst1, \
        f"{100 * low:.0f} % below 700 Hz; noise band {100 * burst0:.0f} % at the hit, {100 * burst1:.1f} % after"


def chk_predator(c):
    hits = c.hits(100, 900, 0.3, 0.1, win=0.05)
    f_a, f_b = c.f0(0.05, 0.19, 55, 95), c.f0(hits[-1] + 0.05, hits[-1] + 0.19, 55, 95) if len(hits) == 2 else 0.0
    step = semis(f_b, f_a)
    softer = c.level(hits[-1] + 0.04, hits[-1] + 0.14) - c.level(0.04, 0.14) if len(hits) == 2 else 0.0
    ok = len(hits) == 2 and 0.18 <= hits[1] - hits[0] <= 0.3 and 60 <= f_a <= 80 and 0.4 <= step <= 1.6 \
        and softer < -0.5 and c.share(0, 700) > 0.9 and c.centroid() < 450
    return ok, (f"{len(hits)} notes, {f_a:.1f} Hz then {f_b:.1f} Hz ({step:+.1f} st, {softer:+.1f} dB), "
                f"{100 * c.share(0, 700):.0f} % below 700 Hz, centroid {c.centroid():.0f} Hz")


def chk_death(c):
    st = semis(c.pitch(60, 420, 0.8, 1.0, 0.032), c.pitch(60, 420, 0.0, 0.1, 0.032))
    bubbles = c.notes(700, 2600, 0.3, 0.05, 0.012)
    rising = sum(1 for a, b in zip(bubbles, bubbles[1:]) if b > a)
    return st < -15 and len(bubbles) >= 5 and rising >= len(bubbles) - 2, \
        f"tone falls {st:.1f} st, {len(bubbles)} bubbles, {rising} of them higher than the one before"


def chk_lowenergy(c):
    hits = c.hits(80, 2000, 0.3, 0.06, win=0.024)
    gap = hits[1] - hits[0] if len(hits) == 2 else 0.0
    softer = c.level(gap, gap + 0.05) - c.level(0.0, 0.05) if gap else 0.0
    return len(hits) == 2 and 0.09 <= gap <= 0.16 and softer < 0 and c.share(0, 1200) > 0.9, \
        f"{len(hits)} thumps {1000 * gap:.0f} ms apart, second {softer:+.1f} dB, {100 * c.share(0, 1200):.0f} % below 1.2 kHz"


def chk_blocked(c):
    hits = c.hits(100, 3000, 0.3, 0.03)
    p0, p1 = c.pitch(150, 500, 0.02, 0.4), c.pitch(150, 500, 0.52, 0.9)
    return len(hits) == 2 and p1 < 0.92 * p0, f"{len(hits)} knocks, {p0:.0f} then {p1:.0f} Hz"


def chk_discover(c):
    return _notes_check(c, (84, 91), 600, 2500)


def chk_milestone(c):
    ok, text = _notes_check(c, (64, 68, 71, 76, 80), 250, 1200, win=0.032, settle=0.036)
    bass = c.share(155, 175)
    return ok and bass > 0.02, text + f", bass E3 carries {100 * bass:.0f} % of the energy"


def chk_growth(c):
    ok, text = _notes_check(c, (67, 79), 250, 1200, settle=0.04)
    return ok, text


def chk_upgrade(c):
    ok, text = _notes_check(c, (74, 78, 81, 86, 90, 93), 400, 2200)
    glints = c.share(3000, 7000)
    return ok and 0.001 < glints < 0.1, text + f", glints {100 * glints:.1f} % of the energy"


def chk_region(c):
    air0, air1 = c.share(700, 3000, 0.15, 0.3), c.share(700, 3000, 0.4, 0.6)
    chord = c.tone_share([mtof(m) for m in (60, 67, 72)], 0.6 * c.dur, c.dur)
    return air1 > 1.5 * air0 and chord > 0.6, \
        f"whoosh opens up (700-3000 Hz share {100 * air0:.0f} -> {100 * air1:.0f} %), C4-G4-C5 carry {100 * chord:.0f} % of the tail"


def chk_escape(c):
    st = _contour(c, 400, 900, (0.0, 0.15), (0.8, 1.0))
    return -9 < st < -4, f"pitch {st:+.1f} st"


def chk_pulse(c):
    st = _contour(c, 150, 1300, (0.0, 0.12), (0.5, 0.8))
    harsh, top = c.share(2000, 5000), c.share(4000, 8000)
    return st < -12 and harsh < 0.12 and top < 0.02, f"zap falls {st:.1f} st; {100 * harsh:.1f} % of energy at 2-5 kHz, {100 * top:.2f} % above 4 kHz"


def chk_sonic(c):
    f_a, f_b = c.f0(0.0, 0.06, 60, 220), c.f0(0.2, 0.3, 35, 120)
    return semis(f_b, f_a) < -12 and c.share(0, 700) > 0.85, \
        f"pitch {f_a:.0f} -> {f_b:.0f} Hz, {100 * c.share(0, 700):.0f} % below 700 Hz"


def chk_sting(c):
    st = _contour(c, 700, 2000)
    return c.dur <= 0.07 and st < -4, f"{1000 * c.dur:.0f} ms, zip {st:+.1f} st"


def chk_inflate(c):
    st = _contour(c, 120, 800, (0.0, 0.15), (0.85, 1.0))
    return st > 12, f"pitch {st:+.1f} st"


def chk_spines(c):
    got = c.notes(1500, 5000, 0.3, 0.015, 0.008)
    return len(got) == 3 and got[0] < got[1] < got[2], f"{len(got)} ticks at {' '.join(f'{mtof(m):.0f}' for m in got)} Hz"


def chk_lure(c):
    st = _contour(c, 900, 1600, (0.1, 0.3), (0.7, 0.95))
    return -2.6 < st < -0.8, f"pitch {st:+.1f} st"


def chk_illuminate(c):
    st = _contour(c, 1400, 2500, (0.1, 0.3), (0.7, 0.95))
    return 1.0 < st < 3.5, f"pitch {st:+.1f} st"


def chk_mimic(c):
    hits = c.hits(500, 2000, 0.3, 0.04)
    rise = [semis(c.pitch(700, 1300, a + 0.25, a + 0.4), c.pitch(700, 1300, a, a + 0.12)) for a in (0.0, 0.52)]
    echo = c.level(0.068, 0.11) - c.level(0.0, 0.042)
    return len(hits) == 2 and min(rise) > 1.0 and echo < -3, \
        f"{len(hits)} chirps rising {rise[0]:+.1f} / {rise[1]:+.1f} st, the copy {echo:+.1f} dB"


def chk_bubble(c):
    st = _contour(c, 300, 2200, (0.0, 0.2), (0.75, 1.0))
    return c.dur <= 0.07 and st > 10, f"{1000 * c.dur:.0f} ms, pitch {st:+.1f} st"


def chk_splash(c):
    c0, c1 = c.centroid(0.0, 0.12), c.centroid(0.3, 0.5)
    bubbles = [t for t in c.hits(500, 3000, 0.08, 0.04) if t > 0.45 * c.dur]
    return c0 > 1.8 * c1 and len(bubbles) >= 2, f"centroid {c0:.0f} -> {c1:.0f} Hz, then {len(bubbles)} bubbles"


def chk_ui_move(c):
    return 0.04 <= c.dur <= 0.06 and abs(db(c.peak) + 12.0) < 0.5, f"{1000 * c.dur:.0f} ms, peak {db(c.peak):.1f} dBFS"


def chk_ui_select(c):
    st = _contour(c, 400, 1200, (0.0, 0.1), (0.5, 0.9))
    return 0.09 <= c.dur <= 0.13 and st > 3, f"{1000 * c.dur:.0f} ms, pitch {st:+.1f} st"


def chk_ui_back(c):
    st = _contour(c, 250, 800, (0.0, 0.1), (0.5, 0.9))
    return 0.09 <= c.dur <= 0.13 and st < -3, f"{1000 * c.dur:.0f} ms, pitch {st:+.1f} st"


def chk_ui_error(c):
    hits = c.hits(100, 3000, 0.3, 0.05)
    p0, p1 = c.pitch(150, 400, 0.05, 0.4), c.pitch(150, 400, 0.58, 0.9)
    return len(hits) == 2 and 0.14 <= c.dur <= 0.2 and -1.6 < semis(p1, p0) < -0.4, \
        f"{len(hits)} pulses, {p0:.0f} then {p1:.0f} Hz, {1000 * c.dur:.0f} ms"


CHECKS = {
    "bite": ("short crunch that drops in pitch", chk_bite),
    "gulp": ("pitch falls, then a rising bubble closes it", chk_gulp),
    "nibble": ("tiny falling peck", chk_nibble),
    "miss": ("upward swish", chk_rising_noise),
    "toxic": ("sagging, beating dissonance", chk_toxic),
    "hurt": ("dull thud with a short noise burst", chk_hurt),
    "heal": ("E major arpeggio, rising", lambda c: _notes_check(c, (76, 80, 83, 88), 400, 2000)),
    "cleaning": ("three-note twinkle: high, low, higher", lambda c: _notes_check(c, (84, 79, 88), 500, 2000)),
    "milestone": ("five rising notes over a bass note", chk_milestone),
    "discover": ("two pings a fifth apart", chk_discover),
    "predator": ("two low notes, the second a semitone up and softer", chk_predator),
    "escape": ("falling two-note sigh", chk_escape),
    "ink": ("dark puff that closes down", chk_falling_noise),
    "pulse": ("falling zap without harsh highs", chk_pulse),
    "sonic": ("deep boom that plunges", chk_sonic),
    "sting": ("very short falling zip", chk_sting),
    "inflate": ("rising 'bwoop'", chk_inflate),
    "spines": ("three ticks stepping upward", chk_spines),
    "sprint": ("rising rush", chk_rising_noise),
    "lure": ("soft tone sinking a whole step", chk_lure),
    "stage": ("eight-note G major flourish",
              lambda c: _notes_check(c, (67, 71, 74, 79, 74, 79, 83, 86), 300, 1500, win=0.032)),
    "death": ("descending tone with rising bubbles", chk_death),
    "lowenergy": ("heartbeat: two low thumps", chk_lowenergy),
    "bubble": ("one rising bloop", chk_bubble),
    "blocked": ("two falling knocks", chk_blocked),
    "region": ("opening whoosh into an open fifth", chk_region),
    "mimic": ("rising chirp and its quieter copy", chk_mimic),
    "camo": ("light hush that fades down", chk_falling_noise),
    "illuminate": ("high glow rising a minor third", chk_illuminate),
    "ui_move": ("40-60 ms tick, quiet", chk_ui_move),
    "ui_select": ("rising bloop, ~120 ms", chk_ui_select),
    "ui_back": ("falling bloop, ~120 ms", chk_ui_back),
    "ui_error": ("two low pulses, second a semitone down", chk_ui_error),
    "growth": ("two chirps an octave apart, rising", chk_growth),
    "upgrade": ("sparkly six-note D major arpeggio", chk_upgrade),
    "splash": ("bright slap that muffles, then bubbles", chk_splash),
}


def chk_common(c: Clip):
    """What every effect must satisfy: no DC offset, no dead air, a soft first millisecond, no fizz.
    Returns (passed, (|dc|, leading silence ms, trailing silence ms, first-ms level / peak, share above 5 kHz))."""
    dc = abs(float(np.mean(c.x)))
    live = np.nonzero(np.abs(c.x) >= c.peak * 10.0 ** (-50.0 / 20.0))[0]
    head, tail = 1000.0 * live[0] / c.sr, 1000.0 * (len(c.x) - 1 - live[-1]) / c.sr
    first_ms = float(np.max(np.abs(c.x[: c.sr // 1000]))) / c.peak
    fizz = c.share(5000, 8000)
    return dc < 0.003 and head < 5 and tail < 12 and first_ms < 0.5 and fizz < 0.12, (dc, head, tail, first_ms, fizz)


def common_text(m: tuple) -> str:
    return (f"DC {m[0]:.4f} of full scale, {m[1]:.1f} ms silent head, {m[2]:.1f} ms silent tail, "
            f"first ms at {100 * m[3]:.0f} % of peak, {100 * m[4]:.1f} % of energy above 5 kHz")


# ----------------------------------------------------------------------------- music
def chk_music(tr: music.Track, c: Clip) -> list:
    """Loop seam, calm dynamics and the chords each track claims to play."""
    out = []
    edges = max(c.level(0.0, 0.1), c.level(c.dur - 0.1, c.dur))
    ramp_in = c.level(0.2, 0.7) < c.level(0.9, 1.5) < c.level(3.0, 6.0) + 3
    ramp_out = c.level(c.dur - 0.7, c.dur - 0.2) < c.level(c.dur - 1.5, c.dur - 0.9) < c.level(c.dur - 6.0, c.dur - 3.0) + 3
    out.append(("fades to near silence at both ends", edges < -50 and ramp_in and ramp_out,
                f"outer 100 ms at {edges:.0f} dBFS, fade in {c.level(0.2, 0.7):.0f} -> {c.level(0.9, 1.5):.0f} dB, "
                f"fade out {c.level(c.dur - 1.5, c.dur - 0.9):.0f} -> {c.level(c.dur - 0.7, c.dur - 0.2):.0f} dB"))

    hop = int(0.05 * c.sr)
    env = np.array([db(math.sqrt(float(np.mean(c.x[i:i + hop] ** 2)))) for i in range(0, len(c.x) - hop, hop)])
    body = env[int(3.0 / 0.05): -int(3.0 / 0.05)]
    jump = float(np.max(np.diff(body)))
    out.append(("no sharp attacks, no drop-outs", jump < 6.0 and float(body.max() - body.min()) < 14.0,
                f"largest 50 ms level jump {jump:+.1f} dB, body level range {body.max() - body.min():.1f} dB"))

    step = (c.dur - music.PAD_OVERLAP) / len(tr.chords)             # as rendered, whatever length was asked for
    shares = []
    for i, chord in enumerate(tr.chords):
        seg = c.x[int((i * step + 3.2) * c.sr): int(((i + 1) * step - 0.2) * c.sr)]
        n = fast_len(len(seg))
        p = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n)) ** 2
        f = np.fft.rfftfreq(n, 1.0 / c.sr)
        band = (f >= 95.0) & (f <= 1300.0)
        note = 69.0 + 12.0 * np.log2(f[band] / 440.0)
        tonal = np.abs(note - np.round(note)) < 0.3                       # energy sitting on a semitone at all
        pcs = np.mod(np.round(note), 12).astype(int)
        want = sorted({(tr.root + k) % 12 for k in chord})
        shares.append(float(np.sum(p[band][tonal & np.isin(pcs, want)]) / np.sum(p[band][tonal])))
    out.append((f"plays its {len(tr.chords)} chords", min(shares) > 0.75,
                "chord tones carry " + " / ".join(f"{100 * s:.0f}" for s in shares) + " % of the tonal energy"))
    return out


# ----------------------------------------------------------------------------- driver
def load_wav(path: Path) -> Clip:
    with wave.open(str(path), "rb") as wf:
        return Clip(np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2") / 32768.0, wf.getframerate())


def main() -> int:
    ap = argparse.ArgumentParser(description="Check that the rendered sounds match their design.")
    ap.add_argument("--out", type=Path, default=OUT_DIR, help="folder with the rendered files (default: channel/sounds)")
    args = ap.parse_args()
    failures = 0

    def report(name: str, intent: str, ok: bool, text: str) -> None:
        nonlocal failures
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  {name:<11} {intent}: {text}")

    clips = {}
    common = []
    for e in sfx.SFX:
        path = args.out / f"{e.id}.wav"
        if not path.is_file():
            report(e.id, "file", False, "missing")
            continue
        clips[e.id] = c = load_wav(path)
        intent, fn = CHECKS[e.id]
        try:
            ok, text = fn(c)
        except (IndexError, ValueError, ZeroDivisionError) as exc:      # a broken sound must fail, not crash the run
            ok, text = False, f"could not be measured ({exc})"
        report(e.id, intent, ok, text)
        ok, metrics = chk_common(c)
        common.append(metrics)
        if not ok:
            report(e.id, "no DC, no dead air, soft start, no fizz", False, common_text(metrics))
    if "ui_select" in clips and "ui_back" in clips:
        hi_f, lo_f = clips["ui_select"].pitch(200, 2000), clips["ui_back"].pitch(200, 2000)
        report("ui_back", "lower than ui_select", lo_f < 0.8 * hi_f, f"{lo_f:.0f} Hz vs {hi_f:.0f} Hz")
    if common:
        print(f"      worst case over the {len(common)} effects: " + common_text(tuple(max(col) for col in zip(*common))))

    tracks = {}
    for tr in music.TRACKS:
        path = args.out / f"music_{tr.id}.mp3"
        if not path.is_file():
            report(path.name, "file", False, "missing")
            continue
        pcm, _messages = verify.decode_mp3(path.read_bytes(), music.MUSIC_RATE)
        tracks[tr.id] = c = Clip(pcm / 32768.0, music.MUSIC_RATE)
        for intent, ok, text in chk_music(tr, c):
            report(f"music_{tr.id}", intent, ok, text)
    if len(tracks) == 2:
        reef, deep = tracks["reef"], tracks["deep"]
        r_c, d_c = reef.centroid(0.1, 0.9), deep.centroid(0.1, 0.9)
        r_hi, d_hi = reef.share(700, 11000, 0.1, 0.9), deep.share(700, 11000, 0.1, 0.9)
        report("music_deep", "darker and lower than music_reef", d_c < 0.8 * r_c and d_hi < 0.6 * r_hi,
               f"centroid {d_c:.0f} vs {r_c:.0f} Hz, energy above 700 Hz {100 * d_hi:.1f} % vs {100 * r_hi:.1f} %")

    print()
    print("all design checks passed" if not failures else f"{failures} design check(s) FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
