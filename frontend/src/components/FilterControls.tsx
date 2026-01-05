import { useState, useEffect } from 'react';
import { marketsApi } from '../services/api.js';
import type { FilterOptions, TokenCategory } from '../types/index.js';

interface FilterControlsProps {
  filters: FilterOptions;
  onFiltersChange: (filters: FilterOptions) => void;
}

// Map Ethereum market names to display names
const ETHEREUM_MARKET_MAP: Record<string, string> = {
  'AaveV3Ethereum': 'Core',
  'AaveV3EthereumLido': 'Prime',
  'AaveV3EthereumHorizon': 'Horizon RWA',
  'AaveV3EthereumEtherFi': 'EtherFi',
};

const TOKEN_CATEGORIES: { value: TokenCategory; label: string }[] = [
  { value: 'stablecoin', label: 'Stablecoin' },
  { value: 'eth-related', label: 'ETH Related' },
  { value: 'btc-related', label: 'BTC Related' },
  { value: 'pendle', label: 'Pendle' },
];

export function FilterControls({ filters, onFiltersChange }: FilterControlsProps) {
  const [markets, setMarkets] = useState<Array<{ key: string; label: string; chain: string }>>([]);
  const [selectedMarkets, setSelectedMarkets] = useState<string[]>(filters.market || []);
  const [tokenSearch, setTokenSearch] = useState(filters.token || '');
  const [selectedTokenCategories, setSelectedTokenCategories] = useState<TokenCategory[]>(
    filters.tokenCategory || []
  );

  // Sync state with filters prop
  useEffect(() => {
    setSelectedMarkets(filters.market || []);
  }, [filters.market]);

  useEffect(() => {
    setTokenSearch(filters.token || '');
  }, [filters.token]);

  useEffect(() => {
    setSelectedTokenCategories(filters.tokenCategory || []);
  }, [filters.tokenCategory]);

  useEffect(() => {
    // Fetch markets from API
    marketsApi.getMarketsList().then((marketsData) => {
      // Build markets list
      const marketsList: Array<{ key: string; label: string; chain: string }> = [];
      
      marketsData.forEach(({ marketName, chainName }) => {
        if (chainName.toLowerCase() === 'ethereum' && ETHEREUM_MARKET_MAP[marketName]) {
          // Map Ethereum markets to display names
          marketsList.push({
            key: `${marketName}-${chainName}`,
            label: ETHEREUM_MARKET_MAP[marketName],
            chain: chainName,
          });
        } else {
          // For other chains, use chain name as market label
          marketsList.push({
            key: `${marketName}-${chainName}`,
            label: chainName,
            chain: chainName,
          });
        }
      });
      
      // Remove duplicates
      const uniqueMarkets = marketsList.filter((market, index, self) =>
        index === self.findIndex(m => m.key === market.key)
      );
      
      setMarkets(uniqueMarkets);
    });
  }, []);

  const handleMarketToggle = (marketKey: string) => {
    const newSelected = selectedMarkets.includes(marketKey)
      ? selectedMarkets.filter(m => m !== marketKey)
      : [...selectedMarkets, marketKey];
    setSelectedMarkets(newSelected);
    onFiltersChange({ ...filters, market: newSelected.length > 0 ? newSelected : undefined });
  };

  const handleTokenSearch = (value: string) => {
    setTokenSearch(value);
    onFiltersChange({ ...filters, token: value || undefined });
  };

  const handleTokenCategoryToggle = (category: TokenCategory) => {
    const newSelected = selectedTokenCategories.includes(category)
      ? selectedTokenCategories.filter(c => c !== category)
      : [...selectedTokenCategories, category];
    setSelectedTokenCategories(newSelected);
    onFiltersChange({ ...filters, tokenCategory: newSelected.length > 0 ? newSelected : undefined });
  };

  // Group markets by chain
  const marketsByChain = markets.reduce((acc, market) => {
    if (!acc[market.chain]) {
      acc[market.chain] = [];
    }
    acc[market.chain].push(market);
    return acc;
  }, {} as Record<string, typeof markets>);

  return (
    <div className="space-y-4">
      {/* Market Filter */}
      <div className="card-elevated p-6">
        <label className="block text-sm font-bold mb-4 text-gray-800">
          市场筛选
        </label>
        <div className="space-y-3">
          {Object.entries(marketsByChain).map(([chain, chainMarkets]) => (
            <div key={chain}>
              <div className="flex flex-wrap gap-2">
                {chainMarkets.map((market) => (
                  <button
                    key={market.key}
                    onClick={() => handleMarketToggle(market.key)}
                    className={`btn-filter ${
                      selectedMarkets.includes(market.key)
                        ? 'btn-filter-active'
                        : 'btn-filter-inactive'
                    }`}
                  >
                    {market.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Filter */}
      <div className="card-elevated p-6">
        <label className="block text-sm font-bold mb-4 text-gray-800">
          代币筛选
        </label>
        <div className="flex flex-wrap gap-2 mb-4">
          {TOKEN_CATEGORIES.map((category) => (
            <button
              key={category.value}
              onClick={() => handleTokenCategoryToggle(category.value)}
              className={`btn-filter ${
                selectedTokenCategories.includes(category.value)
                  ? 'btn-filter-active'
                  : 'btn-filter-inactive'
              }`}
            >
              {category.label}
            </button>
          ))}
        </div>
        
        {/* Token Search */}
        <div>
          <label className="block text-sm font-semibold mb-2 text-gray-700">
            代币搜索
          </label>
          <input
            type="text"
            value={tokenSearch}
            onChange={(e) => handleTokenSearch(e.target.value)}
            placeholder="输入代币符号或名称..."
            className="w-full max-w-md px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200"
          />
        </div>
      </div>
    </div>
  );
}
