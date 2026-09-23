# Toolchain, versions and CI for the COCKFIGHT monorepo

Versions were checked with `npm view` on 2026-09-23. Four findings change the plan:

- **Colyseus:** the current version is 0.18, not 0.16, and the browser client package was renamed.
- **TypeScript 7 can't be used yet:** it ships without the JavaScript API that ESLint and Next's type check depend on.
- **Vercel has no native pnpm 11 support:** it needs a workaround setting.
- **pnpm 11 holds back very new releases:** it refuses package versions less than one day old by default.

## (a) Versions and what to pin

| Package | Latest stable | Pin | Why |
|---|---|---|---|
| next / eslint-config-next | 16.3.6 | `16.3.6` for both | Same major as soltendogs. The spec's "Next 15" only exists as a backport line (15.5.26). |
| react / react-dom | 19.3.0 | `19.2.8` | Only @react-three/fiber (R3F) 9.8.0 supports React 19.3, and it came out on 2026-09-22 (9.7.0 caps at <19.3). 19.2.8 is soltendogs' known-good version. Upgrade later in its own PR. |
| three / @types/three | 0.186.0 / 0.186.0 | `^0.186.0` | postprocessing 6.39.5 accepts three `<0.187`. |
| @react-three/fiber (optional) | 9.8.0 | `^9.7.0` | |
| **colyseus (server)** | core 0.18.16, schema 5.0.34 | **0.18** | See below. |
| Colyseus browser client | **`@colyseus/sdk` 0.18.4** | `^0.18.3` | `colyseus.js` stopped at 0.16.22 (last release 2025-10). |
| @colyseus/tools / ws-transport / testing / redis-driver / redis-presence | 0.18.4 / 0.18.3 / 0.18.6 / 0.18.3 / 0.18.5 | `^` those | Don't install the umbrella `colyseus` package: it pulls in monitor, playground, auth and a vite peer. |
| zod | 4.6.5 | `^4.6.5` | @colyseus/core 0.18 lists zod ^4.1.12 as a peer. |
| **typescript** | **7.0.2** | **`~6.0.3`** | TypeScript 7 is the Go compiler with no JavaScript API. typescript-eslint 8.70.1 only accepts `typescript >=4.8.4 <6.1.0`, and Colyseus' `schema-codegen` needs 5 or 6. Soltendogs is on 5.9.3. |
| vitest (+ @vitest/coverage-v8) | 5.0.1 | **`^4.1.11`** | Vitest 5 is three weeks old, needs `vite` installed alongside it, and changes the `clearMocks` and project-inheritance defaults. Phase 0–1 gains nothing from it. Upgrade later in its own PR. |
| **eslint** | **10.11.0** | **`^9.39.5`** | Three plugins bundled with eslint-config-next (react, import, jsx-a11y) only support ESLint up to 9. |
| typescript-eslint | 8.70.1 | `^8.70.1` | |
| tsx | 4.23.15 | `^4.23.15` | Runs the game server in dev and the scripts. |
| tsup / tsdown | 8.5.1 (not updated since 2025-11) / 0.23.0 (pre-1.0) | neither | Use `esbuild ^0.28.2` directly for the server bundle. It is already installed through tsx. |
| turbo | 2.11.3 | not used | See (c). |
| tailwindcss + @tailwindcss/postcss | 4.3.3 | `^4.3.3` | |
| zustand | 5.0.15 | `^5.0.15` | |
| @gltf-transform/core, functions, extensions | 4.5.0 | `^4.5.0` | Same as soltendogs. |
| draco3dgltf | 1.5.7 | `^1.5.7` | |
| postprocessing | 6.39.5 | `^6.39.5` | Use it directly, not through the R3F wrapper. Soltendogs found that `@react-three/postprocessing` 3.1 never received frames with R3F 9.7. |
| @types/node | 26.6.2 | `^22.20.4` | Match the Node 22 runtime. |
| pnpm | 12.6.0 (11.27.1 is the latest 11.x) | **`packageManager: "pnpm@11.27.1"`** | Your local 11.0.9 downloads and runs the pinned version automatically. pnpm 12 is too new for Vercel and for pnpm/action-setup, which added v12 support on 09-05. |

