/**
 * Test-only: a recording stand-in for (Offline)AudioContext. Node has no
 * WebAudio, so unit tests build the recipes' graphs against this and check
 * their structure and automation (what would throw or glitch in a browser)
 * instead of listening to them. Never imported by game code.
 */

export type ParamEvent =
  | { kind: "set" | "linear" | "exp"; time: number; value: number }
  | { kind: "target"; time: number; value: number; tc: number }
  | { kind: "cancel"; time: number };

export class MockParam {
  value: number;
  readonly owner: MockNode;
  readonly name: string;
  readonly events: ParamEvent[] = [];
  /** Things a browser would throw on or that would glitch audibly. */
  readonly problems: string[];

  constructor(owner: MockNode, name: string, value: number, problems: string[]) {
    this.owner = owner;
    this.name = name;
    this.value = value;
    this.problems = problems;
  }

  private check(what: string, time: number, value: number): void {
    if (!Number.isFinite(time) || time < 0) this.problems.push(`${this.owner.kind}.${this.name} ${what}: bad time ${time}`);
    if (!Number.isFinite(value)) this.problems.push(`${this.owner.kind}.${this.name} ${what}: bad value ${value}`);
  }

  /** The value the param holds just before `time` (last event at or before it, else the intrinsic value). */
  valueBefore(time: number): number {
    let v = this.value;
    let at = -Infinity;
    for (const e of this.events) {
      if (e.kind !== "cancel" && e.time <= time && e.time >= at) {
        v = e.value;
        at = e.time;
      }
    }
    return v;
  }

  /**
   * The automated value at `time`, following the WebAudio timeline rules for
   * set / linear / exponential / target events (enough to spot a source that
   * stops while its envelope is still open, i.e. a click).
   */
  valueAt(time: number): number {
    const evs = this.events.filter((e) => e.kind !== "cancel").sort((a, b) => a.time - b.time) as Exclude<ParamEvent, { kind: "cancel" }>[];
    let v = this.value;
    let vt = 0;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i] as Exclude<ParamEvent, { kind: "cancel" }>;
      if (e.time > time) {
        if (e.kind === "linear") return v + (e.value - v) * ((time - vt) / (e.time - vt));
        if (e.kind === "exp" && v !== 0 && Math.sign(v) === Math.sign(e.value)) return v * Math.pow(e.value / v, (time - vt) / (e.time - vt));
        return v;
      }
      if (e.kind === "target") {
        const next = evs[i + 1];
        const until = Math.min(time, next ? next.time : Infinity);
        v = e.value + (v - e.value) * Math.exp(-(until - e.time) / Math.max(1e-9, e.tc));
        vt = until;
        if (until === time) return v;
        continue;
      }
      v = e.value;
      vt = e.time;
    }
    return v;
  }

  setValueAtTime(value: number, time: number) {
    this.check("setValueAtTime", time, value);
    this.events.push({ kind: "set", time, value });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.check("linearRamp", time, value);
    this.events.push({ kind: "linear", time, value });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.check("exponentialRamp", time, value);
    // The browser throws on 0 and holds (then jumps) when the start is 0 or of the other sign.
    if (value === 0) this.problems.push(`${this.owner.kind}.${this.name} exponentialRamp to 0 (RangeError)`);
    const from = this.valueBefore(time);
    if (from === 0 || Math.sign(from) !== Math.sign(value)) this.problems.push(`${this.owner.kind}.${this.name} exponentialRamp from ${from} to ${value} (holds, then jumps)`);
    this.events.push({ kind: "exp", time, value });
    return this;
  }
  setTargetAtTime(value: number, time: number, tc: number) {
    this.check("setTargetAtTime", time, value);
    if (!(tc >= 0)) this.problems.push(`${this.owner.kind}.${this.name} setTargetAtTime bad time constant ${tc}`);
    this.events.push({ kind: "target", time, value, tc });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.events.push({ kind: "cancel", time });
    return this;
  }
}

