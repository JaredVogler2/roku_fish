"""REEFBOUND sound effects for Roku: one small function per effect, plus the registry.

Each function draws layers on a :class:`dsp.Synth` canvas ``s`` whose length is the effect's
byte budget (a 16 kHz / 16-bit mono WAV costs 32 kB per second, so every 10 ms matters).
The recipes follow the Web Audio originals in ``REEFBOUND/src/game/audio/audio.ts`` -- same
gestures, same notes -- but rounder and wetter for a TV in a living room:

* tones are sines with a few soft harmonics instead of raw saw/square/triangle oscillators;
* every layer fades in and out on a raised cosine (a few milliseconds), never a hard edge;
* notes get a tiny upward pitch 'scoop' at the onset (the water-drop "bloop");
* bass effects carry their pitch in harmonics 2-6 and are gently saturated, because TV speakers
  lose most of what lies below ~120 Hz -- the original's pure 70 Hz 'predator' would barely be heard.

To tweak a sound, edit its function (shape) or its row in ``SFX`` (length, volume, tone), run
``make_audio.py`` and then ``analyze_audio.py``, which holds the numeric description of every effect.
"""
from __future__ import annotations

import zlib
from dataclasses import dataclass
from typing import Callable

import numpy as np

from dsp import TAU, Synth, decimate, fade_edges, fft_filter, hp2, lp2, mtof, norm, raised_cos, undb

SFX_RATE = 16000        # Hz, what roAudioResource gets
OVERSAMPLE = 4          # effects are rendered at 64 kHz and decimated (alias-free glides and FM)
SEED = 20261115         # change to re-roll every noise burst at once

# Harmonic recipes for Synth.osc(): amplitudes of the 1st, 2nd, 3rd ... harmonic.
SINE = (1.0,)
SOFT = (1.0, 0.22, 0.07)                                    # sine with a little warmth -- the default 'bloop'
TRI = (1.0, 0.0, 0.111, 0.0, 0.04)                          # triangle-like (odd harmonics falling as 1/n^2)
SQR = (1.0, 0.0, 0.28, 0.0, 0.11, 0.0, 0.04)                # rounded square: hollow, not buzzy
BUZZ = tuple(1.0 / k ** 1.2 for k in range(1, 13))          # soft sawtooth
BOOM = (1.0, 0.7, 0.5, 0.35, 0.22, 0.12)                    # bass with enough overtones for small speakers
GROWL = (0.45, 0.8, 1.0, 0.9, 0.7, 0.5, 0.32, 0.2, 0.12)    # low pitch carried by harmonics 2-6 (dark, reedy)


# ----------------------------------------------------------------------------- building blocks
def note(s: Synth, freq: float, dur: float, tau: float, harm=SOFT, scoop: float = 0.0,
         attack: float = 0.005, glide_to: float | None = None) -> np.ndarray:
    """A plain pitched note with exponential decay. ``scoop`` (semitones) starts it flat and lets
    it rise into pitch within ~25 ms; ``glide_to`` bends it to another pitch over its length."""
    t = s.t(dur)
    f = np.full(len(t), float(freq)) if glide_to is None else s.sweep(freq, glide_to, dur)
    if scoop:
        f = f * 2.0 ** (-(scoop / 12.0) * np.exp(-t / 0.012))
    return s.osc(f, harm) * s.perc(dur, attack, tau)


# (frequency ratio, level, decay relative to the fundamental): a small soft bell.
CHIME_PARTIALS = ((1.0, 1.0, 1.0), (2.0, 0.30, 0.6), (3.0, 0.10, 0.4), (4.2, 0.07, 0.25))


