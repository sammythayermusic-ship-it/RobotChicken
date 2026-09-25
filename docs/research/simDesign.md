Report: packages/sim design (COCKFIGHT Phase 0–1). I did the research read-only and wrote no files. I checked the numbers below in `node -e`: the jump arc, a two-lane FNV-1a-64 against a BigInt reference over 2,000 random inputs, and truncation/-0 behaviour.

## 0. Toolchain for sim
- No runtime dependencies. `"type":"module"`. Source-only TS, used by web, game and tools.
- Dev dependencies: `fast-check@^4.10.2` (latest, 2026-09-19). vitest should be whatever the repo pins: 5.0.1 is latest (released 2026-09-15, needs Node ≥22.12, fine on 22.22.2); soltendogs runs on 4.1.11.
- Use `const` objects, not TS `enum`, so the code works with Node type-stripping / `erasableSyntaxOnly`.
- Import JSON as `import moves from "../data/moves.json" with { type: "json" }`. Plain Node ESM needs the attribute. Smoke-test it in Phase 0 under tsx, vitest and Turbopack.
- Lint for `packages/sim/src/**`, using `no-restricted-globals` / `no-restricted-properties`: ban `Date`, `performance`, `Math.random`, `Math.sqrt`, `sin`, `cos`, `pow`, `atan2` and `**` on non-integers. Allow `Math.trunc`, `abs`, `min`, `max`, `imul`, `sign`.

## 1. Fixed-point conventions (a)
- Units:
  - Position: mu = 1/1000 unit. Velocity: mu/tick.
  - HP: ×100, so `HP_MAX=10000`. This makes 10% chip exact for every move: peck 600 → 60, super 3000 → 300.
  - Heat: ×60, so `HEAT_MAX=6000`. Decay 1/s becomes exactly −1 per tick; +8 → +480; +3 → +180.
  - Time: ticks at 60 Hz.
- Booleans are stored as `0|1`. Every state field is an integer in int32 range, except `rng`, which is uint32 and serialized `|0`.
- **One division rule: truncate toward zero.** `export const idiv = (a:number,b:number) => (a/b)|0;`
  - Truncation is mirror-symmetric (`idiv(-a,b) === -idiv(a,b)`); floor division would make P1 and P2 behave differently.
  - `|0` also kills `-0` (`Math.trunc(-1/2)` returns `-0`).
  - It is exact while the quotient fits int32 and the dividend is below 2^52.
  - `mulDiv(a, pct, 100)` is used for chip.
  - Nothing else divides. Collision compares products instead.
- **Jump** (update order per tick: `y+=vy; vy-=G`; floor at `y<=0`). For N airborne ticks, `V0 = G·N/2`, and G·N must be even.
  - `G=15`, `V0=270`, so `y_n = 15·n(37−n)/2`.
  - y > 0 for n = 1..36, so there are exactly **36 airborne ticks**. On step 37, y = 0 exactly and the fighter lands.
  - Apex is 2565 mu (2.57 units) on ticks 18–19 (verified).
  - Horizontal jump speed: `vxFwd=55`, `vxBack=45`.
- **Dive (45°):** velocity `(±180, −180)`, integer and exactly diagonal, with no gravity during the dive. From the apex it takes 15 ticks to reach the ground.
- **Launch (slam and super):** `(160, 180)` under the same G. That is 25 airborne ticks and a 4.0-unit carry (verified).
- **Walk:** forward 60 mu/tick, back 45. **Dash:** forward 160 × 9 frames = 1.44 u; back 150 × 8 frames = 1.2 u.

