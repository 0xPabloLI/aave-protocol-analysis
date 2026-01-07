'use client'

import { useState, useEffect } from 'react';
import type { SortField, SortOrder } from '@/types';
import { FilterControls } from './FilterControls';
import { LoadingSpinner } from './LoadingSpinner';
import { useMarkets } from '@/hooks/useMarkets';
import { marketsApi } from '@/services/api';
import type { FilterOptions } from '@/types';

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
  }, [lastUpdated]);

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
    if (sortField !== field) return 'text-aave-text-muted';
    return 'text-aave-cyan';
  };

  if (loading && data.length === 0) {
    return (
      <div className="min-h-screen bg-aave-bg-primary flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-aave-bg-primary flex items-center justify-center p-4">
        <div className="aave-card p-8 text-center max-w-2xl">
          <div className="text-aave-error text-xl font-semibold mb-4">⚠️ 连接错误</div>
          <div className="text-aave-text-secondary mb-4 whitespace-pre-line text-left">
            {error.message}
          </div>
          <div className="mt-6 p-4 bg-aave-bg-tertiary rounded-lg text-left text-sm">
            <div className="font-semibold mb-2 text-aave-text-primary">排查步骤：</div>
            <ol className="list-decimal list-inside space-y-1 text-aave-text-secondary">
              <li>检查浏览器控制台（F12）查看详细错误信息</li>
              <li>确认环境变量 <code className="bg-aave-bg-secondary px-1 rounded text-aave-cyan">NEXT_PUBLIC_API_URL</code> 已正确配置（默认使用 https://api.aaveapy.com/api）</li>
              <li>确认远程 API 服务可访问</li>
              <li>检查是否存在 CORS 或网络连接问题</li>
            </ol>
          </div>
          <div className="mt-4 text-xs text-aave-text-muted">
            API URL: {process.env.NEXT_PUBLIC_API_URL || '未配置（使用默认值）'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-aave-bg-primary">
      {/* 背景装饰 */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-aave-purple/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-aave-cyan/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6 mb-6">
            <div>
              <h1 className="text-4xl font-bold text-aave-text-primary mb-2 tracking-tight">
                <span className="aave-gradient-text">Aave</span> Markets Dashboard
              </h1>
              <p className="text-aave-text-secondary text-sm">实时市场数据和分析</p>
            </div>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {/* APY/APR Toggle */}
              <div className="aave-card px-6 py-3 flex items-center gap-4">
                <span className={`text-sm font-semibold transition-colors ${
                  apyAprMode === 'apy' ? 'text-aave-cyan' : 'text-aave-text-muted'
                }`}>
                  APY
                </span>
                <button
                  onClick={() => setApyAprMode(apyAprMode === 'apy' ? 'apr' : 'apy')}
                  className={`aave-toggle ${
                    apyAprMode === 'apr' ? 'aave-toggle-active' : ''
                  }`}
                  aria-label="Toggle APY/APR"
                >
                  <span className="aave-toggle-knob" style={{
                    transform: apyAprMode === 'apr' ? 'translateX(28px)' : 'translateX(0)'
                  }} />
                </button>
                <span className={`text-sm font-semibold transition-colors ${
                  apyAprMode === 'apr' ? 'text-aave-cyan' : 'text-aave-text-muted'
                }`}>
                  APR
                </span>
              </div>
              {/* Last Updated */}
              {lastUpdated && (
                <div className="aave-card px-6 py-3">
                  <div className="text-xs text-aave-text-muted mb-1">最后更新</div>
                  <div className="text-sm font-semibold text-aave-text-primary">
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
          <div className="stat-card">
            <div className="text-sm font-medium text-aave-text-secondary mb-1">总市场数</div>
            <div className="text-3xl font-bold text-aave-text-primary">{data.length}</div>
          </div>
          <div className="stat-card">
            <div className="text-sm font-medium text-aave-text-secondary mb-1">平均 Supply APY</div>
            <div className="text-3xl font-bold text-aave-success">
              {data.length > 0 ? (data.reduce((sum, item) => sum + (item.totalSupplyApy * 100), 0) / data.length).toFixed(2) : '0.00'}%
            </div>
          </div>
          <div className="stat-card">
            <div className="text-sm font-medium text-aave-text-secondary mb-1">平均 Borrow APY</div>
            <div className="text-3xl font-bold text-aave-cyan">
              {data.length > 0 ? (data.filter(item => item.totalBorrowApy !== null).reduce((sum, item) => sum + ((item.totalBorrowApy || 0) * 100), 0) / data.filter(item => item.totalBorrowApy !== null).length || 0).toFixed(2) : '0.00'}%
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="aave-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="aave-table">
              <thead className="aave-table-header">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-aave-text-secondary uppercase tracking-wider">
                    代币
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-aave-text-secondary uppercase tracking-wider">
                    市场
                  </th>
                  <th
                    className="px-6 py-4 text-left text-xs font-semibold text-aave-text-secondary uppercase tracking-wider cursor-pointer hover:bg-aave-surface-hover transition-colors"
                    onClick={() => handleSort('totalSupplyApy')}
                  >
                    <div className="flex items-center gap-2">
                      Total Supply {apyAprMode.toUpperCase()}
                      <span className={getSortClass('totalSupplyApy')}>{getSortIcon('totalSupplyApy')}</span>
                    </div>
                  </th>
                  <th
                    className="px-6 py-4 text-left text-xs font-semibold text-aave-text-secondary uppercase tracking-wider cursor-pointer hover:bg-aave-surface-hover transition-colors"
                    onClick={() => handleSort('totalBorrowApy')}
                  >
                    <div className="flex items-center gap-2">
                      Total Borrow {apyAprMode.toUpperCase()}
                      <span className={getSortClass('totalBorrowApy')}>{getSortIcon('totalBorrowApy')}</span>
                    </div>
                  </th>
                  <th
                    className="px-6 py-4 text-left text-xs font-semibold text-aave-text-secondary uppercase tracking-wider cursor-pointer hover:bg-aave-surface-hover transition-colors"
                    onClick={() => handleSort('apySpread')}
                  >
                    <div className="flex items-center gap-2">
                      {apyAprMode.toUpperCase()} Spread
                      <span className={getSortClass('apySpread')}>{getSortIcon('apySpread')}</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((item, index) => {
                  const spreadValue = item.apySpread !== null ? item.apySpread * 100 : null;
                  const isNegativeSpread = spreadValue !== null && spreadValue < 0;

                  return (
                    <tr key={index} className="aave-table-row">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-bold text-aave-text-primary text-base">{item.tokenSymbol}</div>
                        <div className="text-sm text-aave-text-muted mt-0.5">{item.tokenName}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="aave-badge">
                          {getMarketDisplayName(item.marketName, item.chainName)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-bold text-aave-success text-base">
                          {formatPercent(item.totalSupplyApy)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {item.totalBorrowApy !== null ? (
                          <span className="font-bold text-aave-cyan text-base">
                            {formatPercent(item.totalBorrowApy)}
                          </span>
                        ) : (
                          <span className="text-aave-text-muted">-</span>
                        )}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap font-bold text-base ${
                        isNegativeSpread ? 'text-aave-warning' : 'text-aave-success'
                      }`}>
                        {spreadValue !== null ? (
                          <span>
                            {spreadValue > 0 ? '+' : ''}{spreadValue.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-aave-text-muted">-</span>
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
          <div className="aave-card mt-6 text-center py-12">
            <svg className="mx-auto h-12 w-12 text-aave-text-muted mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg text-aave-text-primary font-semibold mb-2">没有找到匹配的市场</p>
            <p className="text-sm text-aave-text-secondary">尝试调整筛选条件</p>
          </div>
        )}
      </div>
    </div>
  );
}

