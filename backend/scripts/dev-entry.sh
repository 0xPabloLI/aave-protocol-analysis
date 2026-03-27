#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/dev-clean.sh

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
