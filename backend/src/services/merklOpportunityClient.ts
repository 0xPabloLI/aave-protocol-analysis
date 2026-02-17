const MERKL_BASE_URL = 'https://api.merkl.xyz/v4';
const DEFAULT_ITEMS_PER_PAGE = 100;
const MAX_ITEMS_PER_PAGE = 100;

type QueryPrimitive = string | number | boolean;

const buildQuery = (query: Record<string, QueryPrimitive | undefined>): string => {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
  });
  return params.toString();
};

const clampItemsPerPage = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_ITEMS_PER_PAGE;
  const rounded = Math.floor(value as number);
  if (rounded < 1) return 1;
  if (rounded > MAX_ITEMS_PER_PAGE) return MAX_ITEMS_PER_PAGE;
  return rounded;
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Merkl API ${response.status} for ${url}`);
  }
  return response.json() as Promise<unknown>;
};

export interface FetchMerklOpportunitiesOptions {
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
}

export const fetchMerklOpportunities = async (
  options: FetchMerklOpportunitiesOptions = {}
): Promise<unknown[]> => {
  const items = clampItemsPerPage(options.itemsPerPage);
  const pageQueryBase: Record<string, QueryPrimitive | undefined> = {
    mainProtocolId: options.mainProtocolId,
    status: options.status,
    campaigns: options.campaigns,
    distributionTypes: options.distributionTypes,
    items,
  };
  const aggregated: unknown[] = [];
  for (let page = 0; ; page += 1) {
    const pageQuery = buildQuery({
      ...pageQueryBase,
      page,
    });
    const url = `${MERKL_BASE_URL}/opportunities?${pageQuery}`;
    const payload = await fetchJson(url).catch(() => null);
    if (!Array.isArray(payload)) break;
    const itemsInPage = Array.isArray(payload) ? payload : [];
    aggregated.push(...itemsInPage);
    if (itemsInPage.length < items) {
      break;
    }
  }
  return aggregated;
};
