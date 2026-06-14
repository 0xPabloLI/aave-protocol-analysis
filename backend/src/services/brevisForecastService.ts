const BREVIS_FORECAST_STALE_TIME_MS = 60_000;

export interface BrevisForecastItem {
  campaignId: string;
  distributedSoFarUsd: number;
}

export interface BrevisForecastSnapshot {
  items: BrevisForecastItem[];
  staleTimeMs: number;
}

let entries: Map<string, number | undefined> = new Map();

export function setBrevisForecastEntries(newEntries: Map<string, number | undefined>): void {
  entries = newEntries;
}

export function getBrevisForecastSnapshot(): BrevisForecastSnapshot {
  const items: BrevisForecastItem[] = [];
  for (const [campaignId, value] of entries) {
    if (value !== undefined) {
      items.push({ campaignId, distributedSoFarUsd: value });
    }
  }
  return { items, staleTimeMs: BREVIS_FORECAST_STALE_TIME_MS };
}

export function __resetBrevisForecastForTests(): void {
  entries = new Map();
}
