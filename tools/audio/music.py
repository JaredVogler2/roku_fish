"""REEFBOUND background music for Roku: two calm, loopable pad tracks with the ambience mixed in.

The web game generates its music live (``musicStep`` in audio.ts): every few seconds a new chord
of detuned triangle pads swells in over the previous one, a few random chord tones are plucked an
octave up, and a separate ambience bus adds a low current rumble, snapping-shrimp crackle and
drifting bubbles. Roku plays one pre-rendered stream, so this module bakes all of that into a
single file per mood, using the same chords, voicing and gain structure.

Loop design: roAudioPlayer loops by restarting the file, which is never gapless. Each track
therefore starts and ends in silence (1.5 s fades), every chord change is already a soft dip in
level ("breathing"), the rumble's slow swell is at its trough at both ends, and nothing is
plucked near the seam -- so the restart reads as one more breath.

Length: at 40 kbps an MP3 costs 5 kB per second and the music budget is 340 kB, so the two
tracks share about 67 s (``Track.seconds``). The chords stretch to whatever length is asked for.
"""
from __future__ import annotations

import zlib
from dataclasses import dataclass

import numpy as np

from dsp import TAU, convolve, decimate, fade_edges, fft_filter, hp2, lp2, mtof, norm, raised_cos, undb

MUSIC_RATE = 22050      # Hz, mono
OVERSAMPLE = 2          # rendered at 44.1 kHz, then decimated
SEED = 20261115
PEAK_DB = -6.0          # decoded peak of each track. roAudioPlayer has no volume control, so this
                        # is also the music-vs-effects balance: lower it if the bed masks the effects
EDGE_FADE = 1.5         # seconds of fade-in / fade-out around the loop seam

# Mirrors THEMES in audio.ts: root (MIDI), chords (semitones above the root), brightness.
THEMES = {
    "reef": dict(root=57, chords=((0, 4, 7, 11), (5, 9, 12, 16), (-3, 0, 4, 7), (7, 11, 14, 17)), tempo=7.5, bright=1.0),
    "menu": dict(root=57, chords=((0, 4, 7, 14), (-3, 4, 7, 12), (5, 9, 12, 16), (2, 5, 9, 14)), tempo=8.0, bright=1.0),
    "wreck": dict(root=50, chords=((0, 3, 7, 10), (-4, 0, 3, 7), (-2, 2, 5, 9), (-5, -2, 2, 5)), tempo=10.0, bright=0.55),
}

# Gain structure of the web mix (AudioEngine.applyVolumes with default volumes).
MUSIC_BUS = 0.55 * 0.5
AMBIENCE_BUS = 0.6 * 0.6
PAD_VOICE = 0.045       # peak of one pad oscillator
PAD_ATTACK = 2.5        # seconds
PAD_RELEASE = 2.5
PAD_OVERLAP = 2.2       # seconds a chord keeps sounding under the next one
PAD_SAG = 0.78          # level a chord has sunk to when its release starts (0.035 / 0.045 in audio.ts)
PLUCK_TOP = 93          # highest plucked note (A6, 1760 Hz): above that a soft bell turns into a 'ting'


@dataclass(frozen=True)
class Track:
    id: str                         # manifest key; the file is music_<id>.mp3
    seconds: float                  # total length; the chords stretch to fill it
    root: int                       # MIDI root of the theme
    chords: tuple                   # one tuple of semitone offsets per chord, in playing order
    bright: float                   # audio.ts 'bright': opens the pad filter and lifts the plucks
    pad_harmonics: tuple            # (harmonic number, level) pairs of one pad voice
    bass: float                     # level of an extra sine an octave under each chord's lowest note (0 = none)
    shimmer: tuple                  # faint slow-swelling sines above the pad: (chord note index, semitones up, level)
    pluck_slots: int                # evenly spaced moments per chord where a note may be plucked ...
    pluck_count: int                # ... and how many of them actually are
    pluck_gain: float               # pluck level relative to audio.ts (there they almost drown in the pad)
    pluck_tau: float                # pluck decay time constant, seconds
    reverb_rt60: float              # seconds
    reverb_wet: float
    rumble_gain: float              # scales the low current rumble
    crackle_gap: tuple              # (min, max) seconds between snapping-shrimp ticks
    crackle_gain: float
    bubble_gap: tuple               # (min, max) seconds between bubble clusters
    underwater_hz: float            # low-pass on the ambience bus


