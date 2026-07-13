# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — contains the Aave V3/V4 domain language (Market, Reserve, Hub, Spoke, Asset, Incentive, etc.)
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. (Directory does not yet exist; will be created lazily by `/grill-with-docs`.)

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-*.md
│   └── ...
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

Key distinctions enforced by CONTEXT.md:
- **Market** = logical deployment unit (V3 Pool / V4 Spoke), NOT "pool"
- **Reserve** = per-Market per-token lending state, NOT "asset" (V4 Asset is Hub-level)
- **reserveId** = project's global composite key (string), NOT contract's uint256 local ID

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (…) — but worth reopening because…_
