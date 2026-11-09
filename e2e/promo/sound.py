"""The sound of the promo video, made from scratch (no samples, no licences).

    python3 promo/sound.py shots/promo/video/cues.json shots/promo/video/sound.wav

Music: a bright 120 bpm track in A minor (Am – F – C – G, ending on C):
four-on-the-floor kick, claps, hats, a pumping bass, synth stabs and an arp.
It starts with a two-beat pickup (so its bars begin on beats 2, 6, 10, … of
the video), opens up when the page turns into Markdown, builds into the
feature wall (where every tile that lands plays the next note of a rising
arpeggio) and resolves on the end card.

Foley follows the picture (cues.json, written by render.mjs, has the pen, the
taps, the cuts and the events of every frame): the pen scratching while it
writes, taps, a soft whoosh as one clip flows into the next, paper flicks, the
felt-tip swipe of the end card and a chime when the name is written.
"""
import json
import sys
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(7)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(dur):
    return np.arange(max(1, int(dur * SR))) / SR


def spectrum_filter(x, gain_fn):
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(spec * gain_fn(np.maximum(f, 1e-3)), len(x))


def lowpass(x, cutoff, order=2):
    return spectrum_filter(x, lambda f: 1 / np.sqrt(1 + (f / cutoff) ** (2 * order)))


def highpass(x, cutoff, order=2):
    return spectrum_filter(x, lambda f: 1 / np.sqrt(1 + (cutoff / f) ** (2 * order)))


def bandpass(x, lo, hi):
    return highpass(lowpass(x, hi), lo)


def noise(n):
    return rng.standard_normal(n)


def saw(freq, t, phase=0.0):
    """A band-limited-ish sawtooth (additive, up to 9 kHz)."""
    out = np.zeros(len(t))
    k = 1
    while k * freq < 9000 and k <= 40:
        out += np.sin(2 * np.pi * k * freq * t + phase * k) / k
        k += 1
    return out * (2 / np.pi)


def env_adsr(n, a=0.005, d=0.1, s=0.6, r=0.1, hold=None):
    t = np.arange(n) / SR
    hold = (n / SR - r) if hold is None else hold
    e = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6)))
    e = np.where(t > hold, e * np.exp(-(t - hold) / max(r / 4, 1e-6)), e)
    return e


class Track:
    def __init__(self, seconds):
        self.n = int(seconds * SR)
        self.L = np.zeros(self.n)
        self.R = np.zeros(self.n)

    def add(self, sig, at, gain=1.0, pan=0.0):
        i = int(round(at * SR))
        if i >= self.n or i + len(sig) <= 0:
            return
        s = sig
        if i < 0:
            s, i = s[-i:], 0
        s = s[: self.n - i]
        self.L[i : i + len(s)] += s * gain * np.sqrt(0.5 * (1 - pan))
        self.R[i : i + len(s)] += s * gain * np.sqrt(0.5 * (1 + pan))


def reverb(tr, amount=0.12, decay=0.5, seed=3):
    ir_t = tt(1.8)
    for side, s in ((tr.L, seed), (tr.R, seed + 1)):
        r = np.random.default_rng(s)
        ir = lowpass(r.standard_normal(len(ir_t)), 5000) * np.exp(-ir_t / decay)
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir**2))
        n = len(side) + len(ir)
        wet = np.fft.irfft(np.fft.rfft(side, n) * np.fft.rfft(ir, n), n)[: len(side)]
        side += amount * wet


# ------------------------------------------------------------------ instruments


def kick(punch=1.0):
    t = tt(0.5)
    f = 46 + 110 * np.exp(-t / 0.028) + 40 * np.exp(-t / 0.006)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
    click = bandpass(noise(len(t)), 1800, 7000) * np.exp(-t / 0.004) * 0.35
    return np.tanh(1.8 * punch * (body + click))


