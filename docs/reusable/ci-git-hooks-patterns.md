# CI & Git Hooks Patterns (Reusable)

Universal patterns for CI/CD and local git hooks. Copy and adapt to any Node.js project.

## 1. Local Git Hooks with Auto-Fix

### Pre-commit Hook

```bash
#!/usr/bin/env bash
set -euo pipefail

# === Lock File Drift Prevention ===
# Auto-stage lock files to prevent local/CI audit drift
for lockfile in package-lock.json backend/package-lock.json; do
  if [ -f "$lockfile" ] && ! git diff --quiet -- "$lockfile" 2>/dev/null; then
    echo "[hook] WARNING: $lockfile has unstaged changes"
    echo "[hook] Auto-staging $lockfile to prevent local/CI drift"
    git add "$lockfile"
  fi
done

# === Main CI Check ===
echo "[hook] running npm run ci:remote"
if npm run ci:remote; then
  exit 0
fi

# === Auto-Fix Attempt ===
echo "[hook] ci:remote failed, attempting npm run ci:auto-fix"
npm run ci:auto-fix || true

echo "[hook] rerunning npm run ci:remote after auto-fix"
npm run ci:remote
```

### Pre-push Hook

```bash
#!/usr/bin/env bash
set -euo pipefail

# === Lock File Drift Prevention ===
# Block push if lock files have uncommitted changes
for lockfile in package-lock.json backend/package-lock.json; do
  if [ -f "$lockfile" ] && ! git diff --quiet -- "$lockfile" 2>/dev/null; then
    echo "[hook] ERROR: $lockfile has uncommitted changes"
    echo "[hook] CI will use the committed version, which may differ from local"
    echo "[hook] Please commit package-lock.json changes first"
    exit 1
  fi
done

# === Main CI Check ===
echo "[hook] running npm run ci:remote"
if npm run ci:remote; then
  exit 0
fi

# === Auto-Fix Attempt ===
echo "[hook] ci:remote failed, attempting npm run ci:auto-fix"
npm run ci:auto-fix || true

echo "[hook] rerunning npm run ci:remote after auto-fix"
npm run ci:remote
```

### Package.json Scripts

```json
{
  "scripts": {
    "ci": "npm ci && npm run build && npm run lint && npm run test",
    "ci:remote": "npm run ci && npm audit --omit=dev --audit-level=high",
    "ci:auto-fix": "npm audit fix --omit=dev || true"
  }
}
```

## 2. GitHub Actions: Separated Concerns

### Principle: One Workflow, One Responsibility

| Workflow | Permissions | Trigger | Responsibility |
|----------|-------------|---------|----------------|
| `ci.yml` | `contents: read` | push, PR | Build, test, lint, audit |
| `ci-auto-remediation.yml` | `contents: write`, `pull-requests: write` | workflow_run (on CI failure) | Auto-fix and create PR |
| `auto-approve-remediation-pr.yml` | `pull-requests: write` | pull_request_target | Approve and auto-merge bot PRs |

### Anti-Pattern: Inline Remediation

❌ **Don't** add remediation logic inside `ci.yml`:
- Creates duplicate PRs when separate remediation workflow also triggers
- Requires elevated permissions for main CI workflow
- Harder to maintain and debug

✅ **Do** keep remediation in separate workflow triggered by `workflow_run`

### CI Workflow (Read-Only)

```yaml
name: CI
on:
  push:
    branches: [main, develop, feature/**]
  pull_request:
    branches: [main, develop]

permissions:
  contents: read

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run build
      - run: npm run lint
      - run: npm run test

  security-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high

  # NOTE: Auto-remediation handled by ci-auto-remediation.yml
```

### Auto-Remediation Workflow

