import { describe, expect, it } from "vitest";
import { MockBuffer, MockContext, MockNode, isSource, reaches } from "./mockAudio";
import { SOUND_NAMES, SOUND_SPECS } from "./names";
import { seedFor } from "./offline";
import { FIRST_HITS, RECIPES, RENDER_ORDER } from "./recipes";
import { rng, type SynthContext } from "./synth";

/** The first automated gain downstream of a source (through filters and shapers): its envelope. */
function envelopeOf(src: MockNode): MockNode | null {
  const queue: MockNode[] = [src];
  const seen = new Set<MockNode>();
  while (queue.length) {
    const n = queue.shift() as MockNode;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n !== src && n.kind === "gain" && n.gain.events.length > 0) return n;
    for (const o of n.outputs) if (o instanceof MockNode) queue.push(o);
  }
  return null;
}

/** True if `src` reaches `out` through audio connections alone (not by modulating a param). */
function audibleFrom(src: MockNode, out: MockNode): boolean {
  const stack: MockNode[] = [src];
  const seen = new Set<MockNode>();
  while (stack.length) {
    const n = stack.pop() as MockNode;
    if (n === out) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const o of n.outputs) if (o instanceof MockNode) stack.push(o);
  }
  return false;
}

/** The last 2 ms of a buffer are under 1% of its peak. */
function tailIsSilent(b: MockBuffer): boolean {
  const d = b.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i] as number));
  let tail = 0;
  for (let i = Math.max(0, d.length - Math.round(b.sampleRate * 0.002)); i < d.length; i++) tail = Math.max(tail, Math.abs(d[i] as number));
  return tail <= peak * 0.01;
}

/** Builds a recipe's graph against the recording context. */
function build(name: (typeof SOUND_NAMES)[number]) {
  const ctx = new MockContext();
  const out = ctx.createGain();
  out.connect(ctx.destination);
  RECIPES[name].render(ctx as unknown as SynthContext, out as unknown as AudioNode, rng(seedFor(name)));
  return { ctx, out };
}

describe("audio recipes", () => {
  it("every SoundName has a recipe and a spec", () => {
    for (const n of SOUND_NAMES) {
      expect(RECIPES[n], n).toBeDefined();
      expect(SOUND_SPECS[n], n).toBeDefined();
      expect(RECIPES[n].seconds, n).toBeGreaterThan(0);
      expect(RECIPES[n].seconds, n).toBeLessThanOrEqual(10);
    }
    expect(Object.keys(RECIPES).sort()).toEqual([...SOUND_NAMES].sort());
  });

  it("loudness overrides stay in a sane range (they size sounds, not replace SOUND_SPECS gains)", () => {
    for (const n of SOUND_NAMES) {
      const l = RECIPES[n].loudness;
      if (l !== undefined) {
        expect(l, n).toBeGreaterThan(0.03);
        expect(l, n).toBeLessThanOrEqual(0.2);
      }
    }
  });

  it("only loops have a loop tail, and every looping spec has one", () => {
    for (const n of SOUND_NAMES) expect(Boolean(RECIPES[n].loopTail), n).toBe(Boolean(SOUND_SPECS[n].loop));
  });

  it("render order lists every sound once, first-exchange sounds first", () => {
    expect([...RENDER_ORDER].sort()).toEqual([...SOUND_NAMES].sort());
    for (const n of FIRST_HITS) expect(RENDER_ORDER.indexOf(n), n).toBeLessThan(8);
  });

  it("seeds are stable and distinct per sound", () => {
    expect(seedFor("hit_light")).toBe(seedFor("hit_light"));
    expect(new Set(SOUND_NAMES.map(seedFor)).size).toBe(SOUND_NAMES.length);
  });

  for (const name of SOUND_NAMES) {
    it(`${name}: builds a sound graph a browser would accept`, () => {
      const { ctx, out } = build(name);
      const r = RECIPES[name];
      const end = r.seconds + (r.loopTail ?? 0);
      expect(ctx.problems, "automation problems").toEqual([]);

      const sources = ctx.nodes.filter(isSource);
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.started.length, `${s.kind} started once`).toBe(1);
        const t = s.started[0] as number;
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t, `${s.kind} starts inside the buffer`).toBeLessThan(end);
        for (const stop of s.stopped) expect(stop).toBeGreaterThanOrEqual(t);
        expect(reaches(s, out), `${s.kind} reaches the output`).toBe(true);
        if (s.kind === "bufferSource") expect(s.buffer, "buffer set").not.toBeNull();
      }
      for (const n of ctx.nodes) {
        if (n === out) continue;
        expect(n.outputs.length, `${n.kind} is connected`).toBeGreaterThan(0);
        if (n.kind === "waveShaper") expect(n.curve?.length).toBeGreaterThan(0);
        if (n.kind === "convolver") expect(n.buffer).not.toBeNull();
        for (const p of Object.values(n.params)) {
          for (const e of p.events) {
            expect(e.time, `${n.kind}.${p.name} event inside the buffer`).toBeLessThanOrEqual(end + 0.05);
            if (e.kind !== "cancel" && n.kind === "oscillator" && p.name === "frequency") {
              expect(e.value, "oscillator below Nyquist").toBeLessThan(ctx.sampleRate / 2);
              expect(e.value, "oscillator above 0 Hz").toBeGreaterThan(0);
            }
          }
        }
      }
    });
  }

  it("no source stops (or its buffer runs out) while its envelope is still open: no clicks", () => {
    for (const name of SOUND_NAMES) {
      const { ctx, out } = build(name);
      const r = RECIPES[name];
      const end = r.seconds + (r.loopTail ?? 0);
      for (const s of ctx.nodes.filter(isSource)) {
        // Modulators (LFOs, ring-mod carriers) only reach the output through a param.
        if (!audibleFrom(s, out)) continue;
        const start = s.started[0] as number;
        const stop = s.stopped[0] ?? (s.buffer ? start + s.buffer.duration : Infinity);
        if (stop >= end - 0.005) continue; // runs to the end; the post-render fade covers it
        if (s.buffer && !s.stopped.length && tailIsSilent(s.buffer)) continue; // the buffer fades itself (claps)
        const env = envelopeOf(s);
        expect(env, `${name}: ${s.kind} at ${start}s has an envelope`).not.toBeNull();
        const peak = Math.max(...(env as MockNode).gain.events.map((e) => ("value" in e ? Math.abs(e.value) : 0)));
        const at = (env as MockNode).gain.valueAt(stop);
        expect(Math.abs(at), `${name}: ${s.kind} started at ${start.toFixed(3)}s stops at ${stop.toFixed(3)}s with its gain at ${at.toFixed(4)}`).toBeLessThanOrEqual(peak * 0.01 + 1e-6);
      }
    }
  });

  it("recipes are pure: the same seed builds the same graph", () => {
    for (const name of ["hit_slam", "crowd_loop", "scream_heavy"] as const) {
      const a = build(name).ctx;
      const b = build(name).ctx;
      const sig = (ns: MockNode[]) => ns.map((n) => `${n.kind}:${n.started.join()}:${Object.values(n.params).map((p) => p.events.map((e) => ("value" in e ? e.value.toFixed(6) : "c")).join(","))}`);
      expect(sig(a.nodes)).toEqual(sig(b.nodes));
    }
  });
});
