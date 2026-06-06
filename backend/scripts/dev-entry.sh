#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/dev-clean.sh

# Preflight: ensure Docker runtime is available
if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "[dev-entry] Docker not running — starting Colima..." >&2
    if ! colima start 2>&1; then
      echo "[dev-entry] colima start failed — cleaning up stale state and retrying..." >&2
      colima delete -f 2>/dev/null || true
      colima start
    fi
    echo "[dev-entry] waiting for Docker daemon..." >&2
    for _i in $(seq 1 30); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
    if ! docker info >/dev/null 2>&1; then
      echo "[dev-entry] ERROR: Colima started but Docker still unreachable" >&2
      exit 1
    fi
  else
    echo "[dev-entry] ERROR: Docker not running and Colima not found. Start Docker or install Colima." >&2
    exit 1
  fi
fi

# Preflight: ensure local Postgres is running (Docker: aave-pg)
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^aave-pg$'; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^aave-pg$'; then
    echo "[dev-entry] starting existing aave-pg container..." >&2
    docker start aave-pg
  else
    echo "[dev-entry] creating & starting aave-pg container..." >&2
    docker run -d --name aave-pg -p 5432:5432 \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=railway \
      postgres:16
  fi
  echo "[dev-entry] waiting for Postgres to accept connections..." >&2
  for _i in $(seq 1 15); do
    if docker exec aave-pg pg_isready -U postgres -d railway >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  echo "[dev-entry] Postgres ready" >&2
fi

# Preflight: ensure workspace deps fully installed
_needs_install=0

# Check 1: root node_modules missing entirely
if [ ! -d "../node_modules" ]; then
  echo "[dev-entry] root node_modules missing — need npm install" >&2
  _needs_install=1
# Check 2: root package.json/lock newer than node_modules — deps may be stale
elif [ "../package.json" -nt "../node_modules" ] || [ "../package-lock.json" -nt "../node_modules" ]; then
  echo "[dev-entry] root package.json/lock newer than node_modules — need npm install" >&2
  _needs_install=1
# Check 3: verify ALL declared deps resolvable (catches partial installs)
else
  _missing="$(node -e "
    const deps = {...require('./package.json').dependencies, ...require('./package.json').devDependencies};
    const skip = d => d.startsWith('@internal/') || d.startsWith('@types/');
    const missing = Object.keys(deps).filter(d => !skip(d) && (() => { try { require.resolve(d); return false; } catch { return true; } })());
    if (missing.length) process.stdout.write(missing.join(' '));
  " 2>/dev/null || true)"
  if [ -n "$_missing" ]; then
    echo "[dev-entry] deps not resolvable: $_missing — need npm install" >&2
    _needs_install=1
  fi
fi

if [ "$_needs_install" -eq 1 ]; then
  echo "[dev-entry] running npm install from root..." >&2
  (cd .. && npm install)
fi

# Preflight: ensure workspace packages are built (backend imports from @internal/* packages)
if [ ! -d "../packages/aave-shared-contracts/dist" ] || [ ! -d "../packages/aave-rpc-infra/dist" ] || [ ! -d "../packages/aave-fetcher/dist" ]; then
  echo "[dev-entry] workspace packages not built — running root install & build..." >&2
  (cd .. && npm install && npm run build)
fi

# Self-repair: if the server crashes with MODULE_NOT_FOUND, reinstall deps and retry (up to 2 attempts)
_max_repair=2
_attempt=0

while [ "$_attempt" -lt "$_max_repair" ]; do
  _attempt=$((_attempt + 1))

  case "${1:-}" in
    --watch) npx --no-install tsx watch src/server.ts ;;
    "")      npx --no-install tsx src/server.ts ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: bash scripts/dev-entry.sh [--watch]" >&2
      exit 1
      ;;
  esac
  _exit=$?

  # Exit code 0 = clean shutdown
  if [ "$_exit" -eq 0 ]; then
    exit 0
  fi

  # Non-zero exit: check if a dep is now missing (MODULE_NOT_FOUND scenario)
  _missing="$(node -e "
    const deps = {...require('./package.json').dependencies, ...require('./package.json').devDependencies};
    const skip = d => d.startsWith('@internal/') || d.startsWith('@types/');
    const missing = Object.keys(deps).filter(d => !skip(d) && (() => { try { require.resolve(d); return false; } catch { return true; } })());
    if (missing.length) process.stdout.write(missing.join(' '));
  " 2>/dev/null || true)"

  if [ -z "$_missing" ]; then
    echo "[dev-entry] process exited (code=$_exit) but all deps resolvable — not a dep issue, exiting" >&2
    exit "$_exit"
  fi

  echo "[dev-entry] runtime dep missing: $_missing — running npm install (attempt $_attempt/$_max_repair)..." >&2
  (cd .. && npm install)
done

echo "[dev-entry] still failing after $_max_repair repair attempts" >&2
exit "$_exit"
