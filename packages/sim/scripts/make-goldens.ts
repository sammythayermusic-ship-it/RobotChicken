/**
 * (Re)generates the input logs of the scripted and CPU golden replays. Run
 * once when the fixtures are created or the CPU changes, then `--bless`:
 *   tsx scripts/make-goldens.ts && tsx scripts/replay-golden.ts --bless
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  B, CPU_LEVELS, Phase, RULES, compressInputs, cpuThink, createCpu, createMatch, step, type Replay,
} from "../src/index";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "golden");

function save(name: string, r: Omit<Replay, "rulesHash" | "finalHash">): void {
  const out: Replay = { ...r, name, rulesHash: RULES.hash, finalHash: "" };
  writeFileSync(join(dir, `${name}.replay.json`), JSON.stringify(out) + "\n");
  console.log(`wrote ${name} (${r.ticks} ticks)`);
}

// CPU vs CPU, hard vs normal, five seeds.
for (let seed = 1; seed <= 5; seed++) {
  const matchId = `golden-cpu-${seed}`;
  const c1 = createCpu(matchId, 0);
  const c2 = createCpu(matchId, 1);
  let s = createMatch({ matchId });
  const m1: number[] = [];
  const m2: number[] = [];
  while (s.phase !== Phase.matchEnd && s.tick < 30000) {
    const b1 = cpuThink(s, 0, c1, CPU_LEVELS.hard);
    const b2 = cpuThink(s, 1, c2, CPU_LEVELS.normal);
    m1.push(b1);
    m2.push(b2);
    s = step(s, b1, b2);
  }
  save(`cpu-seed${seed}`, { v: 1, matchId, ticks: m1.length, p1: compressInputs(m1), p2: compressInputs(m2) });
}

// Every move, scripted: [buttons, ticks] per player.
type Script = [number, number][];
function expand(script: Script): number[] {
  const out: number[] = [];
  for (const [b, n] of script) for (let k = 0; k < n; k++) out.push(b);
  return out;
}
const S = B.S;
const p1: Script = [
  [0, 180], // countdown
  [B.R, 45], [0, 2], // walk in
  [S, 1], [0, 20], // peck
  [B.R | S, 1], [0, 30], // shove
  [B.R, 60], [0, 2],
  [B.D | S, 1], [0, 60], // slam
  [B.R, 1], [0, 2], [B.R, 1], [0, 20], // dash
  [B.U | B.R, 1], [B.R, 6], [B.R | S, 1], [0, 40], // jump -> dive kick (the early press waits for the dive gate)
  [B.L, 1], [0, 2], [B.L, 1], [0, 20], // back dash
  [B.D, 40], [0, 5], // block
  [B.R, 90], [0, 1], [S, 1], [0, 13], [B.R | S, 1], [0, 40], // peck, then a buffered shove (cancels only go into the super)
];
const p2: Script = [
  [0, 180],
  [B.L, 20], [0, 60],
  [B.D, 50], [0, 10], // blocks the slam (it is unblockable)
  [B.L | S, 1], [0, 40],
  [B.D | S, 1], [0, 60],
  [B.U, 1], [0, 60],
];
const a = expand(p1);
const b = expand(p2);
const ticks = Math.max(a.length, b.length) + 600;
save("every-move", { v: 1, matchId: "golden-every-move", ticks, p1: compressInputs(a), p2: compressInputs(b) });
