#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
backend_root="$repo_root/backend"

patterns=(
  "$backend_root/node_modules/.bin/tsx src/server.ts"
  "$backend_root/node_modules/.bin/tsx watch src/server.ts"
  "$backend_root/dist/server.js"
)

found=0

for pattern in "${patterns[@]}"; do
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    found=1
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    echo "Stopping backend process $pid: ${cmd:-unknown}"
    kill "$pid" 2>/dev/null || true
  done < <(pgrep -f "$pattern" || true)
done

if lsof -ti tcp:3001 >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *"$backend_root"*)
        found=1
        echo "Stopping backend port holder $pid: ${cmd:-unknown}"
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done < <(lsof -ti tcp:3001 || true)
fi

if [ "$found" -eq 0 ]; then
  echo "No local backend dev processes found."
fi
