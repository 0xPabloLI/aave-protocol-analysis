# Spec: Safe Symbol Normalization for LLM Net-Position Offsets

> **Status: Spec finalized** (2026-07-19) — ready for implementation. Scope: collision-aware symbol normalization via case-insensitive matching + equivalence groups + observability logging. No cross-token fuzzy matching. Revised after Grill with Docs session (see ADR-0036).

## Problem

When the Merkl net-position detector falls back to the LLM (Layer 3 of `detectNetPositionConstraint`), the model returns `offsetTokenSymbols: string[]`. Each symbol is resolved to a market token via an **exact, case-sensitive** lookup:

```ts
// packages/aave-fetcher/src/merkl-api.ts (detectNetPositionConstraint, ~L2094)
const tokenAddr = symbolLookup.get(chainSymbolKey(opp.chainId, symbol)); // `${chainId}:${symbol}`
if (!tokenAddr) return null;
```

`symbolLookup` is built in `index.ts` from the real market reserves (`chainId:tokenSymbol → tokenAddress`, first-write-wins on collision).

This exact match **fails safe**: an unknown symbol drops the whole constraint to `null` (no wrong offset is ever produced). But it silently drops constraints that are _semantically correct_ yet formatted differently, which under-applies the net offset and **over-counts the reward APR**. Observed risk classes (verified against real Merkl + market data):

1. **Case differences** — LLM returns `usde` / `USDE` vs market `USDe`.
2. **Unicode↔ASCII** — LLM writes `'USDT0'` (ASCII) where the market symbol is `USD₮0` (Unicode ₮ U+20AE). Also `'USDT'` may refer to `USD₮` (Celo, no trailing `0`). Case-insensitive matching cannot recover these — ₮ is not affected by `toLowerCase()`.
3. **Silent failure** — rejections are not logged, so we have no visibility into how often the LLM path drops constraints or why.

## Verified Facts

All verified against real data in `data/debug/v3v4-enriched-full.json` (385 reserves) and `data/debug/merkl-raw-data.json` (41 live opportunities).

1. **The lookup already validates and fails safe.** `if (!tokenAddr) return null` (`merkl-api.ts:2094-2095`). → We are adding _recovery of correct answers_, not fixing a wrong-offset bug.

2. **Looping campaigns never reach the LLM.** `if (text.includes('looping')) return null` runs before the LLM call. → **Out of scope.**

3. **`chainSymbolKey(chainId, symbol)` = `` `${chainId}:${symbol}` ``** — exact, case-sensitive, no normalization (`shared-contracts/src/keys.ts:38-40`).

4. **Cross-token fuzzy matching is unsafe.** `USDT` / `USD₮0` / `USD₮` / `USDt` are distinct market symbols (different underlying tokens). → **Explicitly excluded.** However, they form a _Unicode equivalence group_ — LLM may ASCII-ify ₮ in any direction. Recovery is safe because they are **pairwise non-co-chain** (verified):
   - `USDT` → chains: 1, 56, 59144, 1868, 324, 10
   - `USD₮0` → chains: 42161, 57073, 196
   - `USD₮` → chains: 42220
   - `USDt` → chains: 43114
   - All pairwise intersections are empty.

5. **Exact collisions exist** (same chain + same symbol, different addresses). 3 cases in current data, all `USDC`:
   - `42161:USDC` → 2 addresses (native + bridged)
   - `137:USDC` → 2 addresses
   - `10:USDC` → 2 addresses
     First-write-wins currently silently picks one. **Revised design returns all addresses** (see Design § Collision Strategy).

6. **Offset resolution is chain-scoped.** `resolveOffsetReserveIds` extracts `chainId:poolAddress` prefix from `oppReserveId` and only matches within the same chain. `symbolLookup.get(chainSymbolKey(opp.chainId, symbol))` also uses `opp.chainId`. → Equivalence group aliasing is safe: on any given chain, at most one group member exists.

7. **Downstream consumption is conservative for over-inclusion.** Net position calculation: `net = source - Σ(offset positions)`, then `Math.max(0, net)`. If an offset reserve is included but the user has no position there → `offsetPos` is undefined → `continue` → contributes 0 → no effect. If the user has a position → subtracts more → net smaller → reward smaller (conservative direction). `Math.max(0, net)` prevents negative. → **Over-inclusion of offset reserves is always safe (conservative or neutral).**

8. **All NET opportunity messages include the source token in the offset list.** Verified 13/13 NET opportunities: every message follows `X supply minus X, ... borrows` pattern — self is always an offset. → Explicitly adding `oppReserveId` to `offsetReserveIds` (LLM path) aligns with L0 behavior and message semantics.

