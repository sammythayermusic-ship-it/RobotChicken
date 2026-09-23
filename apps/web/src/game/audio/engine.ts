/**
 * The live WebAudio graph: per-voice StereoPanner -> bus (sfx / crowd / ui)
 * -> master -> DynamicsCompressor -> destination. Buffers arrive
 * asynchronously (rendered or decoded); a sound played before its buffer
 * exists is skipped rather than played late.
 */
import type { AudioSink } from "../fx/director";
import { SOUND_NAMES, SOUND_SPECS, type Bus, type SoundName } from "./names";
import { VoicePool, pitchRate } from "./voices";

export type SoundSource = "recipe" | "file";

const INDEX = Object.fromEntries(SOUND_NAMES.map((n, i) => [n, i])) as Record<SoundName, number>;
const RECENT = 32;

/** Preallocated slot for one playing one-shot; its ended handler is bound once. */
class Voice {
  src: AudioBufferSourceNode | null = null;
  amp: GainNode | null = null;
  pan: AudioNode | null = null;
  /** A stolen voice still fading out in this slot. */
  oldSrc: AudioBufferSourceNode | null = null;
  oldAmp: GainNode | null = null;
  oldPan: AudioNode | null = null;
  readonly onEnded: (e: Event) => void;

  constructor(pool: VoicePool, slot: number) {
    this.onEnded = (e) => {
      if (e.target === this.src) {
        pool.release(slot);
        this.amp?.disconnect();
        this.pan?.disconnect();
        this.src = this.amp = this.pan = null;
      } else if (e.target === this.oldSrc) {
        this.oldAmp?.disconnect();
        this.oldPan?.disconnect();
        this.oldSrc = this.oldAmp = this.oldPan = null;
      }
    };
  }
}

export class AudioEngine implements AudioSink {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly buses: Record<Bus, GainNode>;
  private readonly buffers: (AudioBuffer | null)[] = SOUND_NAMES.map(() => null);
  private readonly sources: (SoundSource | null)[] = SOUND_NAMES.map(() => null);
  private readonly pools: VoicePool[];
  private readonly voices: Voice[][];
  private crowd: { src: AudioBufferSourceNode; tone: BiquadFilterNode; level: GainNode } | null = null;
  private hypeSent = -1;
  private hypeAt = -1;
  private muted = false;
  private disposed = false;
  private readonly recent: SoundName[] = [];
  /** Wall-clock ms from creation until every sound was ready (-1 until then). */
  readyMs = -1;
  /** ... until the first-exchange sounds were ready. */
  firstHitsMs = -1;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // Gentle glue with a soft ceiling: stacked hits + roar + horn must not clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(ctx.destination);
    const bus = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.master);
      return g;
    };
    this.buses = { sfx: bus(1), crowd: bus(1), ui: bus(0.9) };
    this.pools = SOUND_NAMES.map((n) => new VoicePool(SOUND_SPECS[n].maxVoices));
    this.voices = this.pools.map((p) => Array.from({ length: p.capacity }, (_, i) => new Voice(p, i)));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  has(name: SoundName): boolean {
    return this.buffers[INDEX[name]] !== null;
  }

  /** How many sounds have a buffer. */
  get ready(): number {
    let n = 0;
    for (const b of this.buffers) if (b) n++;
    return n;
  }

  buffer(name: SoundName): AudioBuffer | null {
    return this.buffers[INDEX[name]] ?? null;
  }

  sourceOf(name: SoundName): SoundSource | null {
    return this.sources[INDEX[name]] ?? null;
  }

  setBuffer(name: SoundName, buf: AudioBuffer, source: SoundSource): void {
    const i = INDEX[name];
    this.buffers[i] = buf;
    this.sources[i] = source;
    // A file replacing the crowd bed takes over on the next hype update.
    if (name === "crowd_loop" && this.crowd) {
      this.stopCrowd();
      this.hypeSent = -1;
    }
  }

  /** Sounds actually started, newest last (debug / e2e). */
  get played(): readonly SoundName[] {
    return this.recent;
  }

  play(name: SoundName, opts?: { pan?: number; seed?: number }): void {
    if (this.disposed || this.muted || this.ctx.state !== "running") return;
    const i = INDEX[name];
    const buf = this.buffers[i];
    const spec = SOUND_SPECS[name];
    if (!buf || spec.loop) return; // the loop is driven by setHype
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const pool = this.pools[i] as VoicePool;
    const slot = pool.acquire();
    const v = (this.voices[i] as Voice[])[slot] as Voice;
    if (pool.stole && v.src && v.amp) {
      // Duck the oldest voice out over ~10 ms instead of cutting it (no click).
      v.amp.gain.cancelScheduledValues(now);
      v.amp.gain.setTargetAtTime(0, now, 0.004);
      v.src.stop(now + 0.03);
      v.oldAmp?.disconnect();
      v.oldPan?.disconnect();
      v.oldSrc = v.src;
      v.oldAmp = v.amp;
      v.oldPan = v.pan;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitchRate(spec.pitchJitter, opts?.seed ?? 0, i);
    const amp = ctx.createGain();
    amp.gain.value = spec.gain;
    let pan: AudioNode = amp;
    if (typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      const x = opts?.pan ?? 0;
      p.pan.value = x < -1 ? -1 : x > 1 ? 1 : x || 0;
      amp.connect(p);
      pan = p;
    }
    src.connect(amp);
    pan.connect(this.buses[spec.bus]);
    src.onended = v.onEnded;
    v.src = src;
    v.amp = amp;
    v.pan = pan === amp ? null : pan;
    src.start(now);
    this.recent.push(name);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  /**
   * Crowd bed follows hype (0..1): louder and brighter as the fight heats up.
   * Called every sim tick; only touches the params when hype moved or every
   * 100 ms. Each update also schedules a slow fade to silence 0.6 s out, so
   * when ticks stop (pause, quit to the menu) the crowd drifts away by itself.
   */
  setHype(h: number): void {
    if (this.disposed || this.ctx.state !== "running") return;
    if (!this.crowd && !this.startCrowd()) return;
    const c = this.crowd;
    if (!c) return;
    const now = this.ctx.currentTime;
    const x = h < 0 ? 0 : h > 1 ? 1 : h || 0;
    if (Math.abs(x - this.hypeSent) < 0.02 && now - this.hypeAt < 0.1) return;
    this.hypeSent = x;
    this.hypeAt = now;
    const level = SOUND_SPECS.crowd_loop.gain * (0.45 + 0.55 * x * x);
    c.level.gain.cancelScheduledValues(now);
    c.level.gain.setTargetAtTime(level, now, 0.3);
    c.level.gain.setTargetAtTime(0, now + 0.6, 0.6);
    c.tone.frequency.cancelScheduledValues(now);
    c.tone.frequency.setTargetAtTime(1000 * Math.pow(6, x), now, 0.35);
  }

  private startCrowd(): boolean {
    const buf = this.buffers[INDEX.crowd_loop];
    if (!buf) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1500;
    tone.Q.value = 0.5;
    const level = ctx.createGain();
    level.gain.value = 0;
    src.connect(tone).connect(level).connect(this.buses.crowd);
    src.start();
    this.crowd = { src, tone, level };
    return true;
  }

  private stopCrowd(): void {
    const c = this.crowd;
    if (!c) return;
    this.crowd = null;
    try {
      c.src.stop();
    } catch {
      // never started or already stopped
    }
    c.level.disconnect();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(m ? 0 : 0.8, now, 0.04);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCrowd();
    void this.ctx.close().catch(() => {});
  }
}