## 2. Types (b)
```ts
export const B = { L:1, R:2, U:4, D:8, S:16 } as const;           // wire bitmask
export const Phase = { countdown:0, fighting:1, roundEnd:2, matchEnd:3 } as const;
export const St = { idle:0, walkF:1, walkB:2, dashF:3, dashB:4, jump:5, fall:6, land:7, block:8,
  blockStun:9, attack:10, hitStun:11, launched:12, knockdown:13, getup:14, ko:15, ringOut:16, win:17 } as const;
export const Mv = { none:0, peck:1, shove:2, slam:3, dive_kick:4, super:5 } as const;
export const Reason = { none:0, ko:1, ringout:2, timeout:3, suddenDeath:4, doubleKo:5, sdExpired:6 } as const;

export interface FighterState {
  x:number; y:number; vx:number; vy:number; facing:1|-1; grounded:0|1;
  hp:number; heat:number;
  st:StId; stTick:number; move:MvId;         // move frame = stTick+1 (1-based)
  hitstop:number; stun:number; invuln:number; // remaining ticks
  hitDone:0|1; diveUsed:0|1; roAble:0|1;      // move connected; one dive/jump; wall off => ring-out possible
  slideV:number; slideT:number;               // push knockback mu/tick, ticks left
  held:number;                                // SOCD-cleaned buttons this tick (= prev for edge detect)
  tapL:number; tapR:number;                   // ticks since last L/R press edge, saturate 255
  bufS:number; dashReq:-1|0|1;                // Space buffer (5), pending dash (world dir)
  hitT:number; hitMv:MvId; hitKind:0|1|2;     // last contact received (tick, move, 1=hit 2=block) -> FX trigger
}
export interface MatchState {
  v:1; tick:number; phase:PhaseId; phaseT:number; timer:number; sd:0|1;
  round:number; w1:number; w2:number; roundWinner:-1|0|1|2; reason:ReasonId; matchWinner:-1|0|1|2;
  rng:number; f:[FighterState, FighterState];
}
```
- **Direction relative to facing:** `fwd = facing>0 ? R : L` and `back` is the other, resolved at decision time.
- **SOCD cleaning:** L+R is treated as neither; U+D is treated as neither.
- **Dash detection:** on an L press edge, if `tapL <= 12` then dash and set `tapL = 255` (so a triple tap is not two dashes); otherwise set `tapL = 0`. `tapL` increments every tick before the check, so press→press at 12 ticks (200 ms) qualifies and 13 does not.
- **Attacks are edge-triggered with a 5-tick buffer.** `bufS` does not decrement while the fighter is in hitstop, otherwise an 8-tick hitstop would eat the buffer.
- **Jump is level-triggered** (hold ↑ to re-jump after the 4-tick landing lag).
- **Renderer FX:** the renderer fires effects when it sees a new `(hitT, hitKind)` pair. This dedupes across rollback re-simulation.

## 3. Pure API, cloned internally (c)
`step(prev, b1, b2, R = RULES): MatchState` never mutates `prev`. It does `s = cloneState(prev)` and then mutates `s` in place through the phases.
- **Why:** rollback keeps a ring buffer `hist[tick & 63]` of returned states. Because step is pure, storing references is safe, with no aliasing bugs and no defensive copies.
- **Cost:** every nested value is a primitive, so the clone is `{...s, f:[{...f0},{...f1}]}`, three allocations, about 1 µs. Load is roughly 60 + ~200 re-sim steps/s on the client and 12k steps/s for 200 server matches. That is negligible, far under the 8 ms p95 target.
- **Tests enforce purity** by deep-freezing `prev`.
- `R` (the compiled rules) is a parameter with a default, so old replays can run against old rules.

## 4. step() ordering
```
1  s=clone(prev); s.tick++; if matchEnd return s; live = phase==fighting
2  readInput(f_i, live ? b_i : 0)       // edges, taps, bufS, dashReq. Countdown feeds 0, so a key held
                                         // through countdown becomes a press edge on the first fighting tick
3  for i: frozen[i] = f.hitstop>0; if frozen { f.hitstop--; continue }
       timers: stTick++, stun--, invuln--, slideT--
       end-of-state: move frame > total -> idle; stun==0 -> idle; land lag; knockdown(40) -> getup(20, invuln) -> idle
       if live && actionable: action priority (below); cancels: attack && hitDone && frame in window && bufS
       set velocity: walk, dash frame table, dive, slide; air keeps vx
4  physics (skip frozen): x += vx + slideV; airborne: y+=vy; vy-=G; if y<=0 -> y=0, land/knockdown/diveRecovery
       wall clamp |x|<=9500 for outward motion unless roAble
5  pushbox separation (symmetric, wall-aware)
6  facing auto-flip: grounded fighters in idle/walk/block/land face the opponent (keep facing if dx==0)
7  if live: hits = [detect(0->1), detect(1->0)]    // both computed before any apply => clean trades
8  apply: blocked = defender grounded && st in {block, blockStun} && move.blockable
       blocked: chip, blockstun, push(onBlock), hitstop both = blockHitstop, attacker heat += 180
       hit:     sd ? hp=0 : hp-=dmg, hitstun or launch, hitstop both, attacker heat += 480, roAble = move.ringOut
       attacker.hitDone = 1; record hitT/hitMv/hitKind; clamp hp>=0
9  if live: ring-out (roAble && |x|>10000 -> st=ringOut) / KO (hp==0 -> st=ko) -> endRound(reason); both -> doubleKo draw
10 heat decay (live): heat>0 && !(heat==MAX) -> heat--       // latch at max
11 clock: countdown: --phaseT==0 -> fighting, clear bufs
          fighting: --timer==0 -> timeout()
          roundEnd: --phaseT==0 -> (w>=2 or round>=5) ? matchEnd : resetRound()
```
Grounded action priority when actionable (idle, walk, block, land-cancel-free):
1. `bufS` pressed:
   - `heat==MAX && !D && !fwd` → **super**
   - else if `D` → **slam**
   - else if `fwd` → **shove**
   - else → **peck**