TRACKS = (
    # Sunlit lagoon + menus. I - vi - IV - ii - V7 in A, taken from the 'reef' and 'menu' themes;
    # the closing E7 leans back into the opening A major 7, so the loop restart resolves.
    Track(
        id="reef", seconds=36.9, root=57,
        chords=(THEMES["reef"]["chords"][0], THEMES["menu"]["chords"][1], THEMES["reef"]["chords"][1],
                THEMES["menu"]["chords"][3], THEMES["reef"]["chords"][3]),
        bright=1.0,
        pad_harmonics=((1, 1.0), (2, 0.10), (3, 1.0 / 9.0), (5, 1.0 / 25.0)),
        bass=0.7, shimmer=((-1, 12, 0.22), (-2, 12, 0.16)),
        pluck_slots=5, pluck_count=3, pluck_gain=2.0, pluck_tau=0.42,
        reverb_rt60=2.8, reverb_wet=0.55,
        rumble_gain=1.0, crackle_gap=(0.03, 0.15), crackle_gain=1.5, bubble_gap=(1.5, 5.5),
        underwater_hz=2600.0,
    ),
    # Twilight Wreck / deep water / night. The 'wreck' theme as written: Dm7 - Bbmaj7 - Cmaj7 - Am7,
    # low register, darker filter, fewer and longer notes, more space.
    Track(
        id="deep", seconds=30.4, root=50,
        chords=THEMES["wreck"]["chords"],
        bright=0.55,
        pad_harmonics=((1, 1.0), (2, 0.30), (3, 0.14), (4, 0.06), (5, 0.04)),
        bass=0.0, shimmer=((-1, 24, 0.10),),
        pluck_slots=4, pluck_count=2, pluck_gain=2.0, pluck_tau=0.60,
        reverb_rt60=4.0, reverb_wet=0.85,
        rumble_gain=1.25, crackle_gap=(0.06, 0.30), crackle_gain=1.0, bubble_gap=(2.5, 7.0),
        underwater_hz=2400.0,
    ),
)

BY_ID = {t.id: t for t in TRACKS}


def _rng(track: Track, layer: str) -> np.random.Generator:
    """Independent, reproducible random stream per track and layer (tweaking one never re-rolls another)."""
    return np.random.default_rng([SEED, zlib.crc32(track.id.encode()), zlib.crc32(layer.encode())])


def _smooth(u: np.ndarray) -> np.ndarray:
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


# ----------------------------------------------------------------------------- layers
def pad_layer(tr: Track, n: int, sr: int, step: float) -> np.ndarray:
    """Slowly cross-fading chords, filtered at 500 + 1400 * bright Hz as in audio.ts. Each note is a
    centre voice plus two quieter ones detuned +-7 cents, all drifting slightly: the same chorus as
    the original +-6 cent pair, but in mono a pair cancels completely on every beat, three do not."""
    rng = _rng(tr, "pad")
    out = np.zeros(n)
    seg = int(round((step + PAD_OVERLAP) * sr))
    t = np.arange(seg) / sr
    length = seg / sr
    sag = 1.0 - (1.0 - PAD_SAG) * np.clip((t - PAD_ATTACK) / (length - PAD_RELEASE - PAD_ATTACK), 0.0, 1.0)
    env = sag * _smooth(t / PAD_ATTACK) * _smooth((length - t) / PAD_RELEASE)
    tone = lp2(500.0 + 1400.0 * tr.bright, 1.0)
    for ci, chord in enumerate(tr.chords):
        # (MIDI note, detune in cents, level, harmonics, depth of a slow individual swell)
        voices = [(tr.root + k, cents, level, tr.pad_harmonics, 0.0)
                  for k in chord for cents, level in ((0.0, 1.0), (-7.0, 0.7), (7.0, 0.7))]
        if tr.bass > 0.0:
            voices.append((tr.root + chord[0] - 12, 0.0, tr.bass, ((1, 1.0), (2, 0.25)), 0.0))
        voices += [(tr.root + chord[i] + up, 0.0, level, ((1, 1.0),), 0.4) for i, up, level in tr.shimmer]
        acc = np.zeros(seg)
        for midi, cents, level, harmonics, swell in voices:
            f = mtof(midi) * 2.0 ** (cents / 1200.0)
            drift_hz = rng.uniform(0.07, 0.17)                    # each voice wanders by about +-2 cents
            beta = f * (2.0 ** (2.0 / 1200.0) - 1.0) / drift_hz
            ph = TAU * f * t + rng.uniform(0.0, TAU) + beta * np.sin(TAU * drift_hz * t + rng.uniform(0.0, TAU))
            amp = level * (1.0 + swell * np.sin(TAU * rng.uniform(0.15, 0.35) * t + rng.uniform(0.0, TAU)))
            for k, a in harmonics:
                g = a * abs(tone(k * f))
                if g > 1e-4:
                    acc += amp * g * np.sin(k * ph)
        i0 = int(round(ci * step * sr))
        m = min(seg, n - i0)
        out[i0:i0 + m] += PAD_VOICE * (env * acc)[:m]
    return out


