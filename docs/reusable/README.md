# Reusable Patterns

This folder contains universal development patterns extracted from project experience. These are designed to be copy-pasted and adapted to any Node.js/TypeScript project.

## Documents

| Document | Topics |
|----------|--------|
| [CI & Git Hooks](./ci-git-hooks-patterns.md) | Pre-commit/pre-push hooks, lock file drift prevention, GitHub Actions structure, auto-remediation workflows |
| [Caching & Data Freshness](./caching-data-freshness-patterns.md) | TTL strategies, layered cache architecture, staleness detection, file snapshot design, HTTP cache headers |
| [External API Integration](./external-api-integration-patterns.md) | Per-source caching, debug metadata, sort verification, rate limiting, identifier matching |

## Usage

1. **Copy** the relevant patterns to your new project
2. **Adapt** file paths, package names, and project-specific details
3. **Remove** sections that don't apply
4. **Update** examples with your actual code

## Key Principles

### CI & Automation

- **One workflow, one responsibility**: CI checks vs remediation vs approval
- **Lock file drift prevention**: Auto-stage in pre-commit, block in pre-push
- **Auto-fix with validation**: Remediate → verify build → create PR

### Caching

- **Separate write interval from serve window**: define `writeInterval`, `softTTL`, `hardTTL`, and `fallbackMode`
- **Layered fallback**: memory → file → online cache → upstream
- **Atomic writes**: tmp + rename to prevent partial reads

### External APIs

- **Cache at narrowest layer**: Per-source, not merged results
- **Don't trust sort flags**: Verify empirically
- **Scope notes precisely**: Include exact endpoint + filters tested

## Project-Specific vs Reusable

| Type | Location | Description |
|------|----------|-------------|
| **Project-specific** | `docs/backend/`, `docs/api/`, etc. | This project's architecture, APIs, deployment |
| **Reusable patterns** | `docs/reusable/` | Universal patterns for any project |

When adding new documentation:
- If it applies to any Node.js project → `docs/reusable/`
- If it's specific to this codebase → appropriate domain folder
