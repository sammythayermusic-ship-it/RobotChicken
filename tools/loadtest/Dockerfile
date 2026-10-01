# syntax=docker/dockerfile:1
#
# Load generator: the bots run from a Fly machine next to the server (a home
# connection can't carry 400 sockets of 60 Hz traffic). Build context = repo root:
#   fly machine run . --dockerfile tools/loadtest/Dockerfile -a cockfight-loadgen \
#     --vm-size performance-4x --region iad --restart no \
#     --env LT_URL=https://cockfight-loadtest.fly.dev --env LT_MATCHES=200 --env LT_SECONDS=600
# The summary prints to the machine's log (fly logs -a cockfight-loadgen).
FROM node:22-slim
ENV CI=true
RUN npm install --global pnpm@11.27.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@cockfight/tools..."
WORKDIR /repo/tools
CMD ["node", "--import", "tsx", "loadtest/run.ts"]
