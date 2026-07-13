#!/usr/bin/env bash
# hook-autofix.sh — Git hook with auto-fix capability
#
# Usage:
#   hook-autofix.sh pre-commit   # bin-paths + globstar autofix (before lint-staged)
#   hook-autofix.sh pre-push     # ci (build+test) + all autofix checks
#
# Auto-fixable checks: bin-paths, no-globstar, audit, prettier (lint-staged)
# Non-auto-fixable: build, typecheck, test, prune, workspace-coverage
#
# When auto-fix changes files in pre-push mode:
#   1. Amend the last commit (so the fix is included)
#   2. Exit 1 (push must be re-run with the amended commit)
#   3. User just runs `git push` again — everything passes on the second try

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MODE="${1:-pre-push}"
AUTOFIXED=0

# ─── Helpers ───────────────────────────────────────────────────

# check_or_fix <label> <check-cmd> <fix-cmd>
# Returns 0 if pass (possibly after fix), 1 if still failing.
check_or_fix() {
  local label="$1"
  local check_cmd="$2"
  local fix_cmd="$3"

  if eval "$check_cmd" >/dev/null 2>&1; then
    return 0
  fi

  echo "⚠️  $label failed — auto-fixing..."
  eval "$fix_cmd" 2>&1 | sed 's/^/   /'

  if eval "$check_cmd" >/dev/null 2>&1; then
    echo "✅ $label: auto-fixed"
    AUTOFIXED=1
    return 0
  fi

  echo "❌ $label: still failing after auto-fix"
  eval "$check_cmd"  # re-run to show the actual error
  return 1
}

# macOS/Linux compatible sed -i
sed_inplace() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# ─── Auto-fix definitions ──────────────────────────────────────

fix_bin_paths() {
  find backend/scripts packages/*/scripts -type f \( -name '*.sh' -o -name '*.bash' -o -name '*.zsh' \) 2>/dev/null | while read -r f; do
    if grep -q 'node_modules/\.bin/' "$f" 2>/dev/null; then
      sed_inplace 's|\./node_modules/\.bin/|npx --no-install |g; s|node_modules/\.bin/|npx --no-install |g' "$f"
      echo "   fixed: $f"
    fi
  done
}

fix_globstar() {
  for pkg in package.json packages/*/package.json backend/package.json; do
    [ -f "$pkg" ] || continue
    if grep -q 'tests/\*\*/' "$pkg" 2>/dev/null; then
      sed_inplace 's|tests/\*\*/\*\.test\.ts|tests/*.test.ts|g' "$pkg"
      echo "   fixed: $pkg"
    fi
  done
}

fix_audit() {
  npm audit fix --omit=dev 2>&1 || true
}

# ─── Pre-commit mode ───────────────────────────────────────────

if [ "$MODE" = "pre-commit" ]; then
  # Only run auto-fixable checks (build/typecheck are handled separately by the hook)
  check_or_fix "bin-paths"  "npm run check:bin-paths"  "fix_bin_paths"  || exit 1
  check_or_fix "no-globstar" "npm run check:no-globstar" "fix_globstar"  || exit 1
  # lint-staged runs after this in the hook, so Prettier will format the fixed files
  exit 0
fi

# ─── Pre-push mode ─────────────────────────────────────────────

# Phase 1: Non-auto-fixable checks (build + test)
# These require human intelligence — fail immediately with clear message.
echo "▶ Phase 1: Build + test (non-auto-fixable)"
if ! npm run ci 2>&1; then
  echo ""
  echo "❌ Build/test failed — cannot auto-fix."
  echo "   Fix the error above and push again."
  exit 1
fi

# Phase 2: Auto-fixable checks
echo ""
echo "▶ Phase 2: Config + style checks (auto-fixable)"

check_or_fix "bin-paths"       "npm run check:bin-paths"       "fix_bin_paths"  || exit 1
check_or_fix "no-globstar"     "npm run check:no-globstar"     "fix_globstar"   || exit 1

# workspace-coverage: not auto-fixable (requires understanding which package to add)
npm run check:workspace-coverage 2>&1 || {
  echo "❌ workspace-coverage: cannot auto-fix — add missing -w flag to root build script"
  exit 1
}

check_or_fix "audit"           "npm run audit"                 "fix_audit"      || exit 1

# Phase 3: If auto-fix changed files, amend and ask user to push again
if [ "$AUTOFIXED" -eq 1 ] && ! git diff --quiet; then
  echo ""
  echo "📝 Auto-fix modified files. Amending last commit..."
  git add -A
  git commit --amend --no-edit --no-verify
  echo "✅ Amended. The fix is now in your commit."
  echo ""
  echo "   ⚠️  Push was cancelled — run 'git push' again to push the fixed commit."
  exit 1
fi

echo ""
echo "✅ All pre-push checks passed!"
