import { describe, expect, it } from "vitest";
import { St, createMatch } from "@cockfight/sim";
import { HudStore } from "../hud/hudStore";
import { FightCamera } from "../view/camera/FightCamera";
import { Director } from "./director";
import type { KoPulse } from "./KoPulse";
import type { Particles } from "./Particles";

function setup() {
  const hud = new HudStore();
  const d = new Director({
    camera: new FightCamera(16 / 9),
    particles: { burst() {} } as unknown as Particles,
    ko: {} as KoPulse,
    hud,
    seed: 1,
  });
  return { d, hud };
}

describe("Director", () => {
  it("tells the HUD whether P1 is off the floor and can dive (the touch context button)", () => {
    const { d, hud } = setup();
    const s = createMatch({ matchId: "director-air" });
    d.tick(s, []);
    expect(hud.get().air).toBe(false);
    s.f[0].grounded = 0;
    s.f[0].y = 900;
    s.f[0].st = St.jump;
    s.f[0].vy = 100;
    d.tick(s, []);
    expect(hud.get().air).toBe(true);
    expect(hud.get().dive).toBe(true);
    // Falling below the dive's lowest start, or with the dive spent: DIVE can't happen.
    s.f[0].vy = -100;
    s.f[0].y = 300;
    d.tick(s, []);
    expect(hud.get().dive).toBe(false);
    s.f[0].y = 1500;
    s.f[0].diveUsed = 1;
    d.tick(s, []);
    expect(hud.get().dive).toBe(false);
    // No player of this browser (2P on one keyboard): nothing published, nothing re-rendered.
    hud.set({ mode: "2p", you: null });
    s.f[0].diveUsed = 0;
    d.tick(s, []);
    expect(hud.get().air).toBe(false);
  });

  it("online as P2: the on-screen buttons follow P2", () => {
    const { d, hud } = setup();
    hud.set({ mode: "online", you: 1 });
    const s = createMatch({ matchId: "dir-p2" });
    s.f[1].grounded = 0;
    s.f[1].y = 900;
    s.f[1].st = St.jump;
    s.f[1].vy = 100;
    d.tick(s, []);
    expect(hud.get().air).toBe(true);
    expect(hud.get().dive).toBe(true);
  });
});
