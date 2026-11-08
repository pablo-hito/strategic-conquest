/**
 * Synthesized sound effects (Web Audio, no audio files). The context is created on
 * the first play, which always happens inside a click or key handler, so browsers'
 * autoplay rules are satisfied. Muting is remembered per browser.
 */
export type Sfx = 'select' | 'move' | 'attack' | 'explosion' | 'capture' | 'turn' | 'alarm' | 'error';

const MUTE_KEY = 'strategic-conquest:muted';

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted: boolean;

  constructor() {
    let m = false;
    try {
      m = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
    this.muted = m;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    return this.muted;
  }

  play(sfx: Sfx, delayMs = 0): void {
    if (this.muted) return;
    const ctx = this.context();
    if (!ctx) return;
    const t = ctx.currentTime + delayMs / 1000;
    switch (sfx) {
      case 'select':
        this.tone(t, 'sine', 880, 1320, 0.06, 0.12);
        break;
      case 'move':
        this.noise(t, 0.16, 900, 0.08, 'bandpass');
        break;
      case 'attack':
        this.noise(t, 0.12, 2400, 0.35, 'lowpass');
        this.tone(t, 'triangle', 140, 50, 0.14, 0.3);
        break;
      case 'explosion':
        this.noise(t, 0.6, 700, 0.5, 'lowpass');
        this.tone(t, 'sine', 90, 35, 0.6, 0.45);
        break;
      case 'capture':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(t + i * 0.09, 'triangle', f, f, 0.16, 0.18));
        break;
      case 'turn':
        this.tone(t, 'sine', 660, 660, 0.14, 0.14);
        this.tone(t + 0.12, 'sine', 990, 990, 0.22, 0.12);
        break;
      case 'alarm':
        this.tone(t, 'square', 520, 520, 0.12, 0.07);
        this.tone(t + 0.16, 'square', 390, 390, 0.18, 0.07);
        break;
      case 'error':
        this.tone(t, 'square', 150, 120, 0.14, 0.08);
        break;
    }
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  private tone(t: number, type: OscillatorType, from: number, to: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(t: number, dur: number, freq: number, vol: number, filterType: BiquadFilterType): void {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master!);
    src.start(t);
    src.stop(t + dur);
  }
}
