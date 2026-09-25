# syntax=docker/dockerfile:1
#
# Colyseus game server image. The build context is the REPO ROOT (see /.dockerignore):
#   docker build -f apps/game/Dockerfile -t cockfight-game .
#   fly deploy . --config apps/game/fly.toml --dockerfile apps/game/Dockerfile --ha=false
#
# The build stage bundles everything into dist/server.mjs with esbuild, so the
# runtime stage is Node plus that one file: no node_modules, no pnpm.

FROM node:22-slim AS build
# pnpm 11 must never stop for an interactive prompt (build-script approval, etc.).
ENV CI=true
# Same version as package.json "packageManager"; npm avoids corepack's download and signature step.
RUN npm install --global pnpm@11.27.1
WORKDIR /repo

# Manifests first: this install layer stays cached until the lockfile or a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/game/package.json apps/game/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
COPY packages/solana/package.json packages/solana/
COPY tools/package.json tools/
# The game and the workspace packages it imports. (pnpm also installs the root
# devDependencies here; they stay in this stage.)
RUN pnpm install --frozen-lockfile --filter "@cockfight/game..."

COPY . .
# Run the build script directly: `pnpm run` would first re-install the rest of
# the workspace (pnpm 11's verifyDepsBeforeRun sees the filtered install as stale).
RUN node apps/game/build.mjs

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=2567
WORKDIR /app
# Root-owned and read-only to the app user: the server never writes to disk.
COPY --from=build /repo/apps/game/dist ./dist
USER node
EXPOSE 2567
# Colyseus handles SIGTERM itself: it stops matchmaking, disposes rooms, then exits.
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