2. `dashReq` → dash
3. `U` → jump (vx from fwd/back)
4. `D` → block
5. fwd/back → walk
6. otherwise idle

In the air: `bufS && st==jump && stTick>=4 && y>=900 && !diveUsed` → dive_kick.

Hitstop comes out exact: a hit on tick T with hitstop 3 freezes T+1..T+3, because the hitstop set in phase 8 is not decremented until phase 3 of the next tick.

## 5. moves.json (d)
Frame convention: frame 1 is the tick the input is processed. First active frame = startup+1; total = S+A+R.
```json
{ "version":1,
  "units":{"pos":"mu=1/1000u","hp":"1/100","heat":"1/60","time":"ticks@60"},
  "match":{"countdown":180,"round":3600,"roundEnd":120,"suddenDeath":1800,"winsNeeded":2,"maxRounds":5,
           "startX":2500,"wallEdge":9500,"ringEdge":10000},
  "heat":{"max":6000,"onHit":480,"onBlock":180,"decayPerTick":1,"latchAtMax":true,"blockerGain":0},
  "fighter":{"hpMax":10000,"gravity":15,"walkFwd":60,"walkBack":45,"inputBuffer":5,
    "pushbox":{"halfW":400,"h":1200},"hurtFallback":{"ax":0,"ay":250,"bx":0,"by":950,"r":350},
    "jump":{"vy":270,"vxFwd":55,"vxBack":45,"airTicks":36,"landLag":4,"clip":"jump","fallClip":"fall","landClip":"land"},
    "dash":{"window":12,"duration":12,"invuln":[3,6],"fwd":{"speed":160,"frames":9},"back":{"speed":150,"frames":8},"clip":"dash"},
    "block":{"chipPct":10,"clip":"block","stunClip":"block_hit"},
    "knockdown":{"lie":40,"getup":20,"clips":["knockdown","getup"]}},
  "moves":{
    "peck":{"clip":"peck","startup":4,"active":2,"recovery":8,"damage":600,"blockable":true,"hitsAir":true,
      "hitstun":14,"blockstun":8,"hitstop":3,"blockHitstop":3,"heat":[480,180],
      "onHit":{"push":[300,6]},"onBlock":{"push":[240,6]},"ringOut":false,"reaction":"hit_light",
      "cancel":[{"into":["shove","super"],"on":"hit","frames":[5,10]}],"box":{"x":750,"y":800,"r":220}},
    "shove":{"clip":"shove","startup":8,"active":3,"recovery":16,"damage":400,"blockable":true,"hitsAir":false,
      "hitstun":24,"blockstun":12,"hitstop":3,"blockHitstop":3,"heat":[480,180],
      "onHit":{"push":[2000,10]},"onBlock":{"push":[1000,10]},"ringOut":true,"reaction":"hit_light",
      "box":{"x":700,"y":600,"r":300}},
    "slam":{"clip":"slam","startup":14,"active":4,"recovery":22,"damage":1800,"blockable":false,"hitsAir":false,
      "hitstop":8,"heat":[480,0],"onHit":{"launch":[160,180]},"ringOut":true,"reaction":"hit_heavy",
      "box":{"x":800,"y":150,"r":350}},
    "dive_kick":{"clip":"dive_kick","air":true,"startup":6,"activeMax":40,"recovery":14,"dive":[180,-180],
      "minAirTick":4,"minY":900,"damage":1000,"blockable":false,"hitsAir":true,"hitstun":18,"hitstop":3,
      "heat":[480,0],"onHit":{"push":[400,8]},"bounce":[-40,150],"ringOut":false,"reaction":"hit_light",
      "box":{"x":400,"y":-100,"r":250}},
    "super":{"clip":"super","startup":10,"active":6,"recovery":30,"damage":3000,"blockable":true,"hitsAir":true,
      "fullScreen":{"maxY":1800},"invuln":[1,16],"heatCost":6000,"blockstun":20,"hitstop":8,"blockHitstop":8,
      "heat":[0,0],"onHit":{"launch":[160,180]},"onBlock":{"push":[600,10]},"ringOut":true,"reaction":"hit_heavy"}}}
```
- **Frame advantage:** peck is +5 on hit, so peck→peck links; pushback limits the chain to 2–3. Peck is −1 on block. A peck on its cancel window combos into shove or super. Shove leaves the defender 2 units away. Slam whiff is −22 and punishable.
- **Dive kick:** the 6 startup frames are a mid-air hover with v = 0. It is active until landing, capped at 40 ticks. On whiff the fighter lands with 14 ticks of recovery. On hit the attacker bounces to `fall` and then gets a 4-tick land.
- **Validation** (`rules.ts` plus a test):
  - all frame counts are positive integers
  - push `dist % ticks == 0`
  - clip names are among the spec's 21 (back dash reuses `dash`)
  - `vy === gravity*airTicks/2`
