---
alwaysApply: true
scene: all
---

# Project Rules - Aave Protocol Analysis

## Session Startup (Mandatory)

Every new session MUST follow this bootstrap sequence BEFORE any other action:

1. **Load `using-superpowers` skill** — Use the `Skill` tool to invoke `using-superpowers`
2. **Load `brainstorming` skill** — Use the `Skill` tool to invoke `brainstorming`
3. **Read `AGENTS.md`** — Review project-specific rules

This is mandatory. Do not skip even for simple questions.

## Why This Matters

- `using-superpowers` establishes the discipline of checking skills before any action
- `brainstorming` ensures creative work follows a design-first process
- `AGENTS.md` contains project-specific architecture and safety rules

## Data Validity Rule (Critical)

**When proposing ANY code change involving blockchain numerical values, you MUST cross-check against actual data files before making the recommendation.**

Specifically:

1. **`raw` vs `value` are NOT interchangeable**:
   - `amount.raw` = on-chain base units (includes decimals, e.g. `"7000000000000000000000000"` for 7M tokens with 18dp)
   - `amount.value` = human-readable units (decimal-applied, e.g. `"7000000"`)
   - Checking `raw === "1"` means "1 wei" (10^-18), NOT "1 token"
   - Checking `value === 1` means "1 whole token"

2. **Always verify assumptions against `data/debug/` files** before suggesting:
   - Unit conversions between raw/value/usd
   - Arithmetic operations (subtraction, comparison, clamping)
   - Condition checks on token amounts (e.g. "is supplyCap disabled?")

3. **If you're unsure about decimal semantics, read the actual debug data first.**

Example of a wrong assumption caught by this rule:
> ❌ *"`supplyCapIsOne` could be `supplyCap === '1'` using raw"* — WRONG: raw includes decimals. For a token with 18dp, raw="1000000000000000000" ≠ "1", but value="1" is correct.
> ✅ `toFiniteNumber(supplyCapValue) === 1` — correct: value already has decimals applied.

## Enforcement

If you (the AI) have not completed the bootstrap sequence, STOP and do it now.
Do not proceed with user requests until these skills are loaded.
