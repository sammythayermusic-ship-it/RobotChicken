/**
 * Golden replay runner. Prints `<name> <ticks> <hash>` per replay (stdout is
 * diffed across machines in CI) and exits 1 if any hash differs from the one
 * committed. `--bless` rewrites rulesHash, finalHash and checkpoints instead.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, runReplay, type Replay } from "../src/index";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "golden");
const bless = process.argv.includes("--bless");
let failed = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".replay.json")).sort()) {
  const path = join(dir, file);
  const r = JSON.parse(readFileSync(path, "utf8")) as Replay;
  const name = file.replace(/\.replay\.json$/, "");
  if (bless) {
    const res = runReplay({ ...r, rulesHash: RULES.hash }, RULES);
    const out: Replay = { ...r, name, rulesHash: RULES.hash, finalHash: res.hash, cp: res.cps };
    writeFileSync(path, JSON.stringify(out) + "\n");
    console.log(`${name} ${res.ticks} ${res.hash}`);
    continue;
  }
  try {
    const res = runReplay(r, RULES);
    console.log(`${name} ${res.ticks} ${res.hash}`);
    if (res.hash !== r.finalHash) {
      console.error(`MISMATCH ${name}: expected ${r.finalHash}`);
      failed++;
    }
  } catch (e) {
    console.error(`ERROR ${name}: ${(e as Error).message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
