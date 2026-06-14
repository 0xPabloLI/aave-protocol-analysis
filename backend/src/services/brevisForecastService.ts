import type { RuntimeReserveData } from './marketsService.js';
import type { ForecastResponseItem } from '../controllers/merklForecastController.js';

interface BrevisForecastEntry {
  distributedSoFar: number | undefined;
}

let entries: Map<string, BrevisForecastEntry> = new Map();

export function setBrevisForecastEntries(newEntries: Map<string, number | undefined>): void {
  const mapped = new Map<string, BrevisForecastEntry>();
  for (const [campaignId, value] of newEntries) {
    mapped.set(campaignId, { distributedSoFar: value });
  }
  entries = mapped;
}

function collectBrevisCampaignEndTimestamps(markets: RuntimeReserveData[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const market of markets) {
    for (const group of [...(market.brevisSupplys ?? []), ...(market.brevisBorrows ?? [])]) {
      for (const bd of group.breakdowns) {
        const id = bd.campaignId?.trim();
        if (id && bd.campaignEndedAt) {
          const ts = Math.floor(new Date(bd.campaignEndedAt).getTime() / 1000);
          if (Number.isFinite(ts) && ts > 0) {
            map.set(id, ts);
          }
        }
      }
    }
  }
  return map;
}

export function getBrevisForecastItems(markets: RuntimeReserveData[]): ForecastResponseItem[] {
  if (entries.size === 0) return [];

  const endTimestamps = collectBrevisCampaignEndTimestamps(markets);
  const items: ForecastResponseItem[] = [];

  for (const [campaignId, entry] of entries) {
    if (entry.distributedSoFar === undefined) continue;
    const endTimestamp = endTimestamps.get(campaignId);
    items.push({
      campaignId,
      distributedSoFar: entry.distributedSoFar,
      ...(endTimestamp !== undefined && { endTimestamp }),
    });
  }

  return items;
}

export function __resetBrevisForecastForTests(): void {
  entries = new Map();
}