def clap():
    t = tt(0.4)
    n = bandpass(noise(len(t)), 900, 5200)
    e = np.zeros(len(t))
    for k, d in enumerate((0.0, 0.011, 0.022)):
        e += np.where(t >= d, np.exp(-(t - d) / 0.008), 0) * (0.8 + 0.1 * k)
    e += np.where(t >= 0.03, 0.55 * np.exp(-(t - 0.03) / 0.11), 0)
    return n * e


def hat(open_=False):
    t = tt(0.35 if open_ else 0.07)
    return highpass(noise(len(t)), 7500) * np.exp(-t / (0.12 if open_ else 0.016))


def bass_note(freq, dur, release=0.05):
    t = tt(dur + release)
    sub = np.sin(2 * np.pi * freq * t)
    grit = saw(freq * 2, t)
    cut = 300 + 1600 * np.exp(-t / 0.07)
    # a moving lowpass, done in short blocks
    out = np.zeros(len(t))
    blk = 1024
    for i in range(0, len(t), blk):
        seg = grit[i : i + blk]
        out[i : i + blk] = lowpass(np.pad(seg, (0, blk - len(seg))), cut[i])[: len(seg)]
    e = env_adsr(len(t), a=0.004, d=0.18, s=0.7, r=release, hold=dur)
    return np.tanh(1.3 * (0.75 * sub + 0.7 * out)) * e


def stab(freqs, dur, bright=1.0):
    """A plucky chord: detuned saws through a closing filter."""
    t = tt(dur + 0.25)
    sig = np.zeros(len(t))
    for f in freqs:
        for det in (-0.006, 0.0, 0.0065):
            sig += saw(f * (1 + det), t, phase=rng.random() * 6)
    sig /= len(freqs) * 3
    cut = 700 + 5200 * bright * np.exp(-t / 0.09)
    out = np.zeros(len(t))
    blk = 1024
    for i in range(0, len(t), blk):
        seg = sig[i : i + blk]
        out[i : i + blk] = lowpass(np.pad(seg, (0, blk - len(seg))), cut[i])[: len(seg)]
    return out * env_adsr(len(t), a=0.003, d=0.16, s=0.35, r=0.2, hold=dur)


def pluck(freq, dur=0.22):
    t = tt(dur + 0.2)
    sig = 0.6 * np.sign(np.sin(2 * np.pi * freq * t)) * 0.5 + saw(freq, t) * 0.5
    sig = lowpass(sig, 2400) * np.exp(-t / 0.12)
    return sig * (1 - np.exp(-t / 0.002))


def pad(freqs, dur):
    t = tt(dur + 0.6)
    sig = np.zeros(len(t))
    for f in freqs:
        for det in (-0.004, 0.004):
            sig += saw(f * (1 + det), t, phase=rng.random() * 6)
    sig = lowpass(sig / (len(freqs) * 2), 1400)
    e = np.clip(t / 0.35, 0, 1) * np.clip((dur + 0.6 - t) / 0.6, 0, 1)
    return sig * e


def chime(freq, dur=2.4):
    t = tt(dur)
    sig = sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / d) for a, r, d in [(1, 1, 0.9), (0.5, 2.0, 0.5), (0.25, 3.01, 0.28), (0.12, 4.2, 0.15)])
    return sig * (1 - np.exp(-t / 0.002))


def riser(dur):
    t = tt(dur)
    u = t / dur
    sig = bandpass(noise(len(t)), 800, 9000) * u**2.2 * 0.7
    f = 200 + 1800 * u**2
    sig += 0.25 * np.sin(2 * np.pi * np.cumsum(f) / SR) * u**1.5
    return sig


def impact():
    t = tt(1.8)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.5)
    crash = highpass(noise(len(t)), 3000) * np.exp(-t / 0.6) * 0.45
    return np.tanh(1.5 * boom) + crash


# ------------------------------------------------------------------ the music

BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT
# A minor: Am – F – C – G, three times, then C to end on
CHORDS = {
    "Am": (33, [57, 60, 64, 67]),
    "F": (29, [53, 57, 60, 64]),
    "C": (36, [55, 60, 64, 67]),
    "G": (31, [55, 59, 62, 67]),
}
LOOP = ["Am", "F", "C", "G"]
PICKUP = 2  # beats before the first downbeat
ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2]