def pluck_layer(tr: Track, n: int, sr: int, step: float) -> np.ndarray:
    """Sparse soft bell notes on chord tones an octave (sometimes two) above the pad, as in audio.ts.
    Every chord gets the same small number of notes, at loosely timed moments and on different
    chord tones, so the texture stays even and no rhythm, ostinato or tune forms."""
    rng = _rng(tr, "pluck")
    out = np.zeros(n)
    total = n / sr
    for ci, chord in enumerate(tr.chords):
        slots = sorted(int(i) for i in rng.permutation(tr.pluck_slots)[: tr.pluck_count])
        tones = [tr.root + chord[int(i)] + 12 for i in rng.permutation(len(chord))]
        for j, slot in enumerate(slots):
            midi = tones[j % len(tones)]
            if rng.random() < 0.3 and midi + 12 <= PLUCK_TOP:
                midi += 12
            at = ci * step + 0.6 + (slot + rng.uniform(-0.3, 0.3)) * (step / (tr.pluck_slots + 1))
            level = rng.uniform(0.7, 1.0)
            if at < EDGE_FADE + 0.5 or at > total - EDGE_FADE - 2.0:
                continue                                          # keep the loop seam free of events
            f = mtof(midi)
            tt = np.arange(int(min(7.0 * tr.pluck_tau, total - at) * sr)) / sr
            x = np.sin(TAU * f * tt) * np.exp(-tt / tr.pluck_tau)
            x += 0.12 * tr.bright * np.sin(TAU * 2.0 * f * tt) * np.exp(-tt / (0.5 * tr.pluck_tau))
            x += 0.06 * tr.bright * np.sin(TAU * 4.0 * f * tt) * np.exp(-tt / (0.2 * tr.pluck_tau))
            na = int(0.015 * sr)
            x[:na] *= raised_cos(na)                              # 15 ms attack: a pluck, not a click
            i0 = int(at * sr)
            out[i0:i0 + len(x)] += 0.035 * tr.bright * tr.pluck_gain * level * x
    return out


def rumble_layer(tr: Track, n: int, sr: int) -> np.ndarray:
    """Low current rumble (noise under 220 Hz, slow swell) plus a fainter, higher 'water moving' band
    so the bed is still there on small TV speakers."""
    rng = _rng(tr, "rumble")
    t = np.arange(n) / sr
    total = n / sr
    cycles = max(1, round(total * 0.075))                         # ~0.07 Hz swell, troughs at both loop ends
    low = fft_filter(rng.uniform(-1.0, 1.0, n), sr, lp2(220.0, 0.9), hp2(35.0))
    low *= 0.35 - 0.15 * np.cos(TAU * cycles * t / total)
    mid = fft_filter(rng.uniform(-1.0, 1.0, n), sr, lp2(520.0, 0.7), hp2(180.0))
    mid *= 0.10 * (1.0 + 0.35 * np.sin(TAU * (cycles + 1) * t / total + 1.0))
    return tr.rumble_gain * (low + mid)


