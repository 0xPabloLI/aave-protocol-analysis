#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

violations=0

for pkg_json in package.json packages/*/package.json backend/package.json; do
  [ -f "$pkg_json" ] || continue

  test_script=$(node -e "
    const pkg = require('./$pkg_json');
    console.log(pkg.scripts?.test || '');
  " 2>/dev/null)

  if echo "$test_script" | grep -qE '\*\*/'; then
    if [ "$violations" -eq 0 ]; then
      echo "❌ Glob pattern **/ found in test scripts (won't expand in CI bash):" >&2
    fi
    echo "  $pkg_json: $test_script" >&2
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "💡 Use tests/*.test.ts (single-level glob) instead of tests/**/*.test.ts." >&2
  echo "   ** requires globstar (zsh default, bash default-off), which CI's sh -c does not enable." >&2
  exit 1
fi

echo "✅ No **/ glob patterns in test scripts."
