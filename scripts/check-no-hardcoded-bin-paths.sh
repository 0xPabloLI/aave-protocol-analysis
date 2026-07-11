#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

violations=0

for dir in backend/scripts packages/*/scripts; do
  [ -d "$dir" ] || continue
  while IFS= read -r file; do
    if matches=$(grep -Hn 'node_modules/\.bin/' "$file" 2>/dev/null); then
      if [ "$violations" -eq 0 ]; then
        echo "❌ Hardcoded node_modules/.bin/ paths found in workspace sub-project scripts:" >&2
      fi
      echo "$matches" >&2
      violations=$((violations + $(echo "$matches" | wc -l)))
    fi
  done < <(find "$dir" -type f \( -name '*.sh' -o -name '*.bash' -o -name '*.zsh' \) 2>/dev/null || true)
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "💡 In npm workspaces, node_modules is hoisted to root. Use 'npx --no-install <tool>' instead of './node_modules/.bin/<tool>'." >&2
  exit 1
fi

echo "✅ No hardcoded node_modules/.bin/ paths in workspace sub-project scripts."