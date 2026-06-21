#!/usr/bin/env bash
set -euo pipefail

# Packages whose CVEs are known-unfixable at current versions:
# - elliptic / @ethersproject/* / ethers@5: locked by Aave SDK, cannot upgrade to v6
# - undici: locked to 7.x by cheerio; 8.x breaks compatibility
# - ws: 8.21.0 is latest; upstream has not published a fix yet
# - hono: 4.12.26 is latest; Dependabot advisories lag behind published fixes
# - js-yaml: dev-only dependency, not in production image
ALLOWED_PKGS="elliptic|@ethersproject/.*|ethers|undici|ws|hono|js-yaml"

audit_step() {
  local lvl out
  lvl="$1"
  out="/tmp/_audit_$$_${lvl}"
  npm audit --omit=dev "--audit-level=${lvl}" >"$out" 2>&1 || true

  # Must produce an npm audit report
  head -1 "$out" | grep -qE '^found|^# npm audit report' || { cat "$out" >&2; rm -f "$out"; exit 1; }

  # Find vulnerable packages not in the allowlist
  if grep -E '^[a-zA-Z@]' "$out" | grep -vE "^(${ALLOWED_PKGS})" | grep -q .; then
    echo "::error::Unallowed vulnerabilities found:" >&2
    grep -E '^[a-zA-Z@]' "$out" | grep -vE "^(${ALLOWED_PKGS})" >&2
    rm -f "$out"
    exit 1
  fi

  rm -f "$out"
}

# Step 1: high-severity check (root workspace)
audit_step high

# Step 2: moderate-severity check (backend sub-workspace)
npm --prefix backend audit --omit=dev --audit-level=moderate >/tmp/_audit_$$_backend 2>&1 || true
head -1 /tmp/_audit_$$_backend | grep -qE '^found|^# npm audit report' || { cat /tmp/_audit_$$_backend >&2; rm -f /tmp/_audit_$$_backend; exit 1; }
if grep -E '^[a-zA-Z@]' /tmp/_audit_$$_backend | grep -vE "^(${ALLOWED_PKGS})" | grep -q .; then
  echo "::error::Unallowed vulnerabilities found in backend:" >&2
  grep -E '^[a-zA-Z@]' /tmp/_audit_$$_backend | grep -vE "^(${ALLOWED_PKGS})" >&2
  rm -f /tmp/_audit_$$_backend
  exit 1
fi
rm -f /tmp/_audit_$$_backend

exit 0