- **`rulesHash`** is FNV-1a-64 of canonical moves.json + hitboxes.json. It goes into every replay.
- **hitboxes.json** (generated by the bake tool, committed):
  - Format: `{v, glb, glbSha256, hz:60, clips:{peck:{n, hurt:[ax,ay,bx,by,r ×n], hit:[x,y,r ×n]}}}`.
  - Coordinates are root-relative, facing +x, integers in mu.
  - A shared `clipSample(move, frame)` maps sim frames to clip samples piecewise by phase, using `clipMarks:[startupEndSample, activeEndSample]` (default is proportional): `idiv((f-1)*m0, S)`, then `m0 + idiv((f-S-1)*(m1-m0), A)`, and so on.
  - Renderer and sim call the same function, so visuals and hitboxes always line up and retiming never needs a re-bake.
  - A missing clip falls back to `box` / `hurtFallback`, and `compileRules` logs which moves use the fallback.
- **The bake is gameplay data.** A new hero glb changes hit results. It has to ship in packages/sim, change `rulesHash`, and invalidate the golden fixtures on purpose.

## 6. Collision, pushbox, edges (e)
```ts
export function capsuleHitsCircle(ax,ay,bx,by,r, cx,cy,q){ const R=r+q;
  if (cx<Math.min(ax,bx)-R||cx>Math.max(ax,bx)+R||cy<Math.min(ay,by)-R||cy>Math.max(ay,by)+R) return false; // keeps products < 2^53
  const dx=bx-ax,dy=by-ay,wx=cx-ax,wy=cy-ay,wd=wx*dx+wy*dy;
  if (wd<=0) return wx*wx+wy*wy<=R*R;
  const dd=dx*dx+dy*dy; if (wd>=dd){const ex=cx-bx,ey=cy-by; return ex*ex+ey*ey<=R*R;}
  const cr=wx*dy-wy*dx; return cr*cr<=R*R*dd; }
```
- **The AABB early-out is required.** Without it, cross-arena `cr²` reaches about 2.6e16, which is above 2^53.
- **World coordinates:** `x + facing*lx`, `y + ly`.
- **Hurtbox is off** during `invuln > 0`, dash frames 3–6, super frames 1–16, knockdown/getup, ko and ringOut.
- **Super** hits any hurtbox with `y ≤ 1800` anywhere in the arena. **Slam** (`hitsAir:false`) needs the defender grounded.
- **Pushbox:** AABB with halfW 400 and height 1200, resolved on x only.
  - Overlap `o` is split `idiv(o,2)` / rest. If one fighter is pinned at the wall, the other takes all of it.
  - If `dx == 0`: the fighter facing +1 goes left; if both face the same way, P1 goes left.
  - An airborne fighter above 1200 passes over. Facing flips on landing.
