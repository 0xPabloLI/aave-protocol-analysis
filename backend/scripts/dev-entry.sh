#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/dev-clean.sh

# Preflight: ensure backend deps installed (tsx present)
if [ ! -x "./node_modules/.bin/tsx" ]; then
  echo "[dev-entry] tsx missing in backend/node_modules — running npm install..." >&2
  npm install --include=dev --no-audit --no-fund
# Preflight: package.json/lock newer than node_modules — deps may be stale
elif [ "package.json" -nt "node_modules" ] || { [ -f "package-lock.json" ] && [ "package-lock.json" -nt "node_modules" ]; }; then
  echo "[dev-entry] package.json/lock newer than node_modules — running npm install..." >&2
  npm install --include=dev --no-audit --no-fund
fi

# Preflight: ensure workspace packages are built (backend imports from @internal/* packages)
if [ ! -d "../packages/aave-shared-contracts/dist" ] || [ ! -d "../packages/aave-fetcher/dist" ]; then
  echo "[dev-entry] workspace packages not built — running root install & build..." >&2
  (cd .. && npm install && npm run build)
fi

case "${1:-}" in
  --watch)
    exec ./node_modules/.bin/tsx watch src/server.ts
    ;;
  "")
    exec ./node_modules/.bin/tsx src/server.ts
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: bash scripts/dev-entry.sh [--watch]" >&2
    exit 1
    ;;
esac
