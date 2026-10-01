# Phase 4: launch prep

Goal: everything needed to switch the live stack from the throwaway test coin to the real
$COCK, short of the steps only Sammy can take (merging, keys, funding, creating the coin).
The step-by-step for launch day is `docs/runbook-launch.md`.

Agreed with Sammy (2026-10-01): legal done, no geo-block, Netlify stays the production host,
funding numbers decided on the day, load test on a temporary Fly copy.

| Item | Where | Status |
|---|---|---|
| The gate's second price source (pump.fun curve; the gate takes the lower) | `packages/solana/src/curve-price.ts`, `apps/game/src/gate.ts` | done |
| Link card + "Share on X" after a ranked win | `tools/og`, `apps/web/public/og.png`, `layout.tsx`, `lib/share.ts` | done |
| Load stats on `/health` | `apps/game/src/load.ts` | done |
| Load test: 200 concurrent matches | `tools/loadtest` (bots, runner, Fly server copy, Fly load generator) | done, results in the runbook |
| Launch tooling: preflight, fund, switch the mint, deploy the site | `tools/launch` | done |
| Runbook | `docs/runbook-launch.md` | done |
| Per-match share images | needs a server-side renderer | not planned |
| A second game-server machine (Redis, per-machine routing) | Phase 5, if one machine isn't enough | see the load test |