- **Ring-out rule:** self-propelled motion (walk, dash, jump, dive) stops at the wall `|x| ≤ 9500` and cannot go further outward. A ring-out happens only when a *hit* from a `ringOut:true` move (shove, slam, super) sets `roAble` and the fighter's center crosses `|x| > 10000`.
  - Blocked hits and pecks never ring out. Near the wall, any push excess moves the attacker back instead (computed at hit time as a slide).
  - Why: no suicide walk-offs in a money game, and no peck-spam cheese at the edge. The edge is still deadly because slam is unblockable, and shove on hit pushes 2 units (setup) or kills if the defender is already within 2 units.
  - `roAble` clears on landing or when the slide ends.
  - The ringOut state keeps applying gravity with no floor; clamp `y ≥ −20000`.

## 7. Rounds, match, Heat (f)
- **Round timing:**
  - Countdown: steps 1..180. Fighting starts on step 181.
  - Fighting lasts 3600 steps (`timer` 3600 → 0). HUD shows `ceil(timer/60)`.
- **"KO freeze 2 s" and "roundEnd 2 s" are the same 120 ticks.**
  - On KO, wins are incremented immediately so the round pips update.
  - During those ticks, physics and animation keep stepping (launch arcs and ring-out falls play out), inputs are forced to 0, and hit detection and ring-out checks are off.
  - The renderer can add slow-mo.
  - After 120 ticks: match end, or `resetRound` (HP, Heat, positions ±2500, facings, buffers) and a new countdown.
- **Timeout:** higher HP wins (`Reason.timeout`).
- **Equal HP at timeout → sudden death:** `sd=1`, `timer=1800`, positions stay where they are.
  - The first clean hit (not blocked) sets the defender's hp to 0, so it goes through the normal KO path (`Reason.suddenDeath`). A ring-out also wins.
  - If `timer` hits 0 again, the round is a draw.
- **Simultaneous KO or ring-out (a trade):** the round is a draw (`doubleKo`) and neither player scores.
- **`maxRounds` = 5.** After round 5, more wins takes the match; otherwise `matchWinner=2` (draw). Phase 3 treats a draw as no payout.
- The worst case is 5 × 5700 = 28,500 ticks, so every match is guaranteed to end. A property test checks this.
- **Heat:** 0..6000, +480 to the attacker on hit and +180 to the attacker on block. It decays 1 per tick only while fighting, clamps at max, and resets each round.
- **Heat latches at max (no decay while full).** Otherwise "full" lasts under 1 s and the super can't be used on purpose. This is a small deviation from "decays 1/s", flagged for Sammy.

## 8. Rulings (g)
- **Super vs peck:** at full Heat, a grounded Space that is not ↓ and not toward the opponent fires the super. Shove, slam and dive stay available, and the mobile PECK button relabels to SUPER.
  - Why: it matches the spec literally, fits 5 bits and two mobile buttons, and the latch makes it a deliberate choice.
  - A peck that brings Heat to full can cancel straight into super.
- **What "blocks all grounded attacks" means:** ↓ blocks attacks made by a *grounded attacker* (peck, shove, super), with 10% chip.
  - Dive kick is an air attack, so it is not blockable (it acts as an overhead).
  - Slam is explicitly unblockable (low, grounded targets only).
  - Resulting counterplay:
    - Block beats peck and shove.
    - Slam and dive beat block.
    - Peck interrupts slam startup and anti-airs dive.
    - Jump avoids slam.
    - Dash invuln beats the rest.
- **Super** is blockable (3 HP chip), invulnerable on frames 1–16, and ring-out capable. At full Heat it creates a real super-vs-slam mixup, where free unblockable damage would just be cheese.
- **Ring-out counts as a KO.**
- **Sudden death** as described in §7.
- **Heat on block goes to the attacker** (anti-turtle). It is data-configurable via `blockerGain`.

