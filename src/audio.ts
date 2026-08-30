/**
 * Minimal Web Audio ambience and effects. No samples anywhere - everything
 * here is oscillators and a runtime-generated noise buffer, so it is "made by
 * you" per SPEC.md's synth path, not a downloaded sound effect.
 *
 * Browsers block audio until a user gesture, so the context is created lazily
 * in unlock(). Every entry point is wrapped in try/catch - atmosphere sound
 * must never throw into the game loop, the console, or a headless browser
 * that refuses audio entirely.
 */

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlocked = false;
  private stormDesired = false;
  private stormGain: GainNode | null = null;
  private stormLfoGain: GainNode | null = null;

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const w = window as WebkitWindow;
      const Ctx = window.AudioContext ?? w.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.startDrone(ctx, master);
      this.applyStorm();
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  /** Three detuned sines through a lowpass, breathing via a slow gain LFO. */
  private startDrone(ctx: AudioContext, master: GainNode): void {
    try {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 420;

      const drone = ctx.createGain();
      drone.gain.value = 0.07;
      drone.connect(filter);
      filter.connect(master);

      const partials: Array<[frequency: number, gain: number]> = [
        [55, 0.5],
        [82.5, 0.24],
        [110, 0.16],
      ];
      for (const [frequency, gain] of partials) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = frequency;
        const g = ctx.createGain();
        g.gain.value = gain;
        osc.connect(g);
        g.connect(drone);
        osc.start();
      }

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.055;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.045;
      lfo.connect(lfoGain);
      lfoGain.connect(drone.gain);
      lfo.start();
    } catch {
      /* the drone is atmosphere, never a requirement */
    }
  }

  /** A felt-glass collect voice whose body and harmony deepen with the active chain. */
  chime(step: number, chain = 1): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const scale = [523.25, 587.33, 659.25, 783.99, 880.0];
      const freq = scale[step % scale.length];
      const now = ctx.currentTime;

      const body = ctx.createOscillator();
      body.type = chain >= 4 ? "triangle" : "sine";
      body.frequency.value = freq;
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.14 + chain * 0.018, now + 0.015);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7 + chain * 0.08);

      const partial = ctx.createOscillator();
      partial.type = "sine";
      partial.frequency.value = freq * 2;
      const partialGain = ctx.createGain();
      partialGain.gain.setValueAtTime(0.0001, now);
      partialGain.gain.linearRampToValueAtTime(0.05, now + 0.02);
      partialGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);

      body.connect(bodyGain);
      partial.connect(partialGain);
      bodyGain.connect(master);
      partialGain.connect(master);

      body.start(now);
      body.stop(now + 0.95);
      partial.start(now);
      partial.stop(now + 0.65);
      if (chain >= 2) {
        const harmony = ctx.createOscillator();
        harmony.type = "sine";
        harmony.frequency.value = freq * (chain >= 5 ? 1.5 : 1.25);
        const harmonyGain = ctx.createGain();
        harmonyGain.gain.setValueAtTime(0.0001, now);
        harmonyGain.gain.linearRampToValueAtTime(0.025 + chain * 0.008, now + 0.025);
        harmonyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
        harmony.connect(harmonyGain);
        harmonyGain.connect(master);
        harmony.start(now);
        harmony.stop(now + 0.8);
      }
    } catch {
      /* a missed chime is not a game-breaking error */
    }
  }

  /** One short white-noise buffer, made once per context and shared by the transient voices. */
  private noiseCache: AudioBuffer | null = null;
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseCache) return this.noiseCache;
    const size = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i += 1) data[i] = Math.random() * 2 - 1;
    this.noiseCache = buffer;
    return buffer;
  }

  /**
   * The reach. A short upward filtered-noise inhale plus a sine that bends up -
   * the sound of light being drawn in rather than struck. `caught` opens the
   * filter and adds a soft low body so a press that lands is audibly fuller
   * than a press into the dark, before the first mote's chime even arrives.
   */
  gather(caught: number): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const hit = caught > 0;
      const dur = hit ? 0.34 : 0.22;

      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(ctx);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 1.4;
      band.frequency.setValueAtTime(hit ? 420 : 320, now);
      band.frequency.exponentialRampToValueAtTime(hit ? 2200 + caught * 260 : 900, now + dur);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.linearRampToValueAtTime(hit ? 0.09 : 0.035, now + 0.03);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      noise.connect(band);
      band.connect(noiseGain);
      noiseGain.connect(master);
      noise.start(now);
      noise.stop(now + dur + 0.05);

      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.setValueAtTime(hit ? 138 : 116, now);
      body.frequency.exponentialRampToValueAtTime(hit ? 330 : 150, now + dur);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(hit ? 0.1 : 0.04, now + 0.025);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.08);
      body.connect(bodyGain);
      bodyGain.connect(master);
      body.start(now);
      body.stop(now + dur + 0.12);
    } catch {
      /* a missed reach sound is not a game-breaking error */
    }
  }

  /**
   * A press that cannot be paid for. The deliberate inverse of gather(): the
   * filter closes instead of opening and the body bends DOWN, so the refusal is
   * recognisable as the reach's own sound played backwards rather than as an
   * error beep. Quiet on purpose - it is information, not a scolding.
   */
  denied(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const dur = 0.2;

      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(ctx);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 1.1;
      band.frequency.setValueAtTime(700, now);
      band.frequency.exponentialRampToValueAtTime(180, now + dur);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.linearRampToValueAtTime(0.03, now + 0.02);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      noise.connect(band);
      band.connect(noiseGain);
      noiseGain.connect(master);
      noise.start(now);
      noise.stop(now + dur + 0.05);

      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.setValueAtTime(150, now);
      body.frequency.exponentialRampToValueAtTime(84, now + dur);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.05, now + 0.02);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.06);
      body.connect(bodyGain);
      bodyGain.connect(master);
      body.start(now);
      body.stop(now + dur + 0.1);
    } catch {
      /* a missed refusal sound is not a game-breaking error */
    }
  }

  /**
   * The reach coming back over the line: a clean two-note lift, a fifth apart,
   * well above the collect chimes so it reads as a state change rather than as
   * another mote. This is the sound the walk is for.
   */
  charged(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      [
        { f: 659.25, at: 0 },
        { f: 987.77, at: 0.075 },
      ].forEach(({ f, at }) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.linearRampToValueAtTime(0.055, now + at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.42);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now + at);
        osc.stop(now + at + 0.5);
      });
    } catch {
      /* a missed ready cue is not a game-breaking error */
    }
  }

  /**
   * The deep reach starting: a low sustained pour rather than a hit. Where
   * gather() is a short inhale, this opens and stays open for as long as a hold
   * usually lasts, so the ear hears "still going" while the edge travels out.
   */
  pour(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const dur = 0.9;

      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(ctx);
      noise.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 0.9;
      band.frequency.setValueAtTime(300, now);
      band.frequency.exponentialRampToValueAtTime(2600, now + dur);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.linearRampToValueAtTime(0.055, now + 0.12);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      noise.connect(band);
      band.connect(noiseGain);
      noiseGain.connect(master);
      noise.start(now);
      noise.stop(now + dur + 0.05);

      const body = ctx.createOscillator();
      body.type = "triangle";
      body.frequency.setValueAtTime(96, now);
      body.frequency.exponentialRampToValueAtTime(240, now + dur);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.075, now + 0.1);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.1);
      body.connect(bodyGain);
      bodyGain.connect(master);
      body.start(now);
      body.stop(now + dur + 0.15);
    } catch {
      /* a missed pour is not a game-breaking error */
    }
  }

  /** Low warm bloom at a full chain: distinct from pickup and beacon voices. */
  radiance(): void {
    if (!this.ctx || !this.master) return;
    try {
      const now = this.ctx.currentTime;
      [130.81, 196, 261.63, 392].forEach((frequency, index) => {
        const oscillator = this.ctx!.createOscillator();
        oscillator.type = index === 0 ? "triangle" : "sine";
        oscillator.frequency.value = frequency;
        const gain = this.ctx!.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.08 - index * 0.01, now + 0.05 + index * 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
        oscillator.connect(gain);
        gain.connect(this.master!);
        oscillator.start(now);
        oscillator.stop(now + 1.3);
      });
    } catch {
      /* atmosphere only */
    }
  }

  /**
   * A snuffed-light thud: a short burst of filtered noise plus a falling,
   * dissonant low interval. The noise is a runtime-generated buffer of
   * random values - synthesized in code, not a downloaded sound effect.
   */
  hit(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;

      const bufferSize = Math.floor(ctx.sampleRate * 0.3);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i += 1) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "lowpass";
      noiseFilter.frequency.setValueAtTime(900, now);
      noiseFilter.frequency.exponentialRampToValueAtTime(120, now + 0.28);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.35, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(master);
      noise.start(now);

      for (const freq of [98, 92.5]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + 0.4);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.16, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 0.5);
      }
    } catch {
      /* a missed hit sound is not a game-breaking error */
    }
  }

  /**
   * The beacon has opened - a low, warm two-note call, quieter than the
   * level-complete run. It marks the moment going becomes allowed, which is
   * what makes skipping the remaining motes a legible choice.
   */
  beaconOpen(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const notes: Array<[frequency: number, start: number]> = [
        [261.63, 0],
        [392.0, 0.16],
      ];
      for (const [freq, offset] of notes) {
        const start = now + offset;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.2);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + 1.25);
      }
    } catch {
      /* atmosphere only */
    }
  }

  /**
   * A quick rising arpeggio - the level-complete payoff. A flawless level
   * (every mote found, not just the required ones) earns two extra steps up:
   * the fuller run is the reward for greed that paid off.
   */
  levelComplete(flawless = false): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const notes = flawless
        ? [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98]
        : [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const start = now + i * 0.09;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.16, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + 0.75);
      });
    } catch {
      /* atmosphere only */
    }
  }

  /**
   * The storm-dark weather bed: looping filtered noise with a slow gust LFO,
   * faded in for level 3 and back out everywhere else. Built lazily on first
   * use (and deferred until unlock() if requested before audio exists);
   * "off" also zeroes the LFO depth so the bed is truly silent, not
   * oscillating around zero.
   */
  setStorm(on: boolean): void {
    this.stormDesired = on;
    this.applyStorm();
  }

  private applyStorm(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      if (!this.stormGain) {
        const size = Math.floor(ctx.sampleRate * 2);
        const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < size; i += 1) {
          data[i] = Math.random() * 2 - 1;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 420;
        filter.Q.value = 0.65;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.13;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0;
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.master);
        src.start();
        lfo.start();
        this.stormGain = gain;
        this.stormLfoGain = lfoGain;
      }
      const now = ctx.currentTime;
      this.stormGain.gain.cancelScheduledValues(now);
      this.stormGain.gain.setTargetAtTime(this.stormDesired ? 0.055 : 0, now, 0.8);
      this.stormLfoGain!.gain.cancelScheduledValues(now);
      this.stormLfoGain!.gain.setTargetAtTime(this.stormDesired ? 0.018 : 0, now, 0.8);
    } catch {
      /* atmosphere only */
    }
  }

  /** Distant thunder for the storm flicker: a soft, low-passed noise swell. */
  rumble(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const duration = 0.9;
      const size = Math.floor(ctx.sampleRate * duration);
      const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < size; i += 1) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / size);
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(160, now);
      filter.frequency.exponentialRampToValueAtTime(60, now + duration);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.09, now + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      src.start(now);
    } catch {
      /* atmosphere only */
    }
  }

  /** A long, warm sustained chord - the ending's arrival. */
  ending(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const chord = [261.63, 329.63, 392.0, 523.25];
      for (const freq of chord) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.09, now + 2.2);
        gain.gain.linearRampToValueAtTime(0, now + 7);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 7.1);
      }
    } catch {
      /* atmosphere only */
    }
  }
}
