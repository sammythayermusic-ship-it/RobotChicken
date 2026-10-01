#!/bin/zsh
# Builds the production site for one coin and deploys it to cockfightsol.fun
# (Netlify site "cockfightsol"). Public keys come from .env.local; the mint is
# the argument (it's public). Nothing secret is printed.
#
#   tools/launch/deploy-web.sh <mint>
set -e
cd "${0:A:h}/../.."
mint="$1"
if [[ ! "$mint" =~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' ]]; then echo "usage: $0 <coin mint address>"; exit 1; fi
envval() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

export NEXT_PUBLIC_GAME_WS_URL=wss://cockfight-game.fly.dev
export NEXT_PUBLIC_COCK_MINT="$mint"
export NEXT_PUBLIC_TURNSTILE_SITE_KEY="$(envval TURNSTILE_SITE_KEY)"
export NEXT_PUBLIC_SUPABASE_URL="$(envval SUPABASE_URL)"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(envval SUPABASE_ANON_KEY)"
export EXPORT_INDEXABLE=1
for v in NEXT_PUBLIC_TURNSTILE_SITE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do
  [[ -n "${(P)v}" ]] || { echo "missing $v (from .env.local)"; exit 1; }
done

echo "Building the site for $mint ..."
pnpm --filter @cockfight/web export
grep -rqs "$mint" apps/web/out/_next/static || { echo "the build doesn't contain the mint; stopping"; exit 1; }

# Deploy from a copy outside the repo (the Netlify CLI asks which monorepo project otherwise).
tmp=$(mktemp -d)
cp -R apps/web/out "$tmp/site"
echo "Deploying to cockfightsol ..."
npx -y netlify-cli deploy --dir "$tmp/site" --prod --no-build --site cockfightsol
rm -rf "$tmp"
echo "Done: https://cockfightsol.fun"