## 9. RNG, hash, replay (h)
- **RNG:** xorshift32 (`x^=x<<13; x^=x>>>17; x^=x<<5; return x>>>0`), seeded with `fnv1a32(matchId) || 0x9E3779B9`, stored in `s.rng` and hashed.
  - Nothing in step() uses it in Phase 1; the design has no randomness.
  - Cosmetic randomness (particles, sound variants) stays client-side and must never read `s.rng`.
  - The CPU has its own RNG.
- **Hash:**
  - A `FIELDS` array fixes the order. `serialize(s): Int32Array` (~70 ints) feeds FNV-1a-64 over little-endian bytes, computed in two 32-bit lanes.
  - Measured: 4 µs per 256 bytes with lanes vs 16 µs with BigInt, so hashing every tick is affordable.
  - A test asserts that `Object.keys(fighter)` equals `FIELDS`, so a new field can't be left out of the hash.
  - `deserialize(serialize(s))` must equal `s`. Phase 2 snapshots must carry this full blob, because the spec's partial schema (pos, vel, hp…) can't be rewound deterministically.
```ts
lo=(lo^byte)>>>0; const m=lo*0x1b3, nlo=m>>>0, c=Math.floor(m/4294967296);
hi=(Math.imul(hi,0x1b3)+c+(lo<<8))>>>0; lo=nlo;   // init hi=0xcbf29ce4, lo=0x84222325
```
- **Replay format:** `{v:1, rulesHash, matchId, seed, ticks, p1:{t,b}[], p2:{t,b}[], finalHash, cp?:[tick,hash][]}`.
  - Events are recorded only on change; `b` applies from step `t` until the next event.
  - Record the inputs the server actually *applied* (after the 2-tick delay and repeat-last), not the client's tick tags.
  - `runReplay(r, R)` expands the events, steps, and returns `{state, hash, cps}`. It fails loudly on a `rulesHash` mismatch.
- **Golden fixtures** (`test/fixtures/*.replay.json`):
  - (1) a scripted "every move" match written with a tiny DSL (`[["R",30],["S",1],…]`)
  - (2) CPU-vs-CPU full matches for seeds 1–5
  - Each has a checkpoint hash every 60 ticks. `pnpm --filter @cockfight/sim bless` regenerates them.
  - CI (ubuntu-x64) and the Mac (arm64) checking the same hashes satisfies the "two machines" criterion.
- **Property tests** (fast-check, random 5-bit input streams up to 30k ticks, 200 runs):
  - every field `Number.isInteger`, no NaN
  - hp, heat and |x| stay in bounds
  - running twice gives the same hash every tick
  - `prev` is untouched
  - rewind to tick k and replay gives the same hash (models reconciliation)
  - mirror: swap players and L↔R bits, and the state mirrors (catches P1-first ordering bias)
  - the match reaches matchEnd within 28.5k ticks

## 10. CPU (i)
The CPU lives in `packages/sim/src/cpu.ts`, but outside `step()`:
- Signature: `cpuThink(s, side, mem, cfg): number` (button mask). `mem` holds its own xorshift seeded from `matchId+":cpu"` and a ring buffer of opponent observations.
- **Why in sim:** it is pure and DOM-free, tests (soak, fixtures) need it, and Phase 2 could run bots server-side.
- `mem` is not part of MatchState. A CPU match replays from its input log alone.
- **Difficulty:** it reacts to the opponent as they were `delay` ticks ago. Easy {delay 22, block 30%, punish 30%}, normal {14, 60, 60}, hard {8, 85, 90}.
- **Behaviour:**
  - walk into range
  - block pecks and shoves it sees starting up
  - jump or peck against slam startup
  - punish recovery with slam or peck
  - shove near the wall
  - super on opponent recovery
  - occasional jump→dive, weighted by RNG

## 11. One-keyboard local 2P (j)
The input mapping belongs in apps/web and produces the same bitmask.
- **Single player:** arrows + Space (spec), plus WASD and F as aliases.
- **2P defaults:**
  - P1: **WASD + Space** (fingers on WASD, thumb on Space), alias F.
  - P2: **arrows + Right Shift**, aliases `/` `.` Enter Numpad0.