def chime(s: Synth, freq: float, dur: float, tau: float, bright: float = 1.0, scoop: float = 1.0,
          attack: float = 0.005) -> np.ndarray:
    """Soft bell note: a sine plus quickly-dying upper partials (``bright`` scales them)."""
    t = s.t(dur)
    ph = s.phase(freq * 2.0 ** (-(scoop / 12.0) * np.exp(-t / 0.012)))
    out = np.zeros(len(t))
    for ratio, level, decay in CHIME_PARTIALS:
        if ratio * freq < 0.95 * s.fmax:
            out += (level if ratio == 1.0 else level * bright) * np.sin(ratio * ph) * np.exp(-t / (tau * decay))
    na = min(len(t), s.samples(attack))
    out[:na] *= raised_cos(na)
    nr = min(len(t) // 4, s.samples(0.006))
    out[len(t) - nr:] *= raised_cos(nr)[::-1]                     # end at zero even if cut short
    return out


def blip(s: Synth, f0: float, f1: float, dur: float, tau: float | None = None, attack: float = 0.003,
         harm=SOFT, curve: float = 1.0) -> np.ndarray:
    """The basic watery unit: a short sine whose pitch glides f0 -> f1 (rising = a bubble)."""
    return s.osc(s.sweep(f0, f1, dur, curve), harm) * s.perc(dur, attack, dur / 4.5 if tau is None else tau)


def burst(s: Synth, dur: float, fc: float, q: float, tau: float, attack: float = 0.002,
          mode: str = "bp", f_end: float | None = None) -> np.ndarray:
    """Filtered noise hit with a percussive envelope; ``f_end`` sweeps the filter."""
    f = fc if f_end is None else s.sweep(fc, f_end, dur)
    x = s.noise(dur)
    y = {"bp": s.bp, "lp": s.lp, "hp": s.hp}[mode](x, f, q)
    return y * s.perc(dur, attack, tau)


def whoosh(s: Synth, dur: float, f0: float, f1: float, q: float = 1.2, mode: str = "bp",
           peak_at: float = 0.35, curve: float = 1.0) -> np.ndarray:
    """Noise through a sweeping filter under a smooth swell: water rushing past."""
    x = s.noise(dur)
    y = {"bp": s.bp, "lp": s.lp, "hp": s.hp}[mode](x, s.sweep(f0, f1, dur, curve), q)
    return y * s.swell(dur, peak_at)


def thump(s: Synth, f0: float, f1: float, dur: float, tau: float, glide: float | None = None,
          harm=BOOM, attack: float = 0.004, hold: float = 0.0, spread: bool = True) -> np.ndarray:
    """Low pitched hit whose frequency drops f0 -> f1 (within ``glide`` seconds)."""
    f = s.sweep(f0, f1, dur if glide is None else glide, total=dur)
    return s.osc(f, harm, spread=spread) * s.perc(dur, attack, tau, hold)


# ----------------------------------------------------------------------------- feeding
def bite(s: Synth) -> None:
    """Crunchy chomp: a down-swept noise crunch, a tiny tooth click and a falling 'thock'."""
    d = s.dur
    s.add(norm(burst(s, d, 1400.0, 1.2, tau=0.026, f_end=420.0)), gain=1.0)
    s.add(norm(burst(s, 0.03, 2500.0, 2.0, tau=0.004, attack=0.001)), gain=0.20)
    s.add(norm(thump(s, 340.0, 160.0, d, tau=0.028, glide=0.07, harm=TRI, attack=0.003, spread=False)), gain=0.60)
    s.saturate(2.2)


def gulp(s: Synth) -> None:
    """Swallow: the pitch drops down the throat, a little wet noise, then a closing bubble."""
    s.add(norm(thump(s, 420.0, 130.0, 0.15, tau=0.045, glide=0.13, harm=(1.0, 0.5, 0.3, 0.15), attack=0.005, spread=False)), gain=1.0)
    s.add(norm(burst(s, 0.11, 900.0, 2.2, tau=0.028, attack=0.004, f_end=300.0)), at=0.018, gain=0.35)
    s.add(norm(blip(s, 600.0, 1500.0, 0.06, tau=0.015)), at=0.118, gain=0.7)


def nibble(s: Synth) -> None:
    """Tiny peck: a falling blip with a grain of noise on top."""
    d = s.dur
    s.add(norm(burst(s, d, 1900.0, 3.0, tau=0.007, attack=0.001)), gain=0.40)
    s.add(norm(blip(s, 700.0, 430.0, d, tau=0.011, attack=0.002)), gain=0.80)


def miss(s: Synth) -> None:
    """Jaws closing on water: a quick, slightly resonant upward swish."""
    s.add(norm(whoosh(s, s.dur, 450.0, 2600.0, q=2.2, peak_at=0.4)))


def toxic(s: Synth) -> None:
    """Something poisonous: two soft saws a semitone apart sag in pitch and beat, with a fizz."""
    d = s.dur
    t = s.t(d)
    pair = s.osc(s.sweep(233.0, 150.0, d), BUZZ) + 0.9 * s.osc(s.sweep(247.0, 139.0, d), BUZZ)
    sick = s.lp(pair, 2200.0, 0.8) * (1.0 + 0.3 * np.sin(TAU * 19.0 * t)) * s.perc(d, 0.010, 0.085)
    s.add(norm(sick), gain=1.0)
    s.add(norm(burst(s, 0.15, 1100.0, 4.0, tau=0.050, attack=0.004, f_end=420.0)), at=0.03, gain=0.40)
    s.saturate(1.2)


# ----------------------------------------------------------------------------- damage / danger
def hurt(s: Synth) -> None:
    """Dull thud with a short low noise burst."""
    d = s.dur
    s.add(norm(thump(s, 200.0, 70.0, d, tau=0.045, glide=0.11, attack=0.003)), gain=1.0)
    s.add(norm(burst(s, 0.12, 1500.0, 0.8, tau=0.028, attack=0.002, mode="lp", f_end=300.0)), gain=0.8)
    s.saturate(1.5)


def predator(s: Synth) -> None:
    """Low ominous two-note warning: two dark, sagging notes (D2, then Eb2), the second softer.
    Their pitch lives in harmonics 2-6 (150-450 Hz), so it survives TV speakers."""
    s.add(thump(s, 73.4, 65.4, 0.235, tau=0.05, attack=0.025, hold=0.11, harm=GROWL), gain=1.0)
    s.add(thump(s, 77.8, 69.3, s.dur - 0.225, tau=0.06, attack=0.025, hold=0.10, harm=GROWL), at=0.225, gain=0.85)
    s.saturate(1.5)


def death(s: Synth) -> None:
    """Descending, slightly wobbling tone while a string of bubbles rises away."""
    d = s.dur
    t = s.t(d)
    f = s.sweep(300.0, 78.0, d) * (1.0 + 0.015 * np.sin(TAU * 7.0 * t))
    s.add(norm(s.osc(f, (1.0, 0.40, 0.18, 0.08)) * s.perc(d, 0.020, 0.30)), gain=1.0)
    for i in range(6):
        s.add(blip(s, 500.0 + 120.0 * i, 900.0 + 150.0 * i, 0.055, tau=0.014), at=0.08 + 0.082 * i, gain=0.28)


def lowenergy(s: Synth) -> None:
    """Heartbeat 'lub-dub': two soft low thumps, the second weaker, each with a muffled knock
    (the knock is what a small speaker actually plays)."""
    for at, f0, tau, g in ((0.0, 165.0, 0.030, 1.0), (0.125, 195.0, 0.024, 0.8)):
        s.add(norm(thump(s, f0, 0.58 * f0, 0.095, tau=tau, glide=0.07, attack=0.004)), at=at, gain=g)
        s.add(norm(burst(s, 0.03, 500.0, 0.9, tau=0.008, mode="lp")), at=at, gain=0.4 * g)
        s.add(norm(burst(s, 0.04, 1100.0, 2.0, tau=0.009)), at=at, gain=0.7 * g)
    s.saturate(1.5)


def blocked(s: Synth) -> None:
    """Bumping into something: two muted, falling knocks."""
    for at, f0, f1, g in ((0.0, 311.0, 262.0, 1.0), (0.055, 247.0, 208.0, 0.9)):
        s.add(norm(note(s, f0, 0.058, tau=0.017, harm=SQR, glide_to=f1, attack=0.003)), at=at, gain=g)
        s.add(norm(burst(s, 0.03, 1200.0, 1.5, tau=0.007)), at=at, gain=0.4 * g)


# ----------------------------------------------------------------------------- rewards
def heal(s: Synth) -> None:
    """Gentle sparkle: four glassy notes climbing an E major arpeggio."""
    for i, m in enumerate((76, 80, 83, 88)):
        at = 0.043 * i
        s.add(chime(s, mtof(m), s.dur - at, tau=0.075, bright=0.45, scoop=0.6, attack=0.008), at=at, gain=0.55 + 0.08 * i)


def cleaning(s: Synth) -> None:
    """Cleaner-station twinkle: three light notes, high - low - higher."""
    for i, m in enumerate((84, 79, 88)):
        at = 0.058 * i
        s.add(note(s, mtof(m), s.dur - at, tau=0.045, harm=TRI, scoop=0.6, attack=0.006), at=at, gain=0.8 + 0.1 * i)


def milestone(s: Synth) -> None:
    """Bright rising chime (E major, five notes) over a warm bass note."""
    d = s.dur
    for i, m in enumerate((64, 68, 71, 76, 80)):
        at = 0.055 * i
        s.add(chime(s, mtof(m), d - at, tau=0.10 + 0.02 * i, bright=1.0, scoop=1.0), at=at, gain=0.50 + 0.07 * i)
    s.add(s.osc(mtof(52), (1.0, 0.5, 0.2), dur=d) * s.asr(d, 0.03, 0.22), gain=0.40)


def discover(s: Synth) -> None:
    """New species: two glassy pings a fifth apart."""
    d = s.dur
    s.add(chime(s, mtof(84), d, tau=0.060, bright=0.35, scoop=0.5, attack=0.006), gain=0.8)
    s.add(chime(s, mtof(91), d - 0.085, tau=0.060, bright=0.35, scoop=0.5, attack=0.006), at=0.085, gain=1.0)


def stage(s: Synth) -> None:
    """Growth-stage fanfare: an eight-note G major flourish whose last three notes ring as a chord."""
    d = s.dur
    for i, k in enumerate((0, 4, 7, 12, 7, 12, 16, 19)):
        at = 0.045 * i
        s.add(chime(s, mtof(67 + k), d - at, tau=0.12 if i >= 5 else 0.07, bright=0.9, scoop=0.8), at=at, gain=0.50 + 0.05 * i)


def growth(s: Synth) -> None:
    """'You grew': two chirps that each swoop up into pitch, the second an octave above and ringing
    (an octave, so it cannot be mistaken for the two pings of 'discover')."""
    s.add(note(s, mtof(67), 0.11, tau=0.035, harm=SOFT, scoop=4.0, attack=0.004), gain=0.85)
    s.add(chime(s, mtof(79), s.dur - 0.10, tau=0.075, bright=0.6, scoop=4.0), at=0.10, gain=1.0)


def upgrade(s: Synth) -> None:
    """Sparkly D major arpeggio climbing two octaves, dusted with tiny high glints."""
    d = s.dur
    for i, m in enumerate((74, 78, 81, 86, 90, 93)):
        at = 0.048 * i
        s.add(chime(s, mtof(m), d - at, tau=0.09 + 0.015 * i, bright=1.2, scoop=0.6, attack=0.004), at=at, gain=0.50 + 0.06 * i)
    for _ in range(9):
        at = float(s.rng.uniform(0.06, 0.40))
        s.add(note(s, float(s.rng.uniform(3400.0, 6000.0)), 0.05, tau=0.012, harm=SINE, attack=0.002), at=at, gain=0.07)


def region(s: Synth) -> None:
    """Entering a new region: an opening whoosh with a soft open-fifth chord blooming inside it."""
    d = s.dur
    s.add(norm(whoosh(s, 0.36, 240.0, 1500.0, q=1.2, peak_at=0.45)), gain=0.9)
    for i, m in enumerate((60, 67, 72)):
        at = 0.05 + 0.05 * i
        s.add(s.osc(mtof(m), (1.0, 0.3, 0.1), dur=d - at) * s.asr(d - at, 0.07, 0.13), at=at, gain=0.30)


# ----------------------------------------------------------------------------- abilities
def escape(s: Synth) -> None:
    """Relief after shaking off a predator: two soft falling notes."""
    s.add(note(s, mtof(79), 0.12, tau=0.040, harm=TRI, glide_to=mtof(74), attack=0.008), gain=1.0)
    s.add(note(s, mtof(74), s.dur - 0.095, tau=0.050, harm=TRI, glide_to=mtof(71), attack=0.008), at=0.095, gain=0.85)


def ink(s: Synth) -> None:
    """Ink cloud: a soft dark puff that closes down as it spreads."""
    d = s.dur
    env = s.swell(d, 0.14)
    s.add(norm(s.lp(s.noise(d), s.sweep(1300.0, 170.0, d), 0.9) * env), gain=1.0)
    s.add(norm(s.bp(s.noise(d), s.sweep(420.0, 140.0, d), 1.2) * env), gain=0.6)


def pulse(s: Synth) -> None:
    """Electric discharge kept gentle: a falling FM zap riding a low eel-like buzz, plus muffled sparks."""
    d = s.dur
    buzz_f = s.sweep(150.0, 95.0, d)
    zap = np.sin(s.phase(s.sweep(1100.0, 180.0, 0.10, total=d)) + 1.4 * np.sin(s.phase(buzz_f)))
    buzz = norm(s.osc(buzz_f, BUZZ, spread=True))
    s.add(norm((0.75 * zap + 0.55 * buzz) * s.perc(d, 0.002, 0.045)), gain=1.0)
    for _ in range(6):
        at = float(s.rng.uniform(0.0, 0.085))
        fc = float(s.rng.uniform(2200.0, 3000.0))
        s.add(norm(burst(s, 0.012, fc, 3.0, tau=0.002, attack=0.0005)), at=at, gain=0.14)


def sonic(s: Synth) -> None:
    """Deep boom: a pitch that plunges, with a soft pressure-wave impact at the front."""
    d = s.dur
    s.add(norm(thump(s, 160.0, 48.0, d, tau=0.10, glide=0.26, attack=0.004)), gain=1.0)
    s.add(norm(burst(s, 0.10, 1500.0, 0.8, tau=0.035, attack=0.002, mode="lp", f_end=200.0)), gain=0.8)
    s.saturate(1.5)


def sting(s: Synth) -> None:
    """A prick: a hiss-tick and a quick falling zip."""
    d = s.dur
    s.add(norm(burst(s, d, 3600.0, 4.0, tau=0.007, attack=0.001)), gain=0.5)
    s.add(norm(note(s, 1700.0, d, tau=0.012, harm=SQR, glide_to=950.0, attack=0.002)), gain=0.7)


def inflate(s: Synth) -> None:
    """Puffing up: a rubbery rising 'bwoop' with a breath of air."""
    d = s.dur
    t = s.t(d)
    f = s.sweep(185.0, 570.0, d, curve=1.3) * (1.0 + 0.012 * np.sin(TAU * 11.0 * t))
    env = s.asr(d, 0.03, 0.04)
    s.add(norm(s.osc(f, SOFT) * env), gain=1.0)
    s.add(norm(s.bp(s.noise(d), 2.0 * f, 3.0) * env), gain=0.12)


def spines(s: Synth) -> None:
    """Spines flicking out: three tiny high ticks stepping upward."""
    for i, f in enumerate((2300.0, 2900.0, 3500.0)):
        s.add(norm(note(s, 1.08 * f, 0.04, tau=0.007 + 0.003 * i, harm=TRI, glide_to=f, attack=0.0015)), at=0.022 * i, gain=0.7 + 0.15 * i)


def sprint(s: Synth) -> None:
    """Burst of speed: a rising rush of water with a low push at the start and two bubbles in its wake."""
    s.add(norm(whoosh(s, s.dur, 800.0, 3000.0, q=2.0, peak_at=0.3)), gain=1.0)
    s.add(norm(burst(s, 0.08, 350.0, 0.8, tau=0.030, attack=0.004, mode="lp")), gain=0.45)
    for at, f in ((0.095, 700.0), (0.125, 900.0)):
        s.add(blip(s, f, 1.9 * f, 0.03, tau=0.008), at=at, gain=0.16)


def lure(s: Synth) -> None:
    """Anglerfish lure: a soft, slightly shimmering tone that sinks a whole step."""
    d = s.dur
    t = s.t(d)
    f = s.sweep(mtof(88), mtof(86), d)
    s.add(s.osc(f, (1.0, 0.12)) * (1.0 + 0.22 * np.sin(TAU * 13.0 * t)) * s.swell(d, 0.3))


def mimic(s: Synth) -> None:
    """Mimicry: a quick upward chirp, immediately copied more quietly."""
    for at, g in ((0.0, 1.0), (0.068, 0.55)):
        s.add(norm(note(s, mtof(81), 0.06, tau=0.018, harm=TRI, glide_to=mtof(84), attack=0.004)), at=at, gain=g)


def camo(s: Synth) -> None:
    """Camouflage: a light hush that fades into the background."""
    d = s.dur
    s.add(norm(s.lp(s.noise(d), s.sweep(1500.0, 260.0, d), 0.8) * s.swell(d, 0.12)))


def illuminate(s: Synth) -> None:
    """Bioluminescence: a high glow that swells and rises, shimmering."""
    d = s.dur
    t = s.t(d)
    f = s.sweep(mtof(93), mtof(96), d)
    s.add(s.osc(f, (1.0, 0.15)) * (1.0 + 0.2 * np.sin(TAU * 24.0 * t)) * s.swell(d, 0.45))


# ----------------------------------------------------------------------------- water
def bubble(s: Synth) -> None:
    """A single bubble: a sine that accelerates upward."""
    s.add(blip(s, 620.0, 1650.0, s.dur, tau=0.014, curve=1.4))


def splash(s: Synth) -> None:
    """Plunging in: a surface slap, then rushing water that muffles as it closes overhead, and bubbles."""
    s.add(norm(burst(s, 0.16, 2600.0, 0.6, tau=0.035, attack=0.002)), gain=0.8)
    plunge = s.lp(s.noise(0.44), s.sweep(5000.0, 320.0, 0.32, total=0.44), 0.9) * s.perc(0.44, 0.008, 0.11)
    s.add(norm(plunge), gain=1.0)
    s.add(norm(thump(s, 170.0, 70.0, 0.20, tau=0.060, glide=0.15, harm=(1.0, 0.4, 0.15), spread=False)), at=0.02, gain=0.55)
    for at, f in ((0.23, 620.0), (0.31, 780.0), (0.385, 560.0)):
        s.add(blip(s, f, 2.1 * f, 0.05, tau=0.013), at=at, gain=0.20)


# ----------------------------------------------------------------------------- UI (dry, no underwater filter)
def ui_move(s: Synth) -> None:
    """Focus moved: a very small, soft 'plip'."""
    s.add(blip(s, 1750.0, 2100.0, s.dur, tau=0.010, attack=0.002, harm=SINE))


def ui_select(s: Synth) -> None:
    """Confirm: a rising bloop topped with a faint higher ping."""
    s.add(blip(s, 660.0, 990.0, s.dur, tau=0.030, attack=0.003, curve=0.7), gain=1.0)
    s.add(note(s, 1320.0, 0.06, tau=0.020, harm=SINE, attack=0.004), at=0.05, gain=0.5)


def ui_back(s: Synth) -> None:
    """Cancel / back: the same bloop, lower and falling."""
    s.add(blip(s, 590.0, 390.0, s.dur, tau=0.030, attack=0.003, harm=(1.0, 0.5, 0.25), curve=0.7))


def ui_error(s: Synth) -> None:
    """Denied: two flat, hollow 'uh-uh' pulses a semitone apart."""
    for at, f, g in ((0.0, 233.0, 1.0), (0.088, 220.0, 0.9)):
        s.add(s.osc(f, (1.0, 0.0, 0.4, 0.0, 0.18, 0.0, 0.07), dur=0.078) * s.asr(0.078, 0.006, 0.03), at=at, gain=g)


# ----------------------------------------------------------------------------- registry
@dataclass(frozen=True)
class Sfx:
    id: str                       # file is <id>.wav
    fn: Callable[[Synth], None]
    dur: float                    # canvas length in seconds = upper bound on the file length
    vol: int                      # suggested roAudioResource.Trigger() volume, 0-100
    lp: float | None = 4000.0     # 'underwater' low-pass in Hz (None = dry, like the UI bus in the web game)
    release: float = 0.012        # raised-cosine damping of the tail, seconds
    peak_db: float = -3.0         # file peak level, dBFS


# The volumes are a mix made by numbers, not by ear. make_audio.py prints 'loud', a perceived-level
# proxy, for every file; vol (a linear gain, vol / 100) brings each effect to one of four levels at
# playback, shown in the '@vol' column:
#   about -14.5   big moments     predator, death, stage, milestone, upgrade, splash, sonic, hurt
#   about -17.5   core feedback   bite, gulp, heal, discover, growth, toxic, pulse, ink, inflate, region, lowenergy
#   about -20.5   light touches   miss, sprint, escape, cleaning, sting, spines, mimic, blocked, ui_select/back/error
#   about -23     barely there    nibble, bubble, camo, lure, illuminate      (ui_move sits lower still, about -35)
# The music plays at about -22 on the same scale. Pure high tones (lure, illuminate, the chimes) are
# loud for their peak and get small numbers; short or bass-heavy effects (hurt, sonic, lowenergy,
# nibble) stay under their level even near 100 -- that is simply as loud as a -3 dBFS file gets.
SFX: tuple[Sfx, ...] = (
    # --- gameplay
    Sfx("bite", bite, 0.095, 95, lp=3500.0, release=0.02),
    Sfx("gulp", gulp, 0.180, 90, lp=3000.0),
    Sfx("nibble", nibble, 0.045, 80, lp=4000.0, release=0.008),
    Sfx("miss", miss, 0.120, 60, lp=4000.0),
    Sfx("toxic", toxic, 0.200, 95, lp=3000.0, release=0.03),
    Sfx("hurt", hurt, 0.170, 95, lp=2000.0, release=0.03),
    Sfx("heal", heal, 0.250, 50, lp=6000.0, release=0.07),
    Sfx("cleaning", cleaning, 0.200, 35, lp=6000.0, release=0.05),
    Sfx("milestone", milestone, 0.470, 90, lp=6000.0, release=0.12),
    Sfx("discover", discover, 0.220, 45, lp=6000.0, release=0.06),
    Sfx("predator", predator, 0.480, 90, lp=900.0, release=0.06),
    Sfx("escape", escape, 0.220, 35, lp=5000.0, release=0.05),
    Sfx("ink", ink, 0.220, 85, lp=2500.0),
    Sfx("pulse", pulse, 0.150, 90, lp=3000.0, release=0.03),
    Sfx("sonic", sonic, 0.350, 95, lp=1400.0, release=0.08),
    Sfx("sting", sting, 0.055, 80, lp=5000.0, release=0.008),
    Sfx("inflate", inflate, 0.180, 50, lp=3500.0),
    Sfx("spines", spines, 0.085, 45, lp=5500.0, release=0.008),
    Sfx("sprint", sprint, 0.160, 50, lp=4500.0),
    Sfx("lure", lure, 0.200, 20, lp=5000.0),
    Sfx("stage", stage, 0.545, 75, lp=6000.0, release=0.12),
    Sfx("death", death, 0.590, 80, lp=3000.0, release=0.14),
    Sfx("lowenergy", lowenergy, 0.220, 95, lp=1800.0),
    Sfx("bubble", bubble, 0.055, 70, lp=4500.0, release=0.008),
    Sfx("blocked", blocked, 0.115, 75, lp=3000.0),
    Sfx("region", region, 0.400, 75, lp=4000.0),
    Sfx("mimic", mimic, 0.130, 50, lp=5000.0),
    Sfx("camo", camo, 0.170, 50, lp=3000.0),
    Sfx("illuminate", illuminate, 0.180, 20, lp=6000.0),
    # --- UI
    Sfx("ui_move", ui_move, 0.045, 40, lp=None, release=0.008, peak_db=-12.0),
    Sfx("ui_select", ui_select, 0.115, 55, lp=None, release=0.02),
    Sfx("ui_back", ui_back, 0.115, 70, lp=None, release=0.02),
    Sfx("ui_error", ui_error, 0.170, 40, lp=None),
    # --- extra
    Sfx("growth", growth, 0.280, 55, lp=5500.0, release=0.07),
    Sfx("upgrade", upgrade, 0.545, 65, lp=None, release=0.14),
    Sfx("splash", splash, 0.460, 95, lp=5000.0, release=0.05),
)

BY_ID = {e.id: e for e in SFX}


# ----------------------------------------------------------------------------- rendering
DC_BLOCK_HZ = 35.0      # nothing below this survives a TV speaker; removing it also removes any DC offset
TRIM_FLOOR_DB = -50.0   # relative to the peak: quieter head / tail samples are trimmed away
FADE_IN = 0.002         # seconds
FADE_OUT = 0.005


def render(e: Sfx) -> np.ndarray:
    """Synthesise one effect and return it as floats at SFX_RATE, trimmed, faded and peak-normalised."""
    sr = SFX_RATE * OVERSAMPLE
    s = Synth(e.dur, sr, seed=(SEED + zlib.crc32(e.id.encode())) % 2 ** 32, fmax=0.43 * SFX_RATE)
    e.fn(s)
    x = s.buf
    nr = min(len(x), s.samples(e.release))
    x[len(x) - nr:] *= raised_cos(nr)[::-1]                      # damp the tail so the cut is never abrupt
    stages = [hp2(DC_BLOCK_HZ)] + ([lp2(e.lp)] if e.lp else [])
    x = fft_filter(x, sr, *stages, tail=0.05)
    y = decimate(x, sr, SFX_RATE)

    a = np.abs(y)
    live = np.nonzero(a >= a.max() * undb(TRIM_FLOOR_DB))[0]
    i0 = max(0, int(live[0]) - int(0.0005 * SFX_RATE))
    i1 = min(len(y), int(live[-1]) + 1 + int(FADE_OUT * SFX_RATE))
    y = y[i0:i1]
    y = fade_edges(y - float(np.mean(y)), SFX_RATE, FADE_IN, FADE_OUT)   # residual DC out, then click-free edges
    return norm(y, undb(e.peak_db))
