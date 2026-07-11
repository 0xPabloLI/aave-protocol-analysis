#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

root_build=$(jq -r '.scripts.build // ""' package.json)

uncovered=0

for pkg_json in packages/*/package.json; do
  pkg_name=$(jq -r '.name' "$pkg_json")
  has_build=$(jq -r 'if .scripts.build then "yes" else "no" end' "$pkg_json")

  if [ "$has_build" = "no" ]; then
    continue
  fi

  if echo "$root_build" | grep -q -- "-w[ =]$pkg_name"; then
    :
  else
    if [ "$uncovered" -eq 0 ]; then
      echo "❌ Packages with build scripts NOT covered by root build script:" >&2
    fi
    echo "  - $pkg_name" >&2
    uncovered=$((uncovered + 1))
  fi
done

if [ "$uncovered" -gt 0 ]; then
  echo "" >&2
  echo "💡 Add '-w $pkg_name' to the root build script in package.json, or add a build script to the package." >&2
  exit 1
fi

echo "✅ All packages with build scripts are covered by root build script."
