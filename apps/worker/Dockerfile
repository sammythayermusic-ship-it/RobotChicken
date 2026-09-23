# syntax=docker/dockerfile:1
#
# Worker image. The build context is the REPO ROOT (see /.dockerignore):
#   docker build -f apps/worker/Dockerfile -t cockfight-worker .
#   fly deploy . --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --ha=false
#
# Same shape as apps/game/Dockerfile: esbuild bundles dist/worker.mjs in the
# build stage and the runtime stage is Node plus that one file.

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
RUN pnpm install --frozen-lockfile --filter "@cockfight/worker..."

COPY . .
# Direct, not `pnpm run`: pnpm 11's verifyDepsBeforeRun would re-install the rest of the workspace.
RUN node apps/worker/build.mjs

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
# Root-owned and read-only to the app user. Phase 3 keys arrive as Fly secrets (env), never files.
COPY --from=build /repo/apps/worker/dist ./dist
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/worker.mjs"]