**Why Colyseus 0.18 rather than the spec's 0.16.** Version 0.16 is two majors old and now tagged "legacy". Version 0.18 has been stable since May (the SDK's 0.18.0 came out 2026-05-22). It also has built-ins that match the spec's netcode, which is one reason to write less of it ourselves in Phase 2:
- **Fixed-rate simulation loop:** `Room#setFixedTimestep(step, 60)`.
- **Per-client input buffer:** `this.defineInput(...)`, whose docs describe it as an input buffer with a reconcile ack.
- **Lag compensation:** `allowRewindState`.
- **Matchmaking:** `QueueRoom`.
- **Typed server definition:** `defineServer` / `defineRoom`, with those types flowing through to `@colyseus/sdk`.

Breaking changes from earlier versions:
- `client.id` is removed; use `sessionId`.
- `setSimulationInterval` is renamed `setTimestep`.
- `setMetadata` now replaces the metadata instead of merging it.
- A Schema holds at most 63 fields.
- The playground returns 404 when `NODE_ENV=production`.
- Colyseus requires Node 22 or newer.

Colyseus releases patches almost daily, so use caret ranges and let the lockfile hold the exact version.

**The schema library no longer needs decorators.** `@colyseus/schema` 5 has a builder API that needs no compiler flags:

```ts
import { schema, t, type SchemaType } from "@colyseus/schema";
export const Fighter = schema({ x: t.int32(), hp: t.uint8(), state: t.uint8() }, "Fighter");
export type Fighter = SchemaType<typeof Fighter>;
```

Use the builder. The old `@type()` decorators still work but need `experimentalDecorators: true` and `useDefineForClassFields: false`, which conflict with the defaults in esbuild, SWC and Vite.

## (b) pnpm 11 settings

- **Build scripts are blocked by default.** pnpm 11 removed `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies` and `ignoreDepScripts`, and replaced them with an `allowBuilds` map (package name → true/false). `strictDepBuilds: true` is now the default, so `pnpm install` fails if any dependency has a build script nobody has approved. In this dependency tree the packages with install scripts are esbuild, unrs-resolver (from eslint-config-next) and msgpackr-extract (from Colyseus). sharp 0.35 and @tailwindcss/oxide have none. Never use `dangerouslyAllowAllBuilds`.
- **`.npmrc` no longer holds pnpm settings.** It is read for registry and login details only; everything else goes in `pnpm-workspace.yaml`. Environment variables must use `pnpm_config_*`; `npm_config_*` is ignored.
- **New versions are held back for a day.** The default `minimumReleaseAge` is 1440 minutes. Anything published in the last 24 hours resolves to the previous version: today that is @colyseus/core 0.18.16, schema 5.0.34, sdk 0.18.4 and R3F 9.8.0. **Don't set `minimumReleaseAge` explicitly.** Doing so switches on `minimumReleaseAgeStrict`, and the install fails whenever no version in range is old enough.
- **`verifyDepsBeforeRun: install` is the default.** `pnpm test` and `pnpm dev` reinstall automatically if dependencies are out of date. This breaks when offline; set it to `warn` if that annoys you.
- **Docker needs `CI=true`** so pnpm's interactive build prompt can't hang the build. It also needs `COPY pnpm-workspace.yaml`.
- **`pnpm deploy` on pnpm 11 needs `--legacy`.** The newer mode requires `injectWorkspacePackages: true`, which copies workspace packages instead of linking them and breaks live editing of `packages/sim`. pnpm 12.2 removed that requirement.
- **Catalogs:** reference versions with `catalog:` in package.json files and `workspace:*` for internal packages.

