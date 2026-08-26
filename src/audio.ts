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

  /** A short bell, pitch stepping through a small pentatonic set per pickup. */
  chime(step: number): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const scale = [523.25, 587.33, 659.25, 783.99, 880.0];
      const freq = scale[step % scale.length];
      const now = ctx.currentTime;

      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.value = freq;
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.18, now + 0.02);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);

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
    } catch {
      /* a missed chime is not a game-breaking error */
    }
  }

  /**
   * A shy mote startling (round 2): two quick high grains falling a minor
   * third - small and dry on purpose. It can fire several times across a
   * chase and must read as "something small darted", never compete with
   * the collect chime.
   */
  skitter(): void {
    if (!this.ctx || !this.master) return;
    try {
      const ctx = this.ctx;
      const master = this.master;
      const now = ctx.currentTime;
      const grains: Array<[number, number]> = [
        [0, 1318.5],
        [0.07, 1108.7],
      ];
      for (const [t, f] of grains) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now + t);
        g.gain.linearRampToValueAtTime(0.045, now + t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.16);
        o.connect(g);
        g.connect(master);
        o.start(now + t);
        o.stop(now + t + 0.2);
      }
    } catch {
      /* a missed skitter is not a game-breaking error */
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