def chord_of_bar(b):
    """The intro bar sits on G, then Am – F – C – G from the drop on."""
    return "G" if b == 0 else LOOP[(b - 1) % 4]


def music(seconds, cues):
    tr = Track(seconds)
    fps = cues["fps"]
    clip_start = {c["id"]: c["start"] / fps for c in cues["clips"]}
    drop = clip_start["text"]  # the page turns into Markdown
    wall = clip_start["wall"]
    end = clip_start["end"]
    duck = np.ones(tr.n)  # sidechain: everything but the drums breathes with the kick

    def kick_at(at, g=1.0):
        tr.add(kick(), at, 0.5 * g)
        i = int(at * SR)
        n = int(0.24 * SR)
        if i < tr.n:
            seg = 1 - 0.55 * np.exp(-np.arange(min(n, tr.n - i)) / SR / 0.07)
            duck[i : i + len(seg)] = np.minimum(duck[i : i + len(seg)], seg)

    mus = Track(seconds)  # the tonal parts, ducked later
    grid = PICKUP * BEAT  # the first downbeat
    # the pickup: hats and a soft swell lead into the first downbeat
    tr.add(riser(grid), 0, 0.12)
    for k in range(4):
        tr.add(hat(), k * BEAT / 2, 0.035 + 0.01 * k, 0.3)
    bars = int(np.ceil((seconds - grid) / BAR))
    for b in range(bars):
        t0 = grid + b * BAR
        name = chord_of_bar(b)
        root, chord = CHORDS[name]
        freqs = [midi(m) for m in chord]
        intro = t0 < drop - 0.01
        at_end = t0 >= end - 0.01
        build = wall - BAR <= t0 < wall - 0.01
        if at_end:
            if t0 < end + 0.01:
                # the last chord: wide, held, over the end card
                mus.add(stab([midi(m) for m in [48, 55, 60, 64, 67, 72, 76]], BAR * 2.4, bright=0.8), t0, 0.46)
                mus.add(pad([midi(m) for m in [48, 55, 64, 67, 71]], BAR * 2.3), t0, 0.26)
                tr.add(bass_note(midi(36), BAR * 0.6, release=2.2), t0, 0.3)
                tr.add(impact(), t0, 0.3)
                kick_at(t0, 0.85)
                tr.add(clap(), t0 + 0.012, 0.16, 0.05)
            # a soft pulse fading out under the end card
            for beat in range(4):
                at = t0 + beat * BEAT
                if at > end + 0.4:
                    tr.add(hat(beat % 2 == 1), at + BEAT / 2, 0.06 * max(0.0, 1 - (at - end) / 4.2), 0.3)
            continue
        # drums
        for beat in range(4):
            at = t0 + beat * BEAT
            if intro:
                kick_at(at, 0.55 if beat else 0.8)
            else:
                kick_at(at)
            if not intro and beat in (1, 3):
                tr.add(clap(), at, 0.38, 0.08)
            tr.add(hat(open_=not intro), at + BEAT / 2, 0.11 if not intro else 0.06, 0.3)
            for s16 in (1, 3) if not intro else ():
                tr.add(hat(), at + s16 * BEAT / 4, 0.045, -0.25)
        if build:
            # a snare roll that speeds up, a riser, then a breath before the wall
            for k in range(16):
                at = t0 + k * BEAT / 4
                if at < wall - BEAT / 2:
                    tr.add(clap(), at, 0.05 + 0.18 * k / 16, 0.0)
            tr.add(riser(BAR - BEAT / 2), t0, 0.32)
        # bass: one, the "and" of two, three, the "and" of four
        for beat, length in ((0, 0.9), (1.5, 0.45), (2, 0.9), (3.5, 0.45)):
            if intro and beat not in (0, 2):
                continue
            if build and beat == 3.5:
                continue
            tr.add(bass_note(midi(root + 12), BEAT * length), t0 + beat * BEAT, 0.3 if not intro else 0.22)
        # chord stabs on the off-beats (on every eighth while the paper changes)
        paper = clip_start["paper"] <= t0 + 0.01 < clip_start["pages"]
        offs = [0.5, 1.5, 2.5, 3.5] if not paper else [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]
        for o in offs:
            mus.add(stab(freqs, BEAT * 0.38, bright=0.7 if intro else 1.0), t0 + o * BEAT, 0.27 if not intro else 0.2, pan=-0.15)
        # the arp, an octave up, from the drop on
        if not intro:
            for k in range(16):
                deg = ARP[k]
                m = chord[deg % 4] + 12
                mus.add(pluck(midi(m), BEAT / 4), t0 + k * BEAT / 4, 0.095, pan=0.35 if k % 2 else -0.35)
        mus.add(pad(freqs, BAR), t0, 0.07 if not intro else 0.1)
    # the wall: a tile lands, the next note of a rising arpeggio
    k = 0
    for i, f in enumerate(cues["frames"]):
        for _ in range(f.get("tiles") or 0):
            name = "G"
            notes = [55, 59, 62, 67, 71, 74, 79, 83]
            m = notes[k % len(notes)] + 12 * (k // len(notes))
            mus.add(pluck(midi(min(m, 96)), 0.18), i / fps, 0.08, pan=-0.5 + (k % 8) / 7)
            k += 1
    tr.add(impact(), wall - 0.01, 0.45)
    tr.add(chime(midi(79)), wall, 0.08, 0.2)
    mus.L *= duck
    mus.R *= duck
    reverb(mus, 0.16, 0.6)
    tr.L += mus.L
    tr.R += mus.R
    return tr


# ------------------------------------------------------------------ foley


def pen_scratch(tr, cues):
    """The pen on the screen: filtered noise, louder the faster it moves."""
    fps = cues["fps"]
    frames = cues["frames"]
    n = len(frames)
    speed = np.zeros(n)
    down = np.zeros(n)
    for i, b in enumerate(frames):
        ink = b.get("ink")
        p = b.get("pen")
        if ink:
            speed[i] = ink["dist"]
            down[i] = 1.0 if ink["down"] else 0.0
        elif p and p.get("video") and p.get("down"):
            a = frames[i - 1].get("pen") if i else None
            down[i] = 1.0
            if a and a.get("down"):
                speed[i] = 0.45 * np.hypot(p["x"] - a["x"], p["y"] - a["y"])
    level = np.clip(speed / 22, 0, 1) ** 0.6 * 0.85 + 0.15 * down
    ts = np.arange(tr.n) / SR
    env = np.interp(ts, (np.arange(n) + 0.5) / fps, level)
    k = int(0.01 * SR)
    env = np.convolve(env, np.ones(k) / k, mode="same")
    hiss = bandpass(noise(tr.n), 2000, 8000)
    body = bandpass(noise(tr.n), 400, 1500)
    grain = np.clip(0.7 + 0.3 * lowpass(noise(tr.n), 80) / 0.05, 0.2, 1.6)
    sig = (0.8 * hiss / np.std(hiss) + 0.35 * body / np.std(body)) * env * grain
    tr.add(sig, 0, 0.12, pan=-0.05)


def tap():
    t = tt(0.06)
    return bandpass(noise(len(t)), 1800, 6000) * np.exp(-t / 0.005) + 0.7 * np.sin(2 * np.pi * 260 * t) * np.exp(-t / 0.01)


def whoosh(dur=0.5, lo=250, hi=3800):
    """Air moving past: a soft swell of filtered noise, its pitch rising a little."""
    t = tt(dur)
    u = t / dur
    low = bandpass(noise(len(t)), lo, hi * 0.6)
    high = bandpass(noise(len(t)), lo * 2, hi)
    sig = low * (1 - u) + high * u
    return sig / np.std(sig) * np.sin(np.pi * u) ** 1.6


def swoosh(dur=0.3, lo=500, hi=6000):
    t = tt(dur)
    return bandpass(noise(len(t)), lo, hi) * np.sin(np.pi * t / dur) ** 2


def felt_tip(dur=0.5):
    """The end card's giant highlighter stroke: felt on paper."""
    t = tt(dur)
    e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.7
    rough = np.clip(0.6 + 0.4 * lowpass(noise(len(t)), 30) / 0.08, 0.2, 1.4)
    return bandpass(noise(len(t)), 300, 4500) * e * rough


def flick():
    t = tt(0.07)
    return bandpass(noise(len(t)), 2500, 9000) * np.exp(-t / 0.012)


def foley(seconds, cues):
    tr = Track(seconds)
    fps = cues["fps"]
    pen_scratch(tr, cues)
    for i, f in enumerate(cues["frames"]):
        at = i / fps
        if f.get("tap"):
            tr.add(tap(), at - 0.004, 0.24, pan=0.15)
        if f.get("touch") and not (i and cues["frames"][i - 1].get("touch")):
            tr.add(swoosh(0.35, 400, 3000), at, 0.12, -0.2)
        ev = f.get("event")
        if ev == "fade":
            # the camera glides over to the next clip
            tr.add(whoosh(0.55), at - 0.12, 0.05, pan=-0.1)
        elif ev == "cut":
            tr.add(whoosh(0.35, 400, 3000), at - 0.06, 0.025, pan=0.1)
        elif ev == "step":
            tr.add(flick(), at, 0.2, pan=0.2)
        elif ev == "wall":
            tr.add(swoosh(0.5, 300, 4000), at - 0.3, 0.12)
        elif ev == "end":
            tr.add(felt_tip(0.5), at, 0.28, 0.0)
    end = next(c for c in cues["clips"] if c["id"] == "end")
    t_end = end["start"] / fps
    # the name is written: a chime
    tr.add(chime(midi(84)), t_end + 2.38, 0.07, 0.2)
    tr.add(chime(midi(91)), t_end + 2.5, 0.045, -0.2)
    return tr


def main():
    cues = json.load(open(sys.argv[1]))
    fps = cues["fps"]
    seconds = cues["total"] / fps
    m = music(seconds + 0.01, cues)
    fx = foley(seconds + 0.01, cues)
    L = 0.85 * m.L + fx.L
    R = 0.85 * m.R + fx.R
    ts = np.arange(len(L)) / SR
    # a hair of fade-in, a fade-out over the last second
    g = np.clip(ts / 0.01, 0, 1) * np.clip((seconds - ts) / 1.0, 0, 1) ** 1.2
    L, R = L * g, R * g
    # a little less sub (phones), a little more presence
    def tilt(f):
        rumble = 1 / np.sqrt(1 + (40 / f) ** 4)  # nothing below 40 Hz
        shelf = 1 - 0.25 / (1 + (f / 90) ** 4)  # a little less sub
        presence = 1 + 0.22 * np.exp(-(np.log2(f / 3000) ** 2) / 1.2)  # a little more around 3 kHz
        return rumble * shelf * presence
    L = spectrum_filter(L, tilt)
    R = spectrum_filter(R, tilt)
    # loudness: about -14 LUFS-ish (the RMS of the busy part), peaks soft-limited
    end = next(c for c in cues["clips"] if c["id"] == "end")
    busy = slice(int(2 * SR), int(end["start"] / fps * SR))
    rms = np.sqrt(np.mean(np.concatenate([L[busy], R[busy]]) ** 2))
    gain = 10 ** (-14.0 / 20) / max(rms, 1e-6)
    L, R = np.tanh(L * gain * 1.15) / 1.15, np.tanh(R * gain * 1.15) / 1.15
    # headroom for the AAC encoder, which overshoots sharp hits
    peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
    if peak > 0.8:
        L, R = L * 0.8 / peak, R * 0.8 / peak
    out = np.stack([L, R], axis=1)
    with wave.open(sys.argv[2], "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((out * 32767).astype("<i2").tobytes())
    print(f"  ✓ {sys.argv[2]}: {seconds:.2f} s, gain {20 * np.log10(gain):.1f} dB")


if __name__ == "__main__":
    main()