```yaml
# pnpm-workspace.yaml
packages: [apps/*, packages/*, tools]
allowBuilds:
  esbuild: true
  unrs-resolver: true
  msgpackr-extract: true
catalog:
  next: 16.3.6
  eslint-config-next: 16.3.6
  react: 19.2.8
  react-dom: 19.2.8
  "@types/react": ^19.2.0
  "@types/react-dom": ^19.2.0
  three: ^0.186.0
  "@types/three": ^0.186.0
  "@react-three/fiber": ^9.7.0
  postprocessing: ^6.39.5
  zustand: ^5.0.15
  tailwindcss: ^4.3.3
  "@tailwindcss/postcss": ^4.3.3
  zod: ^4.6.5
  "@colyseus/core": ^0.18.15
  "@colyseus/schema": ^5.0.33
  "@colyseus/ws-transport": ^0.18.3
  "@colyseus/tools": ^0.18.4
  "@colyseus/sdk": ^0.18.3
  "@colyseus/testing": ^0.18.6
  typescript: ~6.0.3
  "@types/node": ^22.20.4
  tsx: ^4.23.15
  esbuild: ^0.28.2
  vitest: ^4.1.11
  "@vitest/coverage-v8": ^4.1.11
  eslint: ^9.39.5
  typescript-eslint: ^8.70.1
  "@gltf-transform/core": ^4.5.0
  "@gltf-transform/functions": ^4.5.0
  "@gltf-transform/extensions": ^4.5.0
  draco3dgltf: ^1.5.7
```

**Vercel:** Vercel doesn't support pnpm 11 natively (its GitHub issue #17434 is still open). With no lockfile hint it falls back to pnpm 9 and fails with "packages field missing". The fix is to keep the `packageManager` field and set `ENABLE_EXPERIMENTAL_COREPACK=1` in the Vercel project's environment variables. Don't use `devEngines.packageManager`: Vercel rejects it with "Invalid devEngines.packageManager".

## (c) Plain pnpm scripts, no turbo

Plain pnpm scripts are enough:
- **Tests:** one root `vitest run` covers every package.
- **Build:** internal packages are TypeScript source with no build step.
- **Dev:** it only needs two long-running processes.

Turbo would add a binary, caching we don't need yet, and one more piece of config. Revisit it if CI goes over about 5 minutes.

```json
{
  "name": "cockfight", "private": true, "type": "module",
  "packageManager": "pnpm@11.27.1",
  "engines": { "node": "22.x" },
  "scripts": {
    "dev": "pnpm --parallel --filter @cockfight/web --filter @cockfight/game run dev",
    "build": "pnpm -r --filter \"./apps/*\" run build",
    "lint": "eslint --max-warnings=0 .",
    "typecheck": "pnpm -r --parallel run typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "replay:golden": "pnpm --filter @cockfight/tools run replay:golden",
    "assets:validate": "pnpm --filter @cockfight/tools run assets:validate",
    "assets:placeholder": "pnpm --filter @cockfight/tools run assets:placeholder",
    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm assets:validate && pnpm build"
  },
  "devDependencies": { "eslint": "catalog:", "eslint-config-next": "catalog:", "typescript-eslint": "catalog:",
    "typescript": "catalog:", "vitest": "catalog:", "@vitest/coverage-v8": "catalog:", "@types/node": "catalog:" }
}
```

- `engines: "22.x"` is the format Vercel uses to pick Node 22. Add a `.nvmrc` containing `22`.
- Every package that runs `tsc`, `vitest` or `tsx` should also list that tool as a dev dependency (`catalog:`).
- Dev ports: web on 3000, game on 2567.

## (d) TypeScript setup

TypeScript 6 changed several defaults: `types: []`, `strict`, `module: esnext`, `moduleResolution: bundler`, and a moving `target`. Set them all explicitly so the base config doesn't depend on defaults. Because `types` defaults to empty, Node's type definitions are no longer included automatically. That helps here: the sim's tsconfig has no Node or DOM types, so the compiler enforces "no DOM or Node" for it.

