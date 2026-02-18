const DEFAULT_ITEMS_PER_PAGE = 100;
const MAX_ITEMS_PER_PAGE = 100;

const clampItemsPerPage = (value) => {
  if (!Number.isFinite(value)) return DEFAULT_ITEMS_PER_PAGE;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > MAX_ITEMS_PER_PAGE) return MAX_ITEMS_PER_PAGE;
  return rounded;
};

const buildQuery = (query) => {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
  });
  return params;
};

const fetchJson = async ({ fetchImpl, url }) => {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Merkl API ${response.status} for ${url}`);
  }
  return response.json();
};

export const fetchMerklOpportunitiesShortPage = async ({
  baseUrl = 'https://api.merkl.xyz/v4',
  mainProtocolId,
  status,
  campaigns,
  distributionTypes,
  itemsPerPage,
  fetchImpl = fetch,
}) => {
  const items = clampItemsPerPage(itemsPerPage);
  const baseQuery = {
    mainProtocolId,
    status,
    campaigns,
    distributionTypes,
    items,
  };

  const aggregated = [];
  for (let page = 0; ; page += 1) {
    const query = buildQuery({
      ...baseQuery,
      page,
    });
    const url = `${baseUrl}/opportunities?${query.toString()}`;
    const payload = await fetchJson({ fetchImpl, url }).catch(() => null);
    if (!Array.isArray(payload)) break;
    aggregated.push(...payload);
    if (payload.length < items) {
      break;
    }
  }
  return aggregated;
};
