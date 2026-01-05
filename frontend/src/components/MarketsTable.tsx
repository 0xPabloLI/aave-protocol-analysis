import { useState, useEffect } from 'react';
import type { SortField, SortOrder } from '../types/index.js';
import { FilterControls } from './FilterControls.js';
import { LoadingSpinner } from './LoadingSpinner.js';
import { useMarkets } from '../hooks/useMarkets.js';
import { marketsApi } from '../services/api.js';
import type { FilterOptions } from '../types/index.js';

// Map Ethereum market names to display names
const ETHEREUM_MARKET_MAP: Record<string, string> = {
  'AaveV3Ethereum': 'Core',
  'AaveV3EthereumLido': 'Prime',
  'AaveV3EthereumHorizon': 'Horizon RWA',
  'AaveV3EthereumEtherFi': 'EtherFi',
};

function getMarketDisplayName(marketName: string, chainName: string): string {
  if (chainName.toLowerCase() === 'ethereum' && ETHEREUM_MARKET_MAP[marketName]) {
    return ETHEREUM_MARKET_MAP[marketName];
  }
  return chainName;
}

export function MarketsTable() {
  const [sortField, setSortField] = useState<SortField>('totalSupplyApy');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filters, setFilters] = useState<FilterOptions>({});
  const [apyAprMode, setApyAprMode] = useState<'apy' | 'apr'>('apy');
  const [refreshKey, setRefreshKey] = useState(0);

  const { data, loading, error, lastUpdated } = useMarkets(
    sortField,
    sortOrder,
    filters,
    apyAprMode,
    refreshKey
  );

  // 每30秒自动刷新数据（先触发后端刷新，等待完成后再获取数据）
  useEffect(() => {
    const refreshData = async () => {
      try {
        // 先触发后端刷新
        await marketsApi.refreshMarkets();
        // 等待后端更新完成（最多等待10秒）
        let retries = 0;
        const maxRetries = 20; // 20次 * 500ms = 10秒
        
        const waitForUpdate = async () => {
          const initialTime = lastUpdated;
          while (retries < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const response = await marketsApi.getMarkets();
            // 检查数据是否已更新（通过比较时间戳）
            if (response.lastUpdated && (!initialTime || new Date(response.lastUpdated) > new Date(initialTime))) {
              // 数据已更新，更新 refreshKey 来触发前端数据获取
              setRefreshKey(prev => prev + 1);
              return;
            }
            retries++;
          }
          // 超时后也更新 refreshKey 来获取当前数据
          setRefreshKey(prev => prev + 1);
        };
        
        await waitForUpdate();
      } catch (error) {
        console.error('Failed to refresh data:', error);
        // 即使刷新失败，也更新 refreshKey 来获取当前数据
        setRefreshKey(prev => prev + 1);
      }
    };

    // 立即执行一次
    refreshData();

    // 然后每30秒执行一次
    const interval = setInterval(refreshData, 30000);

    return () => clearInterval(interval);
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortOrder === 'asc') {
        setSortOrder('desc');
      } else if (sortOrder === 'desc') {
        setSortField(null);
        setSortOrder('desc');
      }
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const formatPercent = (value: number | null): string => {
    if (value === null) return '-';
    const percent = value * 100;
    return `${percent.toFixed(2)}%`;
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return '⇅';
    }
    return sortOrder === 'asc' ? '↑' : '↓';
  };

  const getSortClass = (field: SortField) => {
    if (sortField !== field) return 'text-gray-400';
    return 'text-blue-600';
  };

  if (loading && data.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="card-elevated p-8 text-center max-w-md">
          <div className="text-red-600 text-xl font-semibold mb-2">Error</div>
          <div className="text-gray-600">{error.message}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6 mb-6">
            <div>
              <h1 className="text-4xl font-bold text-gray-900 mb-2 tracking-tight">
                Aave Markets Dashboard
              </h1>
              <p className="text-gray-600 text-sm">实时市场数据和分析</p>
            </div>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {/* APY/APR Toggle */}
              <div className="card-elevated px-6 py-3 flex items-center gap-4">
                <span className={`text-sm font-semibold transition-colors ${
                  apyAprMode === 'apy' ? 'text-blue-600' : 'text-gray-400'
                }`}>
                  APY
                </span>
                <button
                  onClick={() => setApyAprMode(apyAprMode === 'apy' ? 'apr' : 'apy')}
                  className={`relative inline-flex h-8 w-14 items-center rounded-full transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    apyAprMode === 'apr' ? 'bg-blue-600' : 'bg-gray-300'
                  }`}
                  aria-label="Toggle APY/APR"
                >
                  <span
                    className={`inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-300 ${
                      apyAprMode === 'apr' ? 'translate-x-7' : 'translate-x-1'
                    }`}
                  />
                </button>
                <span className={`text-sm font-semibold transition-colors ${
                  apyAprMode === 'apr' ? 'text-blue-600' : 'text-gray-400'
                }`}>
                  APR
                </span>
              </div>
              {/* Last Updated */}
              {lastUpdated && (
                <div className="card-elevated px-6 py-3">
                  <div className="text-xs text-gray-500 mb-1">最后更新</div>
                  <div className="text-sm font-semibold text-gray-900">
                    {new Date(lastUpdated).toLocaleString('zh-CN', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      timeZoneName: 'short'
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6">
          <FilterControls filters={filters} onFiltersChange={setFilters} />
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="card-elevated p-6">
            <div className="text-sm font-medium text-gray-600 mb-1">总市场数</div>
            <div className="text-3xl font-bold text-gray-900">{data.length}</div>
          </div>
          <div className="card-elevated p-6">
            <div className="text-sm font-medium text-gray-600 mb-1">平均 Supply APY</div>
            <div className="text-3xl font-bold text-green-600">
              {data.length > 0 ? (data.reduce((sum, item) => sum + (item.totalSupplyApy * 100), 0) / data.length).toFixed(2) : '0.00'}%
            </div>
          </div>
          <div className="card-elevated p-6">
            <div className="text-sm font-medium text-gray-600 mb-1">平均 Borrow APY</div>
            <div className="text-3xl font-bold text-blue-600">
              {data.length > 0 ? (data.filter(item => item.totalBorrowApy !== null).reduce((sum, item) => sum + ((item.totalBorrowApy || 0) * 100), 0) / data.filter(item => item.totalBorrowApy !== null).length || 0).toFixed(2) : '0.00'}%
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="card-elevated overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="table-header">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                    代币
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                    市场
                  </th>
                  <th 
                    className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort('totalSupplyApy')}
                  >
                    <div className="flex items-center gap-2">
                      Total Supply {apyAprMode.toUpperCase()}
                      <span className={getSortClass('totalSupplyApy')}>{getSortIcon('totalSupplyApy')}</span>
                    </div>
                  </th>
                  <th 
                    className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort('totalBorrowApy')}
                  >
                    <div className="flex items-center gap-2">
                      Total Borrow {apyAprMode.toUpperCase()}
                      <span className={getSortClass('totalBorrowApy')}>{getSortIcon('totalBorrowApy')}</span>
                    </div>
                  </th>
                  <th 
                    className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort('apySpread')}
                  >
                    <div className="flex items-center gap-2">
                      {apyAprMode.toUpperCase()} Spread
                      <span className={getSortClass('apySpread')}>{getSortIcon('apySpread')}</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.map((item, index) => {
                  const spreadValue = item.apySpread !== null ? item.apySpread * 100 : null;
                  const isNegativeSpread = spreadValue !== null && spreadValue < 0;
                  
                  return (
                    <tr key={index} className="table-row">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-bold text-gray-900 text-base">{item.tokenSymbol}</div>
                        <div className="text-sm text-gray-500 mt-0.5">{item.tokenName}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-200">
                          {getMarketDisplayName(item.marketName, item.chainName)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-bold text-green-600 text-base">
                          {formatPercent(item.totalSupplyApy)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {item.totalBorrowApy !== null ? (
                          <span className="font-bold text-blue-600 text-base">
                            {formatPercent(item.totalBorrowApy)}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap font-bold text-base ${
                        isNegativeSpread ? 'text-orange-600' : 'text-green-600'
                      }`}>
                        {spreadValue !== null ? (
                          <span>
                            {spreadValue > 0 ? '+' : ''}{spreadValue.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {data.length === 0 && !loading && (
          <div className="card-elevated mt-6 text-center py-12">
            <svg className="mx-auto h-12 w-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg text-gray-700 font-semibold mb-2">没有找到匹配的市场</p>
            <p className="text-sm text-gray-500">尝试调整筛选条件</p>
          </div>
        )}
      </div>
    </div>
  );
}