```jsonc
// tsconfig.base.json
{ "compilerOptions": {
  "target": "ES2023", "lib": ["ES2023"], "module": "ESNext", "moduleResolution": "Bundler",
  "moduleDetection": "force", "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
  "verbatimModuleSyntax": true, "isolatedModules": true, "erasableSyntaxOnly": true,
  "resolveJsonModule": true, "skipLibCheck": true, "noEmit": true, "types": [] } }
```

- `erasableSyntaxOnly` bans enums and constructor parameter properties. Use `as const` objects in the sim.
- **Per-package configs:**
  - `packages/sim`: extends the base, nothing added (ES2023 only).
  - `packages/shared`: same.
  - `apps/game` and `tools`: `"types": ["node"]`.
  - `apps/web`: `"lib": ["ES2023","DOM","DOM.Iterable"], "types": ["node"], "jsx": "react-jsx", "plugins":[{"name":"next"}], "paths":{"@/*":["./src/*"]}`, and include `.next/types/**/*.ts` plus `.next/dev/types/**/*.ts` (as soltendogs does).
- **Internal packages are consumed as TypeScript source:**
  ```json
  { "name": "@cockfight/sim", "private": true, "type": "module", "sideEffects": false,
    "exports": { ".": "./src/index.ts", "./moves.json": "./src/moves.json" },
    "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" } }
  ```
  Import the move data as `import moves from "./moves.json" with { type: "json" }`. That form works in TypeScript, Vite, Turbopack, esbuild, tsx and plain Node.
- **Next.js:** Next 16's Turbopack compiles workspace packages automatically, and it finds the monorepo root from `pnpm-lock.yaml`, so `turbopack.root` isn't needed. Still list `transpilePackages: ["@cockfight/sim","@cockfight/shared"]` in `next.config.ts`; it is harmless and covers a webpack fallback.
- **Game server, dev:** `"dev": "tsx watch --clear-screen=false src/index.ts"`. pnpm links workspace packages to their real paths outside `node_modules`, so tsx watches the sim's source too. `@colyseus/tools` loads `.env.development` and `.env` itself.
- **Game server, production:** bundle our code with esbuild and leave npm dependencies external:
  ```js
  // apps/game/build.mjs
  import { build } from "esbuild"; import pkg from "./package.json" with { type: "json" };
  await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "node", target: "node22", format: "esm",
    outfile: "dist/index.mjs", sourcemap: true,
    external: Object.keys(pkg.dependencies).filter(d => !d.startsWith("@cockfight/")),
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" } });
  ```
  The Dockerfile uses a `node:22-slim` base:
  1. Set `CI=true` and run `npm i -g pnpm@11.27.1`.
  2. Copy the lockfile, `pnpm-workspace.yaml` and the package.json files.
  3. Run `pnpm install --frozen-lockfile --filter @cockfight/game...`.
  4. `COPY .`, then run the build and `pnpm --filter @cockfight/game deploy --legacy --prod /out`.
  5. Final stage: `COPY /out` and `CMD ["node","dist/index.mjs"]`.

  Deploy from the repo root: `fly deploy . -c apps/game/fly.toml --dockerfile apps/game/Dockerfile`.
- **Phase 0 server that boots:**
  ```ts
  import { defineServer, defineRoom } from "@colyseus/core"; import { listen } from "@colyseus/tools";
  export const server = defineServer({ rooms: { fight: defineRoom(FightRoom) } });
  await listen(server, Number(process.env.PORT ?? 2567));
  ```
  Colyseus has its own HTTP routes (`createRouter` / `createEndpoint`), so Express isn't needed.

## (e) Vitest with multiple projects

Root `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  projects: ["packages/*", "apps/*", "tools"],
  coverage: { provider: "v8", reporter: ["text", "html"], include: ["packages/sim/src/**"] } } });
```

Each package has its own config file:

