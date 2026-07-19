import { chainSymbolKey } from "@internal/aave-shared-contracts";
import type { RuntimeReserveData } from "@internal/aave-shared-contracts";

/**
 * Symbol equivalence groups for Unicode ↔ ASCII normalization.
 *
 * Each group contains token symbols that are semantically equivalent but differ
 * only by Unicode rendering (e.g. ₮ U+20AE vs ASCII T). Case differences
 * (USDT vs USDt) are handled by the case-insensitive strategy, not here.
 *
 * Safety requirement: group members must be **pairwise non-co-chain** — on any
 * given chain, at most one group member exists in market reserves. This
 * guarantees unambiguous resolution. Offset resolution is chain-scoped
 * (opp.chainId locked), so cross-chain aliasing cannot occur.
 *
 * See ADR-0036 for design rationale.
 */
export const SYMBOL_EQUIV_GROUPS: string[][] = [["USDT", "USD₮0", "USD₮"]];

/**
 * Build a reverse lookup: each symbol → set of OTHER group members.
 * Used by resolveOffsetSymbolAddress for bidirectional normalization.
 */
export function buildEquivLookup(): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();
  for (const group of SYMBOL_EQUIV_GROUPS) {
    for (const member of group) {
      const others = new Set<string>(group.filter((m) => m !== member));
      lookup.set(member, others);
      // Also register lowercase key so case-variant LLM output (e.g. 'usdt')
      // can find the group. The returned members keep original casing —
      // Strategy 1/2 lookups handle case normalization downstream.
      const lower = member.toLowerCase();
      if (lower !== member) {
        lookup.set(lower, others);
      }
    }
  }
  return lookup;
}

/**
 * Build a case-insensitive symbol → address[] lookup from market reserves.
 *
 * Unlike `symbolLookup` (first-write-wins), this collects ALL addresses for a
 * given `chainId:lower(symbol)`. This is safe because downstream net-position
 * consumption is conservative for over-inclusion (offset reserve with no user
 * position → contributes 0).
 */
export function buildSymbolLookupCI(
  reserves: Pick<
    RuntimeReserveData,
    "chainId" | "tokenSymbol" | "tokenAddress"
  >[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of reserves) {
    const key = chainSymbolKey(r.chainId, r.tokenSymbol.toLowerCase());
    const addr = r.tokenAddress.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      if (!existing.includes(addr)) {
        existing.push(addr);
      }
    } else {
      map.set(key, [addr]);
    }
  }
  return map;
}

/**
 * Resolve an LLM-provided offset symbol to a set of market token addresses on
 * a given chain, via three ordered strategies. All matches are unioned.
 *
 * 1. Exact match (symbolLookup, first-write-wins)
 * 2. Case-insensitive match (symbolLookupCI, returns all)
 * 3. Equivalence group (tries other group members via strategies 1 + 2)
 *
 * Returns empty array if unresolvable — caller should logger.warn + skip.
 * Over-inclusion is safe (downstream net-position is conservative).
 *
 * See ADR-0036 for design rationale.
 */
export function resolveOffsetSymbolAddress(
  chainId: number,
  symbol: string,
  symbolLookup: Map<string, string>,
  symbolLookupCI: Map<string, string[]>,
  equivLookup: Map<string, Set<string>>
): string[] {
  const addrs = new Set<string>();

  // Strategy 1: exact match
  const exact = symbolLookup.get(chainSymbolKey(chainId, symbol));
  if (exact) addrs.add(exact);

  // Strategy 2: case-insensitive (returns all addresses for this lowercase key)
  const ciAddrs = symbolLookupCI.get(
    chainSymbolKey(chainId, symbol.toLowerCase())
  );
  if (ciAddrs) {
    for (const a of ciAddrs) addrs.add(a);
  }

  // Strategy 3: equivalence group (Unicode ↔ ASCII variants)
  const group = equivLookup.get(symbol);
  if (group) {
    for (const member of group) {
      // Try exact for this group member
      const mExact = symbolLookup.get(chainSymbolKey(chainId, member));
      if (mExact) addrs.add(mExact);
      // Try CI for this group member
      const mCi = symbolLookupCI.get(
        chainSymbolKey(chainId, member.toLowerCase())
      );
      if (mCi) {
        for (const a of mCi) addrs.add(a);
      }
    }
  }

  return [...addrs];
}
