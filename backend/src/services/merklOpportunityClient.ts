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

const fetchCount = async (query: Record<string, QueryPrimitive | undefined>): Promise<number | null> => {
  const countQuery = buildQuery(query);
  const url = `${MERKL_BASE_URL}/opportunities/count${countQuery ? `?${countQuery}` : ''}`;
  try {
    const value = await fetchJson(url);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    }
    return null;
  } catch {
    return null;
  }
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
  const baseQuery: Record<string, QueryPrimitive | undefined> = {
    mainProtocolId: options.mainProtocolId,
    status: options.status,
    campaigns: options.campaigns,
    distributionTypes: options.distributionTypes,
    items,
  };

  const totalCount = await fetchCount(baseQuery);
  const totalPages = totalCount === null ? 1 : Math.max(Math.ceil(totalCount / items), 1);

  const pageRequests = Array.from({ length: totalPages }, (_, page) => {
    const pageQuery = buildQuery({
      ...baseQuery,
      page,
    });
    const url = `${MERKL_BASE_URL}/opportunities?${pageQuery}`;
    return fetchJson(url)
      .then((payload) => (Array.isArray(payload) ? payload : []))
      .catch(() => []);
  });

  const pages = await Promise.all(pageRequests);
  return pages.flat();
};