- **Never bind Ctrl, Meta or Alt.** P1's W combined with P2 holding ⌘ or Ctrl becomes Cmd/Ctrl+W, which closes the tab and can't be prevented. On Windows, AltGr sends Ctrl.
- Shift is safe (preventDefault Shift+Space). Modifiers also sit on dedicated matrix lines, so they don't ghost.
- Use `event.code` (physical keys). Ignore `repeat`. Call `preventDefault` on every bound key; this also stops arrow/space scrolling and Firefox's "/" quick-find.
- On `blur` / `visibilitychange`, release all keys. Blur focused buttons when a fight starts.
- **Ghosting:** add a pre-fight "hold your keys" test panel that lights up pressed keys, plus remapping stored in localStorage wrapped in try/catch.

## 12. Files and tests (k)
```
packages/sim/data/{moves.json,hitboxes.json}
src/ index.ts fixed.ts constants.ts types.ts input.ts rules.ts(compile+validate+rulesHash)
     state.ts(createMatch, resetRound, clone) fighter.ts(transitions/actions) physics.ts collide.ts
     combat.ts round.ts step.ts anim.ts(clipFor/clipSample, shared w/ renderer) rng.ts hash.ts replay.ts cpu.ts
test/ *.test.ts fixtures/
```
Tests proving "every move works with the listed frame data":
1. **fixed:** idiv symmetry, no `-0`.
2. **jump:** exactly 36 `!grounded` ticks; apex 2565 on ticks 18–19; y = 0 on step 37; forward/back jump distance.
3. **walk:** speeds, facing flip, SOCD.
4. **dash:**
   - 12-tick gap dashes, 13 doesn't, triple tap gives one dash
   - duration 12, back dash
   - a peck timed to each dash frame 1..12 hits on every frame except 3–6
5. **Table-driven, for each attack in moves.json:**
   - whiff returns to idle after exactly S+A+R ticks
   - hits on frames S+1 and S+A but not S or S+A+1 (using a range sweep)
   - exact hitstun, blockstun and hitstop (3 or 8 frozen ticks)
   - Heat +480 / +180
   - one hit per move
6. **block:** chip is exactly 10%; slam and dive go through block; super is blocked with 300 chip; block requires being grounded.
7. **slam:** grounded-only; launch → knockdown(40) → getup(20) with invuln; ring-out from x = 6.5.
8. **shove:** defender moves exactly 2000 with no wall; on block 1000 and clamped at the wall while the attacker is pushed back; ring-out from 8.5.
9. **dive:**
   - gated by minAirTick 4 and minY 900, once per jump
   - 6-tick hover
   - |vx| == |vy|
   - 14-tick landing recovery; bounce on hit
10. **super:**
    - needs a full, latched Heat
    - neutral Space at full Heat is super, not peck
    - Heat goes to 0 at the start
    - invulnerable startup beats a peck
    - hits across the whole arena; `maxY` gets jumped
    - 3000 damage, hitstop 8
11. **Heat:** decay −60 per 60 ticks; latch at max; reset each round; clamps.
12. **Round and match:**
    - 180 / 3600 / 120 tick exactness
    - 2–0 and 2–1 results
    - timeout; sudden death; SD expiry draws; double KO draws; maxRounds
    - ring-out counts as KO; hits disabled during roundEnd
13. **Edges and pushbox:** can't walk, dash or jump past 9500; pecks never ring out; can't walk through; cross-up flips facing on landing.
14. **Determinism:** the property suite, golden replays, and serialize round-trip.
15. **Rules:** schema validation, 21 clip names, `rulesHash` stability, fallback reporting.
16. **CPU:** deterministic per seed; reaction delay verified; CPU vs CPU always ends.
17. **Hash:** FNV lanes match the BigInt reference.

## 13. Pitfalls
- Use `|0` or trunc, never `Math.round` or float division, anywhere in state.
- Never let `-0` or `NaN` into state. Assert `Number.isSafeInteger` on every field in test mode after each step.
- Don't use `JSON.stringify` for hashing. Key order silently changes when a field is added.
- **Resolve both hit directions before applying either**; iterating P1 first biases trades.
- Keep the buffer and stun counters frozen during hitstop, but keep reading edges.
- The renderer must not derive gameplay from animation. Root motion is off and the sim is the source of truth.
- Keep sim imports free of `three`, `colyseus` and `zod`. Use zod in tests or the web and game apps, not in sim runtime code.