9. **LLM path is a fallback**, reached only when Layer 0 (`extractNetPositionConstraint`, uses structured `offsetTokenAddresses`), Layer 0.5 (`composedNetPositionConstraint`), Layer 1 (looping guard), and Layer 2 (cache) all miss. Layer 0 currently captures 100% of `AAVE_NET_*` opportunities (21 lending + 8 borrowing = 29/41 live opps). → Symbol normalization is a **forward-looking defense** for when LLM path is reached; current production data rarely exercises it.

## Goals / Non-Goals

**Goals**

- Recover semantically-correct LLM offset symbols that differ only by case (Strategy 2: CI).
- Recover LLM offset symbols that differ by Unicode↔ASCII via an explicitly enumerated, tested equivalence group (Strategy 3).
- Add observability: log when an LLM offset symbol is rejected (cannot be resolved).
- Preserve fail-safe: never emit a wrong offset. Over-inclusion is acceptable (conservative).

**Non-Goals**

- No cross-token heuristic/fuzzy matching (e.g. prefix/substring, edit-distance).
- No change to the looping guard or the structured (Layer 0/0.5) paths.
- No change to the LLM prompt or model selection.
- No fix for exact symbol collisions (same symbol, different tokens on same chain) — this is pre-existing and out of scope. The revised design returns all addresses for collisions (conservative), but does not attempt to disambiguate which is "correct".

## Design

### Three-layer symbol resolver (Strategy X)

