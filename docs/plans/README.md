# docs/plans/ — Plan Directory Convention

## Directory Structure

| Directory | Purpose |
|---|---|
| `docs/plans/` | **Active or pending plans.** New plans are created here. |
| `docs/plans/executed/` | **Completed plans.** Moved here after execution finishes. |
| `docs/plans/linear-issues/` | **Linear issue trackers.** Detailed implementation records keyed by Linear issue ID (e.g. `aav_170_plan.md`). Stay here regardless of status. |

## File Naming

- Date-prefixed for time-bound plans: `YYYY-MM-DD-<topic>.md`
- Linear issue trackers: `aav_<number>_plan.md`

## Lifecycle

```
docs/plans/<plan>.md          ← Created during brainstorming / writing-plans
        │
        ▼  (implementation complete)
docs/plans/executed/<plan>.md ← Moved here after execution
```

## Status Markers

Each plan should include a status block at the top:

```markdown
> **Status: Active** — implementation in progress.
> **Status: Executed** (YYYY-MM-DD) — done, moved to `executed/`.
```

## Non-Plan Files

Data files (`.json`, seed data, keyword lists) that are inputs to plans but not plans themselves should be placed in `docs/plans/data/` or remain at the root as reference.