export class MockBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    const d = this.data[c];
    if (!d) throw new Error(`no channel ${c}`);
    return d;
  }
}

export class MockNode {
  readonly kind: string;
  readonly outputs: (MockNode | MockParam)[] = [];
  readonly params: Record<string, MockParam> = {};
  started: number[] = [];
  stopped: number[] = [];
  type = "";
  buffer: MockBuffer | null = null;
  curve: Float32Array | null = null;
  oversample = "none";
  loop = false;
  normalize = true;
  onended: ((e: Event) => void) | null = null;
  constructor(kind: string, params: Record<string, number>, problems: string[]) {
    this.kind = kind;
    for (const [k, v] of Object.entries(params)) this.params[k] = new MockParam(this, k, v, problems);
  }
  connect<T extends MockNode | MockParam>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
  start(when = 0): void {
    this.started.push(when);
  }
  stop(when = 0): void {
    this.stopped.push(when);
  }
  // AudioParam-shaped accessors the recipes use.
  get frequency() {
    return this.params.frequency as MockParam;
  }
  get detune() {
    return this.params.detune as MockParam;
  }
  get gain() {
    return this.params.gain as MockParam;
  }
  get Q() {
    return this.params.Q as MockParam;
  }
  get playbackRate() {
    return this.params.playbackRate as MockParam;
  }
  get pan() {
    return this.params.pan as MockParam;
  }
  get delayTime() {
    return this.params.delayTime as MockParam;
  }
  get threshold() {
    return this.params.threshold as MockParam;
  }
  get knee() {
    return this.params.knee as MockParam;
  }
  get ratio() {
    return this.params.ratio as MockParam;
  }
  get attack() {
    return this.params.attack as MockParam;
  }
  get release() {
    return this.params.release as MockParam;
  }
}

/** Records every node a graph builder creates. Cast to SynthContext / AudioContext at the call site. */
export class MockContext {
  readonly sampleRate: number;
  readonly nodes: MockNode[] = [];
  readonly problems: string[] = [];
  readonly destination: MockNode;
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.destination = new MockNode("destination", {}, this.problems);
  }
  private node(kind: string, params: Record<string, number> = {}): MockNode {
    const n = new MockNode(kind, params, this.problems);
    this.nodes.push(n);
    return n;
  }
  createOscillator() {
    const n = this.node("oscillator", { frequency: 440, detune: 0 });
    n.type = "sine";
    return n;
  }
  createGain() {
    return this.node("gain", { gain: 1 });
  }
  createBiquadFilter() {
    const n = this.node("biquad", { frequency: 350, Q: 1, gain: 0, detune: 0 });
    n.type = "lowpass";
    return n;
  }
  createBufferSource() {
    return this.node("bufferSource", { playbackRate: 1, detune: 0 });
  }
  createWaveShaper() {
    return this.node("waveShaper");
  }
  createConvolver() {
    return this.node("convolver");
  }
  createDelay() {
    return this.node("delay", { delayTime: 0 });
  }
  createStereoPanner() {
    return this.node("stereoPanner", { pan: 0 });
  }
  createDynamicsCompressor() {
    return this.node("compressor", { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockBuffer(channels, length, sampleRate);
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  /** Fire `ended` on a source, as the browser would when it finishes. */
  end(src: MockNode): void {
    src.onended?.({ target: src } as unknown as Event);
  }
}

const SOURCES = new Set(["oscillator", "bufferSource"]);

export function isSource(n: MockNode): boolean {
  return SOURCES.has(n.kind);
}

/** True if audio from `from` can reach `to` (through nodes, and through params into their owners). */
export function reaches(from: MockNode, to: MockNode): boolean {
  const seen = new Set<MockNode>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop() as MockNode;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const o of n.outputs) stack.push(o instanceof MockParam ? o.owner : o);
  }
  return false;
}
