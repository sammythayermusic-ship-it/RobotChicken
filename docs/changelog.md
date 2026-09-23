# Changelog

## Phase 0: scaffold (in progress)

- pnpm 11 monorepo: `apps/{web,game,worker}`, `packages/{sim,shared,solana}`, `tools`, `supabase`, `art/blender`.
- `packages/sim`: integer fixed-point state, FNV-1a-64 state hash, compiled rules with `rulesHash`, walking, pushbox, walls, the full round machine, replays and golden fixtures.
- CI: lint, typecheck, tests, asset validation, builds, golden replay hashes compared across Linux x64 and macOS arm64, Docker images.
