#!/usr/bin/env bash
# Poll a deployed /health endpoint until it serves the expected commit SHA.
# Used by the rollback drill for both the rollback and the restore wait, so the
# retry/timeout policy lives in one place.
#
# Usage: wait-for-commit-sha.sh <health-url> <expected-sha> [attempts] [interval-seconds]
set -euo pipefail

HEALTH_URL=${1:?usage: wait-for-commit-sha.sh <health-url> <expected-sha> [attempts] [interval-seconds]}
EXPECTED_SHA=${2:?usage: wait-for-commit-sha.sh <health-url> <expected-sha> [attempts] [interval-seconds]}
ATTEMPTS=${3:-60}
INTERVAL=${4:-10}

for attempt in $(seq 1 "$ATTEMPTS"); do
  SHA=$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null \
    | jq -r '.commitSha // empty' 2>/dev/null || true)
  if [ "$SHA" = "$EXPECTED_SHA" ]; then
    echo "✅ health is serving $EXPECTED_SHA"
    exit 0
  fi
  echo "attempt $attempt/$ATTEMPTS: health commitSha=${SHA:-<empty>} (want $EXPECTED_SHA)"
  sleep "$INTERVAL"
done

echo "::error::health did not reach $EXPECTED_SHA after $ATTEMPTS attempts"
exit 1