def crackle_layer(tr: Track, n: int, sr: int) -> np.ndarray:
    """Snapping-shrimp crackle: sparse 12 ms ticks of high-passed noise at random levels."""
    rng = _rng(tr, "crackle")
    out = np.zeros(n)
    nt = int(0.012 * sr)
    tt = np.arange(nt) / sr
    env = np.exp(-np.maximum(0.0, tt - 0.004) / (0.008 / 9.2))
    env[: int(0.004 * sr)] *= raised_cos(int(0.004 * sr))
    at = 0.0
    while True:
        at += rng.uniform(*tr.crackle_gap)
        i0 = int(at * sr)
        if i0 + nt >= n:
            break
        tick = fft_filter(rng.uniform(-1.0, 1.0, nt), sr, hp2(rng.uniform(3000.0, 7000.0), 2.0), tail=0.01)
        out[i0:i0 + nt] += 0.4 * (0.05 + 0.08 * rng.random()) * tr.crackle_gain * env * tick
    return out


def bubble_layer(tr: Track, n: int, sr: int) -> np.ndarray:
    """Occasional clusters of 3-6 rising bubbles."""
    rng = _rng(tr, "bubble")
    out = np.zeros(n)
    nb = int(0.065 * sr)
    tt = np.arange(nb) / sr
    env = np.exp(-np.maximum(0.0, tt - 0.005) / (0.06 / 5.0))
    env[: int(0.005 * sr)] *= raised_cos(int(0.005 * sr))
    total = n / sr
    at = rng.uniform(1.0, 3.0)
    while at < total - EDGE_FADE - 1.0:
        level = rng.uniform(0.5, 1.0)
        for i in range(3 + int(rng.random() * 4)):
            f0 = 300.0 + rng.random() * 400.0
            f1 = 700.0 + rng.random() * 600.0
            f = f0 * (f1 / f0) ** (tt / tt[-1])
            i0 = int((at + 0.08 * i) * sr)
            if i0 + nb < n:
                out[i0:i0 + nb] += 0.05 * 0.3 * level * env * np.sin(TAU * np.cumsum(f) / sr)
        at += rng.uniform(*tr.bubble_gap)
    return out


def reverb_ir(tr: Track, sr: int) -> np.ndarray:
    """Dark, diffuse 'big water' impulse response: decaying noise, band-limited, unit energy."""
    rng = _rng(tr, "reverb")
    pre = 0.03
    n = int((pre + 1.2 * tr.reverb_rt60) * sr)
    t = np.arange(n) / sr - pre
    ir = rng.standard_normal(n) * np.exp(-6.908 * np.maximum(t, 0.0) / tr.reverb_rt60) * _smooth(t / 0.03)
    ir = fft_filter(ir, sr, lp2(900.0 + 1600.0 * tr.bright, 0.7), hp2(200.0), tail=0.05)
    return ir / np.sqrt(float(np.sum(ir * ir)))


# ----------------------------------------------------------------------------- the mix
def render(tr: Track, seconds: float | None = None) -> np.ndarray:
    """Synthesise one track and return floats at MUSIC_RATE, faded at both ends, peak at PEAK_DB."""
    sr = MUSIC_RATE * OVERSAMPLE
    total = tr.seconds if seconds is None else seconds
    n = int(round(total * sr))
    step = (total - PAD_OVERLAP) / len(tr.chords)                 # seconds from one chord to the next

    pad = MUSIC_BUS * pad_layer(tr, n, sr, step)
    plucks = MUSIC_BUS * pluck_layer(tr, n, sr, step)
    bubbles = 2.5 * AMBIENCE_BUS * bubble_layer(tr, n, sr)         # lifted a little: they have to read under the pad
    bed = AMBIENCE_BUS * (rumble_layer(tr, n, sr) + crackle_layer(tr, n, sr))
    ambience = fft_filter(bed + bubbles, sr, lp2(tr.underwater_hz, 1.05))

    wet = convolve(0.3 * pad + plucks + 0.5 * bubbles, reverb_ir(tr, sr))
    mix = pad + plucks + ambience + tr.reverb_wet * wet
    mix = fft_filter(mix, sr, lp2(7000.0), hp2(30.0))             # nothing for the MP3 encoder to waste bits on
    y = decimate(mix, sr, MUSIC_RATE)
    y = fade_edges(y, MUSIC_RATE, EDGE_FADE, EDGE_FADE)
    return norm(y, undb(PEAK_DB))
