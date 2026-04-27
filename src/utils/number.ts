/**
 * Safely converts an unknown value to a finite number.
 * Returns null for null, undefined, NaN, Infinity, or non-numeric values.
 * Supports BigDecimal objects by converting via String() first.
 * Supports nested objects with .value property (common Aave SDK pattern).
 */
export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    // Support BigDecimal: String(bd) → numeric string (most reliable conversion)
    // This handles V4 SDK's BigDecimal type where String() returns the numeric value
    const str = String(value);
    if (str && str !== '[object Object]') {
      const parsed = parseFloat(str);
      if (Number.isFinite(parsed)) return parsed;
    }
    // Fallback: try .value property (common Aave client pattern: { value: string })
    const maybeValue = (value as { value?: unknown }).value;
    if (maybeValue !== undefined) {
      return toFiniteNumber(maybeValue);
    }
  }
  return null;
}
