#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

autofix_script=$(node -e "const p=require('./package.json'); console.log(p.scripts['ci:auto-fix'] || '')")

if echo "$autofix_script" | grep -qE '\-\-omit[= ][dD]ev'; then
  echo "❌ ci:auto-fix contains --omit=dev flag" >&2
  echo "   This is dangerous: npm audit fix --omit=dev temporarily removes all" >&2
  echo "   devDependencies from node_modules, corrupting the development environment." >&2
  echo "" >&2
  echo "   Current ci:auto-fix: $autofix_script" >&2
  exit 1
fi

echo "✅ ci:auto-fix does not use --omit=dev flag."