```yaml
name: CI Auto Remediation
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main, develop, feature/**]
  workflow_dispatch:
    inputs:
      branch:
        description: "Branch to remediate"
        required: false
        type: string

permissions:
  actions: read
  contents: write
  pull-requests: write

jobs:
  remediate:
    # Only run on push failures, not PR failures
    if: >
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'failure' && 
       github.event.workflow_run.event == 'push')
    runs-on: ubuntu-latest
    steps:
      - name: Resolve target branch
        id: branch
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ] && [ -n "${{ inputs.branch }}" ]; then
            echo "name=${{ inputs.branch }}" >> "$GITHUB_OUTPUT"
          elif [ "${{ github.event_name }}" = "workflow_run" ]; then
            echo "name=${{ github.event.workflow_run.head_branch }}" >> "$GITHUB_OUTPUT"
          else
            echo "name=${{ github.event.repository.default_branch }}" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.branch.outputs.name }}

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci

      - name: Attempt dependency remediation
        run: npm audit fix --omit=dev || true

      - run: npm ci  # Reinstall to verify

      - name: Validate build after remediation
        id: verify
        run: |
          set +e
          npm run build
          if [ $? -eq 0 ]; then
            echo "ok=true" >> "$GITHUB_OUTPUT"
          else
            echo "ok=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Check for changes
        id: diff
        run: |
          if git diff --quiet; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Create remediation PR
        if: steps.verify.outputs.ok == 'true' && steps.diff.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          commit-message: "chore: auto-remediate dependency issues"
          branch: "bot/ci-auto-remediation-${{ github.run_id }}"
          delete-branch: true
          title: "chore: auto remediation for CI failure (${{ steps.branch.outputs.name }})"
          body: |
            Auto-generated remediation PR.
            
            Actions performed:
            - `npm audit fix --omit=dev`
            - `npm run build` (validation)
          labels: ci-auto-remediation,dependencies
          base: ${{ steps.branch.outputs.name }}
```

## 3. Lock File Drift Problem & Solution

### The Problem

```
Developer machine                     CI server
─────────────────                     ─────────
npm audit fix                         git clone
  ↓                                     ↓
package-lock.json updated             npm ci (uses committed lock)
  ↓                                     ↓
local audit passes                    audit FAILS (old vulnerable deps)
  ↓
git commit (without lock file!)
  ↓
git push
```

### Why Local Hooks Don't Catch It

1. Hook runs `npm ci` → installs from **local** `package-lock.json` (already updated)
2. Hook runs `npm audit` → passes (using fixed local deps)
3. CI runs `npm ci` → installs from **committed** `package-lock.json` (old)
4. CI runs `npm audit` → fails (vulnerable deps)

### The Solution

**Pre-commit**: Auto-stage lock files before commit
**Pre-push**: Block if lock files differ from committed version

This ensures any lock file changes from `npm install` or `npm audit fix` are always committed.

## 4. Security Audit Strategy

### High/Critical: Block Merge

```yaml
- run: npm audit --omit=dev --audit-level=high
```

- Fails CI if High or Critical vulnerabilities in runtime deps
- Forces immediate action

### Moderate: Track via Issue

```yaml
# Separate workflow, weekly schedule
- run: npm audit --omit=dev --json > audit.json
# Parse and create/update tracking issue
```

- Does not block daily development
- Creates visibility for eventual cleanup

### Dev Dependencies

- Excluded from audits (`--omit=dev`)
- Less critical since not shipped to production
- Can be tracked separately if needed

## 5. Monorepo Considerations

For projects with multiple `package.json` (e.g., root + backend):

```bash
# CI script
npm ci
npm --prefix backend ci
npm run build
npm --prefix backend run build
npm audit --omit=dev --audit-level=high
npm --prefix backend audit --omit=dev --audit-level=high
```

```bash
# Auto-fix script
npm audit fix --omit=dev || true
npm --prefix backend audit fix --omit=dev || true
```

```bash
# Lock file check (in hooks)
for lockfile in package-lock.json backend/package-lock.json; do
  # ... check each lock file
done
```
