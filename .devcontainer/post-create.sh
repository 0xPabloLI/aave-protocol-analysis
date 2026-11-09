#!/usr/bin/env bash
# Dev container bootstrap — mirrors the Dockerfile's build inputs so a fresh
# container reaches a green `npm run build` with zero manual steps.
#
# Pinned npm version must match the Dockerfile (npm's lockfile validation
# differs across minor versions, so a mismatch produces spurious npm ci errors).
set -euo pipefail

NPM_VERSION="11.6.2"

echo "==> Pinning npm to ${NPM_VERSION} (matches Dockerfile)"
npm install -g "npm@${NPM_VERSION}" >/dev/null

echo "==> Ensuring node_modules matches package-lock.json"
# HUSKY=0: no .git hooks needed inside the container, and husky would fail
# without a .git directory in some mount setups.
HUSKY=0 npm ci

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "==> Creating .env from .env.example (fill in real values as needed)"
  cp .env.example .env
fi

echo "==> Building workspaces (shared-contracts → rpc-infra → fetcher → root)"
npm run build

cat <<'EOF'

Dev container ready.

Useful commands:
  npm run dev                      # run the root fetcher CLI
  npm run dev -w aave-dashboard-backend   # backend API on :3001
  npm run check:quality            # lint + syncpack + todos + jscpd + knip + naming + flags
  docker compose up -d postgres    # local Postgres archive (optional; DB is opt-in)

EOF