Introduce a pure helper `resolveOffsetSymbolAddress` that resolves an LLM-provided symbol to a set of market `tokenAddress`es on a given chain via three ordered strategies. All matches are unioned (over-inclusion is safe per Verified Fact #7). Empty result → caller logs + skips the symbol (A2 strategy, see Failure Handling).

```diagram
resolveOffsetSymbolAddress(chainId, symbol, symbolLookup, symbolLookupCI, equivLookup):
  addrs = new Set<string>()

  1. exact:   symbolLookup[chainId:symbol]                       → add
  2. CI:      symbolLookupCI[chainId:lower(symbol)]              → add all
  3. equiv:   for member in equivLookup[symbol] (excluding self):
                exact: symbolLookup[chainId:member]              → add
                CI:    symbolLookupCI[chainId:lower(member)]     → add all

  return [...addrs]   // empty → caller warns + skips symbol
```

### Collision strategy: return all (not fail-safe)

Unlike the original spec draft (which proposed an `AMBIGUOUS` sentinel to fail-safe on collisions), the revised design **returns all matching addresses** for any collision. Rationale: downstream net-position consumption is conservative for over-inclusion (Verified Fact #7), so returning all addresses is always safe. This eliminates the `AMBIGUOUS` sentinel complexity.

- `symbolLookup` (exact, Strategy 1): stays `Map<string, string>` first-write-wins — only returns one address, but Strategy 2 (CI) subsumes it.
- `symbolLookupCI` (Strategy 2): `Map<string, string[]>` — collects ALL addresses for a given `chainId:lower(symbol)`.
- Equivalence group (Strategy 3): each member re-runs Strategy 1 + 2, results unioned.

### Equivalence groups (replaces alias table)

Replaces the original spec's single-direction `ALIAS[symbol] → target` with **bidirectional equivalence groups** — any member can resolve to any other member. Rationale: LLM may ASCII-ify Unicode in any direction (`USD₮0`→`USDT` or `USDT`→`USD₮0`), so single-direction aliasing only covers half the cases.

```ts
const SYMBOL_EQUIV_GROUPS: string[][] = [
  ["USDT", "USD₮0", "USD₮"], // Tether USD Unicode variants. USDt covered by CI (lowercase collision).
];
```

Built into a reverse lookup `Map<string, Set<string>>` (symbol → other group members) once per `enrichDatasetWithIncentiveData` invocation.

**Safety**: group members are pairwise non-co-chain (Verified Fact #4), so on any given chain at most one member exists in market reserves. No ambiguity.

### Failure handling: A2 (skip + warn), not fail-fast

When a symbol resolves to zero addresses:

- **Original spec**: `return null` (drop entire constraint) — fail-fast.
- **Revised**: `logger.warn(...)` with `{ symbol, chainId, oppId/name }` and `continue` to next symbol — skip the failed symbol, keep building the constraint with resolved offsets.

Rationale: fail-fast is actually **more over-counting** — dropping the entire constraint means full-position × APR (maximum over-count), while skipping one symbol still applies the remaining offsets (partial net position, slight over-count). The `warn` log provides observability to investigate rejected symbols.

### Self reserveId: explicit add (aligns LLM path with L0)

After the LLM symbol loop, explicitly add `oppReserveId` to `offsetReserveIds` (if not already present via `seen` set). This aligns the LLM path with L0 (`extractNetPositionConstraint` always includes self) and matches message semantics (Verified Fact #8: 100% of NET opp messages include source token in offset list).

This is a **pre-existing inconsistency fix** — L0 has always included self, but the LLM path relied on the LLM naturally returning the source symbol. Explicit add makes it robust even if the LLM omits the source symbol.

### Boundary: all symbols fail

If ALL LLM-returned symbols resolve to zero addresses, `offsetReserveIds` will contain only `oppReserveId` (from explicit self-add). Return `{ sourceSide, offsetReserveIds: [oppReserveId] }` — consistent with `regexNetPositionFallback` (which returns `offsetReserveIds: []` but gets self added in its caller... actually regex path doesn't add self either — this is a separate known issue, not in scope). The `sourceSide` is the LLM's valid judgment and should be preserved.

### Module placement: new `merkl-symbol-resolver.ts`

New module `packages/aave-fetcher/src/merkl-symbol-resolver.ts` (~80 lines):

- `SYMBOL_EQUIV_GROUPS` constant
- `buildEquivLookup(): Map<string, Set<string>>`
- `buildSymbolLookupCI(reserves: RuntimeReserveData[]): Map<string, string[]>`
- `resolveOffsetSymbolAddress(chainId, symbol, symbolLookup, symbolLookupCI, equivLookup): string[]`

Pure functions, no logger dependency (warn is emitted by caller in `merkl-api.ts`). Keeps `merkl-api.ts` (already 2351 lines) from growing further.

### Call-site change (`detectNetPositionConstraint`)

Replace the single-line exact lookup + fail-fast `return null`:

```ts
// BEFORE (merkl-api.ts:2093-2095)
for (const symbol of offsetTokenSymbols) {
  const tokenAddr = symbolLookup.get(chainSymbolKey(opp.chainId, symbol));
  if (!tokenAddr) return null;  // fail-fast
  const resolvedIds = resolveOffsetReserveIds(oppReserveId, tokenAddr.toLowerCase(), reserveIdSet, offsetLevel);
  if (resolvedIds.length === 0) return null;  // fail-fast
  for (const rid of resolvedIds) { ... }
}
```

With resolver + skip + warn + explicit self:

```ts
// AFTER
for (const symbol of offsetTokenSymbols) {
  const tokenAddrs = resolveOffsetSymbolAddress(
    opp.chainId,
    symbol,
    symbolLookup,
    symbolLookupCI,
    equivLookup
  );
  if (tokenAddrs.length === 0) {
    logger.warn(`⚠️ LLM offset symbol unresolvable`, {
      symbol,
      chainId: opp.chainId,
      oppId: opp.opportunityId,
      oppName: opp.name,
    });
    continue; // A2: skip, don't drop entire constraint
  }
  for (const addr of tokenAddrs) {
    const resolvedIds = resolveOffsetReserveIds(
      oppReserveId,
      addr.toLowerCase(),
      reserveIdSet,
      offsetLevel
    );
    for (const rid of resolvedIds) {
      if (!seen.has(rid)) {
        seen.add(rid);
        offsetReserveIds.push(rid);
      }
    }
  }
}
// Explicit self-add (align with L0)
if (!seen.has(oppReserveId)) {
  offsetReserveIds.unshift(oppReserveId);
  seen.add(oppReserveId);
}
if (offsetReserveIds.length > 0) return { sourceSide, offsetReserveIds };
```

### Signature extension

`detectNetPositionConstraint` gains two new parameters: `symbolLookupCI: Map<string, string[]>` and `equivLookup: Map<string, Set<string>>`. Both built in `enrichDatasetWithIncentiveData` (`index.ts`) alongside the existing `symbolLookup`.

## Files Touched

| File                                                              | Change                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/aave-fetcher/src/merkl-symbol-resolver.ts`              | **NEW**: equivalence groups, CI map builder, resolver helper.                                                         |
| `packages/aave-fetcher/src/index.ts`                              | Build `symbolLookupCI` + `equivLookup`; pass into `detectNetPositionConstraint`.                                      |
| `packages/aave-fetcher/src/merkl-api.ts`                          | Use resolver in `detectNetPositionConstraint` LLM path; add skip+warn; add explicit self reserveId; extend signature. |
| `packages/aave-fetcher/tests/merkl-symbol-resolver.test.ts`       | **NEW**: unit tests for resolver (see Test Plan).                                                                     |
| `packages/aave-fetcher/tests/detectNetPositionConstraint.test.ts` | Extend: A2 skip behavior, self reserveId, CI recovery, equiv group recovery.                                          |

No changes to `@internal/aave-shared-contracts` (`chainSymbolKey` contract unchanged), no serialization/type changes, no new reserve fields.

## Test Plan (TDD — write first)

### Unit tests for `resolveOffsetSymbolAddress` (`merkl-symbol-resolver.test.ts`)

1. **Exact match** — `USDe` → address. Regression.
2. **Case-insensitive recovery** — `usde` / `USDE` / `Usde` → same address as `USDe`.
3. **Exact collision returns all** — when two distinct addresses share `chainId:USDC` (e.g. Arbitrum), resolver returns both.
4. **CI collision returns all** — `usdc` on Arbitrum → both addresses (same as #3 via CI path).
5. **Cross-chain isolation** — symbol present only on chain B does not resolve for chain A.
6. **Cross-token NOT recovered** — `USDT` does **not** resolve to `USDC`-only market (guards against accidental fuzzy behavior). This is implicitly tested by the equivalence group tests — only declared group members resolve.
7. **Equivalence group — USDT → USD₮0** — LLM returns `USDT` on chain 42161 (has `USD₮0`, no `USDT`) → resolves to `USD₮0` address.
8. **Equivalence group — USD₮0 → USDT** — bidirectional: LLM returns `USD₮0` on chain 1 (has `USDT`, no `USD₮0`) → resolves to `USDT` address.
9. **Equivalence group — USD₮ → USDT** — LLM returns `USD₮` on chain 1 → resolves to `USDT`.
10. **Equivalence group — no member on chain** — LLM returns `USDT` on chain 999 (no group member exists) → empty array.
11. **Miss** — unknown symbol `UNKNOWN` → empty array.
12. **Equivalence group + CI compose** — LLM returns `usdt` (lowercase) on chain 42161 → CI matches nothing (market has `USD₮0`, lowercase `usd₮0` ≠ `usdt`), equiv group matches `USD₮0` → resolves.

### Integration tests (`detectNetPositionConstraint.test.ts`)

13. **LLM returns case-variant offset** → constraint now resolved (previously null). E.g. LLM returns `usde`, market has `USDe`.
14. **LLM returns Unicode-variant offset** → constraint resolved via equiv group. E.g. LLM returns `USDT` on a chain with `USD₮0`.
15. **LLM returns unknown symbol** → A2 skip: constraint still built with other resolved offsets (not null). `logger.warn` emitted (not unit-tested — verified via staging logs).
16. **LLM returns all unknown symbols** → constraint returns `{ sourceSide, offsetReserveIds: [oppReserveId] }` (self only).
17. **Self reserveId explicit add** — LLM returns `['USDe']` (omits source token `GHO`) → `offsetReserveIds` includes both `oppReserveId` (GHO) and USDe reserveId.
18. **Self reserveId idempotent** — LLM returns `['GHO', 'USDe']` (includes source) → `offsetReserveIds` has GHO once (not duplicated).

Run: `npm run build -w @internal/aave-fetcher` then `npx --no-install tsx --test packages/aave-fetcher/tests/<file>.test.ts`.

## Rollout / Risks

- **High-risk area** (Merkl net-position, per AGENTS). Change is additive and conservative: over-inclusion is safe (Verified Fact #7), worst case matches today's behavior (drop to null) when all symbols fail.
- **No payload/schema change** → no frontend/backend type coupling.
- **Observability**: the new `warn` logs let us measure real rejection rate in dev/staging. Verify against live data after deploy.
- **Equivalence group** is the only place that could introduce a wrong offset — kept minimal (1 group, 3 members), per-entry tested, pairwise non-co-chain verified.
- **Forward-looking**: current production data rarely exercises LLM path (L0 captures 100% of NET opps). This change is a defense for future cases where LLM path is reached.

## Notation

- Market symbols use their actual Unicode form: `USD₮0` (₮ = U+20AE), `USD₮`, `USDt`.
- LLM ASCII outputs are quoted strings: `'USDT0'`, `'USDT'`.
- The original spec draft used `USDT0` to refer to both the market symbol and the LLM output — this was incorrect (the market symbol is `USD₮0`, not `USDT0`).
