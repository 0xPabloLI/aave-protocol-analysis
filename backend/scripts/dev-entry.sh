#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/dev-clean.sh

# Preflight: ensure workspace deps installed (check via npx, which resolves hoisted packages)
if ! npx --no-install tsx --version >/dev/null 2>&1; then
  echo "[dev-entry] workspace deps missing — running npm install from root..." >&2
  (cd .. && npm install)
# Preflight: root package.json/lock newer than node_modules — deps may be stale
elif [ "../package.json" -nt "../node_modules" ] || [ "../package-lock.json" -nt "../node_modules" ]; then
  echo "[dev-entry] root package.json/lock newer than node_modules — running npm install from root..." >&2
  (cd .. && npm install)
fi

# Preflight: ensure workspace packages are built (backend imports from @internal/* packages)
if [ ! -d "../packages/aave-shared-contracts/dist" ] || [ ! -d "../packages/aave-fetcher/dist" ]; then
  echo "[dev-entry] workspace packages not built — running root install & build..." >&2
  (cd .. && npm install && npm run build)
fi

case "${1:-}" in
  --watch)
    exec npx --no-install tsx watch src/server.ts
    ;;
  "")
    exec npx --no-install tsx src/server.ts
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: bash scripts/dev-entry.sh [--watch]" >&2
    exit 1
    ;;
esac