```ts
// packages/sim/vitest.config.ts
import { defineProject } from "vitest/config";
export default defineProject({ test: { name: "sim", environment: "node", include: ["src/**/*.test.ts", "test/**/*.test.ts"] } });
```

- **Web:** add `resolve.alias` for `@` → `./src`. The environment defaults to node; put `// @vitest-environment jsdom` on the few files that need a DOM.
- **Running tests:** `pnpm test` at the root runs every project. `vitest --project sim` runs one, and `pnpm --filter @cockfight/sim test` also works.
- **Sim tests stay free of Node APIs.** Golden input logs are imported as JSON rather than read from disk.
- **Golden hash test:** `sim/test/golden.test.ts` replays each `test/golden/*.inputs.json` and checks the result against the committed `test/golden/expected-hashes.json`. Any intentional sim change must regenerate the hashes with `pnpm replay:golden --update` in the same PR.

## (f) GitHub Actions: `.github/workflows/ci.yml`

```yaml
name: ci
on: { pull_request: {}, push: { branches: [main] } }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }
env: { CI: "true" }
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6            # reads packageManager
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm assets:validate
      - run: pnpm --filter @cockfight/web build
  replay:
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, macos-latest] } }   # x64 vs arm64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile --filter "@cockfight/tools..."
      - run: pnpm -s replay:golden > replay-hashes.txt
      - run: diff -u packages/sim/test/golden/expected-hashes.txt replay-hashes.txt
      - uses: actions/upload-artifact@v7
        with: { name: replay-hashes-${{ matrix.os }}, path: replay-hashes.txt, if-no-files-found: error, retention-days: 14 }
  replay-compare:
    needs: replay
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8     # v8 fails on digest mismatch by default
        with: { pattern: replay-hashes-*, path: hashes }
      - run: |
          set -euo pipefail
          files=(hashes/*/replay-hashes.txt); [ ${#files[@]} -eq 2 ] && [ -s "${files[0]}" ]
          { echo '### Golden replay'; echo '```'; cat "${files[0]}"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
          diff -u "${files[0]}" "${files[1]}"
