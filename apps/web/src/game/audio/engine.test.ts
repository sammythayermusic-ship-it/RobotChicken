import { describe, expect, it } from "vitest";
import { AudioEngine } from "./engine";
import { MockBuffer, MockContext, type MockNode, reaches } from "./mockAudio";
import { SOUND_SPECS, type SoundName } from "./names";

function setup() {
  const ctx = new MockContext();
  const engine = new AudioEngine(ctx as unknown as AudioContext);
  const give = (name: SoundName) => engine.setBuffer(name, new MockBuffer(1, 4410, 44100) as unknown as AudioBuffer, "recipe");
  const sources = () => ctx.nodes.filter((n) => n.kind === "bufferSource");
  return { ctx, engine, give, sources };
}

describe("AudioEngine (against a recording context)", () => {
  it("builds buses -> master -> compressor -> destination", () => {
    const { ctx } = setup();
    const comp = ctx.nodes.find((n) => n.kind === "compressor") as MockNode;
    expect(comp.outputs).toContain(ctx.destination);
    const gains = ctx.nodes.filter((n) => n.kind === "gain");
    // master + sfx / crowd / ui
    expect(gains).toHaveLength(4);
    for (const g of gains) expect(reaches(g, ctx.destination)).toBe(true);
  });

  it("skips a sound whose buffer is not ready yet instead of playing it late", () => {
    const { engine, sources } = setup();
    engine.play("hit_light", { pan: 0, seed: 1 });
    expect(sources()).toHaveLength(0);
    expect(engine.played).toEqual([]);
  });

  it("plays through its own gain and panner into its bus, with deterministic jitter", () => {
    const { ctx, engine, give, sources } = setup();
    give("hit_light");
    engine.play("hit_light", { pan: 3, seed: 42 });
    engine.play("hit_light", { pan: -0.4, seed: 42 });
    const [a, b] = sources() as [MockNode, MockNode];
    expect(a.started).toEqual([0]);
    expect(reaches(a, ctx.destination)).toBe(true);
    const rate = a.playbackRate.value;
    expect(Math.abs(rate - 1)).toBeLessThanOrEqual(SOUND_SPECS.hit_light.pitchJitter);
    expect(b.playbackRate.value).toBe(rate);
    const pans = ctx.nodes.filter((n) => n.kind === "stereoPanner").map((n) => n.pan.value);
    expect(pans).toEqual([1, -0.4]);
    const amp = a.outputs[0] as MockNode;
    expect(amp.gain.value).toBe(SOUND_SPECS.hit_light.gain);
    expect(engine.played).toEqual(["hit_light", "hit_light"]);
  });

  it("steals the oldest voice past maxVoices, fading it rather than cutting it", () => {
    const { engine, give, sources } = setup();
    give("hit_slam");
    const max = SOUND_SPECS.hit_slam.maxVoices;
    for (let i = 0; i <= max; i++) engine.play("hit_slam", { seed: i });
    const all = sources();
    expect(all).toHaveLength(max + 1);
    const first = all[0] as MockNode;
    expect(first.stopped.length).toBe(1);
    const amp = first.outputs[0] as MockNode;
    expect(amp.gain.events.some((e) => e.kind === "target" && e.value === 0)).toBe(true);
    for (const s of all.slice(1)) expect(s.stopped).toEqual([]);
  });

  it("a finished voice frees its slot, so the next play steals nothing", () => {
    const { ctx, engine, give, sources } = setup();
    give("scream_ko"); // maxVoices 1
    engine.play("scream_ko");
    ctx.end(sources()[0] as MockNode);
    engine.play("scream_ko");
    expect((sources()[0] as MockNode).stopped).toEqual([]);
    // Still playing: a third play steals the second.
    engine.play("scream_ko");
    expect((sources()[1] as MockNode).stopped).toHaveLength(1);
  });

  it("does not start sounds while muted, suspended or disposed", () => {
    const { ctx, engine, give, sources } = setup();
    give("block");
    engine.setMuted(true);
    engine.play("block");
    engine.setMuted(false);
    ctx.state = "suspended";
    engine.play("block");
    ctx.state = "running";
    engine.dispose();
    engine.play("block");
    expect(sources()).toHaveLength(0);
    expect(ctx.state).toBe("closed");
  });

  it("setMuted ramps the master gain", () => {
    const { ctx, engine } = setup();
    engine.setMuted(true);
    const comp = ctx.nodes.find((n) => n.kind === "compressor");
    const master = ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(comp as MockNode)) as MockNode;
    expect(master.gain.events.at(-1)).toMatchObject({ kind: "target", value: 0 });
    engine.setMuted(false);
    expect(master.gain.events.at(-1)).toMatchObject({ kind: "target", value: 0.8 });
  });

  it("crowd: starts looping on the first hype once rendered, follows hype, and fades if hype stops", () => {
    const { ctx, engine, give, sources } = setup();
    engine.setHype(0.5);
    expect(sources()).toHaveLength(0); // not rendered yet
    give("crowd_loop");
    engine.play("crowd_loop"); // loops are driven by hype, never one-shot
    expect(sources()).toHaveLength(0);
    engine.setHype(0.2);
    const [loop] = sources() as [MockNode];
    expect(loop.loop).toBe(true);
    expect(loop.started).toHaveLength(1);
    const levelNode = (loop.outputs[0] as MockNode).outputs[0] as MockNode;
    const targets = () => levelNode.gain.events.filter((e) => e.kind === "target");
    expect(targets()).toHaveLength(2);
    expect(targets()[1]).toMatchObject({ value: 0, time: 0.6 }); // dead-man fade
    // Tiny change within 100 ms: no new automation.
    engine.setHype(0.205);
    expect(targets()).toHaveLength(2);
    // A real change, or 100 ms later: updates (louder with more hype).
    engine.setHype(0.9);
    expect(targets()).toHaveLength(4);
    expect((targets()[2] as { value: number }).value).toBeGreaterThan((targets()[0] as { value: number }).value);
    ctx.currentTime = 0.5;
    engine.setHype(0.9);
    expect(targets()).toHaveLength(6);
    // Brighter with hype.
    const tone = loop.outputs[0] as MockNode;
    expect(tone.kind).toBe("biquad");
    const f = tone.frequency.events.filter((e) => e.kind === "target").map((e) => (e as { value: number }).value);
    expect(f[1] as number).toBeGreaterThan(f[0] as number);
  });

  it("a file replacing the crowd bed restarts the loop with the new buffer", () => {
    const { engine, give, sources } = setup();
    give("crowd_loop");
    engine.setHype(0.3);
    engine.setBuffer("crowd_loop", new MockBuffer(1, 100, 44100) as unknown as AudioBuffer, "file");
    expect((sources()[0] as MockNode).stopped).toHaveLength(1);
    engine.setHype(0.3);
    expect(sources()).toHaveLength(2);
    expect(engine.sourceOf("crowd_loop")).toBe("file");
  });

  it("keeps only the 32 most recent played names", () => {
    const { engine, give } = setup();
    give("ui_move");
    for (let i = 0; i < 40; i++) engine.play("ui_move");
    expect(engine.played).toHaveLength(32);
  });
});
