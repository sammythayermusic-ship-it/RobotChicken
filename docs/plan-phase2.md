# COCKFIGHT: build plan for Phase 2 (online)

## Scope (from the spec)

Colyseus lobby + FightRoom, matchmaking, client prediction and reconciliation,
reconnect / forfeit, the wallet-paste gate with Turnstile and tier, ELO, the
replay page and the leaderboard. Mobile controls already shipped in Phase 1.

**Acceptance (spec):** two players in different cities finish a match with no
visible warping at 80 ms RTT; the gate blocks a wallet at $29 and admits one at
$31; a forced disconnect forfeits after 10 s; the replay page reproduces the
match exactly.

## Agreed with Sammy (2026-09-24)

- **Open playtest mode:** `GATE_MODE=open` lets anyone queue with just a name,
  so friends can play online before $COCK exists. Open-mode matches never
  touch the database (no ELO, no leaderboard rows). Production defaults to
  `GATE_MODE=required`.
- **One region (US-East) to start.** Multi-region stays a config change: the
  client RTT-probes every URL in `NEXT_PUBLIC_GAME_WS_URL` (comma-separated)
  and queues on the fastest.
- **Usernames (message signing) move to Phase 3**, with profiles. Phase 2 shows
  `anon-XXXX`.
- Accounts to deploy: Fly.io, Supabase, Helius + Turnstile. Nothing is needed
  to build or test: everything runs locally with zero env vars.

## Architecture

```
browser ──HTTP POST /gate──────────▶ game server (Fly)
   │     (Turnstile + balance → queue JWT)   │ Helius, Jupiter (gate only)
   ├──ws "queue" room (JWT, RTT) ───────────▶│ pairs tickets, re-checks balances
   └──ws "fight" room (seat reservation) ───▶│ authoritative sim @ 60 Hz
                                             └─▶ Supabase rpc record_match (ELO, input log)
browser ──read public views────────▶ Supabase (leaderboard_v, match_replay_v)
```

- **The gate lives on the game server**, not in a Vercel API route. The spec
  wanted the game server to never call Helius, but it also needs a balance
  re-check at match start; keeping both on one server means one place for the
  Helius key, no JWT round trip for the re-check, and the web app stays a
  static site (the Netlify playtest keeps working). The queue JWT is kept
  (Turnstile tokens are single use; the tier badge shows before queueing).
- **No Redis in Phase 2.** One machine per region keeps rooms, the queue and
  the 60 s balance cache in memory. Redis (or `fly-replay`) comes with scaling
  past one machine (Phase 4 load test).

## Netcode

Rollback-style prediction on an authoritative server, built on the
deterministic sim:

- **Client → server:** every local tick, `[tick, buttons]` for tick
  `C + INPUT_DELAY` (2 ticks). Binary messages, a few bytes each.
- **Server:** a per-player input ring. Stepping tick S uses that player's input
  for S, or repeats their last one (counted as missed). Late inputs are dropped
  and counted; inputs more than `MAX_LEAD` ticks ahead are rejected. Net
  quality = 1 − missed / ticks.
- **Server → client:** every tick, the inputs it actually used for both players
  plus that client's input lead; a full serialized state (73 ints) with its
  hash twice a second as a desync check, and on join / reconnect.
- **Client:** keeps the confirmed state (stepped from confirmed inputs, so it
  equals the server's) and predicts ahead to its own tick with its own inputs
  and the opponent's last confirmed buttons. New confirmations → re-simulate
  from the confirmed state (about 10 ticks, a few microseconds each).
- **Clock:** the client speeds up or slows down by a tick to keep its input
  lead at ~2 ticks (no clock maths, robust to drift and jitter).
- **Smoothing:** a correction under 0.5 u blends over 3 frames, larger ones
  snap (spec). Presentation only; the sim state is never touched.
- **Why not the spec's "interpolate the opponent 100 ms behind":** in a fighter
  you would see attacks late and get hit by moves you never saw start. Both
  fighters are predicted and corrected instead; the 2-tick input delay keeps
  rollbacks small. (★ in decisions.)

The server core (`ServerMatch`) and client core (`ClientPredictor`) are plain
classes in a new `packages/net`, so a headless harness can run two clients
against a server through a simulated network (80 ms RTT, jitter, loss bursts)
in vitest and measure corrections.

## Match lifecycle

`waiting` (both seats, 15 s or cancel) → `live` (sim countdown → fighting →
roundEnd …) → `over`. A drop pauses the sim; reconnecting within 10 s resumes
from a full state; otherwise the connected player wins by forfeit. Leaving on
purpose forfeits at once. Both gone → abandoned, no result.

## Queue

- One ticket per address (a second join replaces the first).
- Pairs oldest first when both RTTs ≤ 120 ms; after 20 s in queue ≤ 200 ms;
  after 60 s anyone (★: the spec leaves long waits open).
- Gate mode: re-check both balances (cache bypass) before creating the room; a
  failed re-check tells that player why and re-queues the other.
- Phase 3 anti-abuse (≥ 4 in queue, IP / fingerprint, rematch cooldown) plugs
  into one `canPair(a, b)` hook.

## Data

New migration: `balance_checks.source` gains `fixed` (devnet test price);
`record_gate(...)` writes the audit row and upserts the player's tier;
`record_match(...)` writes the match and both ELO updates (K = 32, draw = ½) in
one transaction. Without Supabase the game server keeps results in memory and
serves `/api/matches/:id` and `/api/leaderboard` so replays and the
leaderboard work locally.

## Web

- `/play`: new ONLINE mode → wallet (gate) or name (open) → Turnstile → queue
  screen (RTT, tier badge, wait) → fight → KO screen (result, requeue, replay
  link). The engine takes a match driver (local or online).
- `/m/[id]`: replay page, deterministic playback from the input log, checks the
  result hash. (OG image / share card stays in Phase 3.)
- `/leaderboard`: today / 7 days / all time, ELO, wins, win rate.

## Order of work (one branch `phase-2-online`, commits per step)

1. `packages/net`: protocol codecs, ServerMatch, ClientPredictor, network
   harness tests (80 ms RTT convergence, desync = 0, drop accounting).
2. FightRoom on ServerMatch: lifecycle, reconnect / forfeit, results.
3. Gate (`packages/solana`), `/gate`, QueueRoom, open mode.
4. Results store + migration + ELO.
5. Web: online mode, queue UI, replay page, leaderboard, CSP.
6. e2e: two browsers matched and fighting, forced disconnect forfeits after
   10 s, replay reproduces the hash.
7. Docs (decisions, changelog, HANDOFF, README deploy notes), review, PR.