```

- **Output format:** `tools/replay-golden.ts` prints one line per log (`<log> <ticks> <hash>`) to stdout; that is why the job runs pnpm with `-s`. Running `pnpm replay:golden` on your M-series Mac gives a third machine to check against.
- **Hashing:** hash the state with a pure 32-bit integer hash (FNV-1a via `Math.imul`) over a fixed field order. Tests assert that every state field is an integer each tick.
- **What CI does and doesn't prove:** this only shows V8 on x64 and V8 on arm64 agree. It says nothing about Safari or Firefox, which will run client prediction in Phase 2. Browser engines are allowed to compute `Math.sin/cos/tan/atan2/pow/exp/log/hypot` slightly differently, so ban those in the sim with a lint rule and use integer lookup tables instead.

## (g) What to copy from soltendogs

- **`next.config.ts`:** copy `devIndicators: false`, the `Content-Security-Policy-Report-Only` header whose `connect-src` is built from config, and the other security headers. Changes:
  - add `NEXT_PUBLIC_GAME_WS_URL` (ws/wss) to `connect-src`;
  - add `'wasm-unsafe-eval'` to `script-src` (Draco and KTX2 decoders run WebAssembly);
  - keep `worker-src blob:`;
  - drop the DexScreener frame and the microphone permission.

  Self-host the decoders: copy `three/examples/jsm/libs/{draco/gltf,basis}` into `public/{draco,basis}` in the `dev` and `build` scripts (`node scripts/copy-decoders.mjs && next dev`) and gitignore them.
- **`eslint.config.mjs`:** keep the same structure (`defineConfig` + `nextVitals` + `nextTs` + `globalIgnores`, plus the `react-hooks/immutability: off` override for the imperative three.js folder). Changes:
  - **Scope:** restrict the Next configs to `apps/web/**`, set `settings.next.rootDir: "apps/web/"`, and use `tseslint.configs.recommended` for the other packages. Keeping the file sets separate avoids a "Cannot redefine plugin" error.
  - **Sim rules:** add rules for `packages/sim/**`:
    - `no-restricted-properties`: Math.random, Date.now, performance.now and the transcendental Math functions;
    - `no-restricted-globals`: window, document, process, setTimeout, requestAnimationFrame.

  Next 16 no longer has `next lint`, so lint always goes through the ESLint CLI.
- **`vitest.config.ts`:** node environment, tests next to the code, v8 coverage limited to the sim, and the `@` alias (now in the web project's config).
- **`tsconfig.json`:** keep the Next plugin, the paths, `.next/dev/types`, `jsx: react-jsx` and `isolatedModules`. Drop `target: ES2017`, `allowJs` and `incremental`. Also gitignore `tsconfig.tsbuildinfo`; soltendogs has one sitting in its repo root.
- **`package.json`:** reuse the `verify`, `typecheck` and `test:watch` scripts and the @gltf-transform 4.5 packages. Don't copy `@types/node ^20` or `typescript ^5`.
- **`vercel.json` and `postcss.config.mjs`:**
  - Copy `postcss.config.mjs` as is.
  - Keep `regions: ["iad1"]` in `vercel.json`, but don't set `immutable` caching on unhashed `/models/*.glb`. An updated `chicken_placeholder.glb` would stay stale in browsers for a year. Have `assets:validate` write a manifest with content hashes and load models as `?v=<hash>`, or use hashed file names.
  - Set the Vercel project's Root Directory to `apps/web`. Its ignore command can be `git diff --quiet HEAD^ HEAD -- . ../../packages ../../pnpm-lock.yaml`.
- **`AGENTS.md`:** `next dev` writes an AGENTS.md block into `apps/web`. Commit it.
- **Pitfalls from soltendogs' CLAUDE.md to carry over:**
  - never dispose `useMemo`-built three.js objects in an effect cleanup (StrictMode runs effects twice in dev);
  - pass the camera position as a memoised tuple, never a fresh array;
  - don't use drei `<Instances>` on this stack;
  - no `Date.now()` or `Math.random()` during render (the React compiler lint rules);
  - keep `docs/decisions.md` and `docs/changelog.md` up to date.

## Other notes

- **Placeholder model:** commit the Blender-generated `chicken_placeholder.glb`. CI has no Blender, so it only validates the file. Don't use Git LFS: Vercel needs it switched on separately.
- **Textures:** `toktx` isn't installed, and gltf-transform's KTX2 commands also need it. Phase 1 should use flat materials, and `tools/textures.sh` should fail with a clear message until you run `brew install ktx-software` (your call).
- **Supabase:** Phase 0 migrations are plain SQL files. Nothing runs them in CI until the Supabase CLI or Docker is added.

Sources: [pnpm 11 release](https://pnpm.io/blog/releases/11.0), [pnpm build settings](https://pnpm.io/settings/build), [pnpm dependency resolution settings](https://pnpm.io/settings/dependency-resolution), [pnpm deploy](https://pnpm.io/cli/deploy), [pnpm 12 release](https://pnpm.io/blog/releases/12.0), [pnpm 10→11 in Docker and CI](https://dev.classmethod.jp/en/articles/pnpm-v10-to-v11-migration-docker-ci/), [Vercel pnpm 11 issue](https://github.com/vercel/vercel/issues/17434), [pnpm 11 on Vercel](https://andrewusher.dev/blog/upgrading-pnpm-11-vercel), [Colyseus 0.18 migration](https://docs.colyseus.io/migrating/0.18), [Next.js turbopack config](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack), [Next.js transpilePackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages), [Vitest migration](https://vitest.dev/guide/migration), [Vitest projects](https://vitest.dev/guide/projects), [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [TypeScript 6 defaults](https://blog.openreplay.com/whats-new-typescript-6-0/), [pnpm/action-setup](https://github.com/pnpm/action-setup).
