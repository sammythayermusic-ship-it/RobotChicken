/**
 * Golden replay runner. Prints `<name> <ticks> <finalHash> <traceHash>` per
 * replay (stdout is diffed across machines in CI) and exits 1 if the final
 * hash, the whole-trajectory hash or any checkpoint differs from what is
 * committed. `--bless` rewrites rulesHash, the hashes and checkpoints instead.
 * Integer / division-by-zero checks are on, so a float or NaN leaking into the
 * state fails here too.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, runReplay, setFixedChecks, type Replay } from "../src/index";

setFixedChecks(true);

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "golden");
const bless = process.argv.includes("--bless");
let failed = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".replay.json")).sort()) {
  const path = join(dir, file);
  const r = JSON.parse(readFileSync(path, "utf8")) as Replay;
  const name = file.replace(/\.replay\.json$/, "");
  if (bless) {
    const res = runReplay({ ...r, rulesHash: RULES.hash }, RULES);
    const out: Replay = { ...r, name, rulesHash: RULES.hash, finalHash: res.hash, traceHash: res.trace, cp: res.cps };
    writeFileSync(path, JSON.stringify(out) + "\n");
    console.log(`${name} ${res.ticks} ${res.hash} ${res.trace}`);
    continue;
  }
  try {
    const res = runReplay(r, RULES);
    console.log(`${name} ${res.ticks} ${res.hash} ${res.trace}`);
    if (res.hash !== r.finalHash || res.trace !== r.traceHash) {
      console.error(`MISMATCH ${name}: expected ${r.finalHash} ${r.traceHash}`);
      failed++;
    }
    const cp = r.cp ?? [];
    const bad = res.cps.findIndex((c, i) => c[0] !== cp[i]?.[0] || c[1] !== cp[i]?.[1]);
    if (bad >= 0 || res.cps.length !== cp.length) {
      console.error(`MISMATCH ${name}: checkpoint ${bad >= 0 ? `at tick ${res.cps[bad]?.[0]}` : "count"} differs`);
      failed++;
    }
  } catch (e) {
    console.error(`ERROR ${name}: ${(e as Error).message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
