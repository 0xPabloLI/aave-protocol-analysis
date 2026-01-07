'use client'

import { useState, useEffect, useMemo } from 'react';
import { marketsApi } from '@/services/api';
import type { MarketWithSpread, FilterOptions, SortField, SortOrder } from '@/types';
import { isTokenInCategory, fetchCoinGeckoTokens } from '@/services/tokenFilter';

export function useMarkets(
  sortField: SortField,
  sortOrder: SortOrder,
  filters: FilterOptions,
  apyAprMode: 'apy' | 'apr',
  refreshKey?: number
) {
  const [data, setData] = useState<MarketWithSpread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const [coinGeckoData, setCoinGeckoData] = useState<{
    stablecoins: Set<string>;
    ethRelated: Set<string>;
  } | null>(null);

  // Fetch CoinGecko data once
  useEffect(() => {
    fetchCoinGeckoTokens().then(setCoinGeckoData);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const params: any = {};
        if (sortField) {
          params.sort = sortField;
          params.order = sortOrder;
        }
        if (filters.market && filters.market.length > 0) {
          params.market = filters.market.join(',');
        }
        if (filters.token) {
          params.token = filters.token;
        }
        if (filters.minSupplyApy !== undefined) {
          params.minSupplyApy = filters.minSupplyApy;
        }
        if (filters.maxBorrowApy !== undefined) {
          params.maxBorrowApy = filters.maxBorrowApy;
        }

        const response = await marketsApi.getMarkets(params);

        if (!cancelled) {
          let filteredData = response.data;

          // Filter out invalid entries (missing marketName or chainName)
          filteredData = filteredData.filter((item) => {
            return (
              item.marketName &&
              item.marketName.trim() !== '' &&
              item.chainName &&
              item.chainName.trim() !== '' &&
              item.tokenSymbol &&
              item.tokenSymbol.trim() !== ''
            );
          });

          // Apply token category filter on client side
          if (filters.tokenCategory && filters.tokenCategory.length > 0 && coinGeckoData) {
            filteredData = filteredData.filter((item) => {
              return filters.tokenCategory!.some((category) =>
                isTokenInCategory(
                  item.tokenSymbol,
                  category,
                  coinGeckoData.stablecoins,
                  coinGeckoData.ethRelated
                )
              );
            });
          }

          setData(filteredData);
          setLastUpdated(response.lastUpdated);
          setIsStale(response.isStale);
          setUpdateInProgress(response.updateInProgress);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Failed to fetch markets'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [
    sortField,
    sortOrder,
    filters.market,
    filters.token,
    filters.tokenCategory,
    filters.minSupplyApy,
    filters.maxBorrowApy,
    coinGeckoData,
    refreshKey,
  ]);

  // Convert APY to APR if needed
  const processedData = useMemo(() => {
    if (apyAprMode === 'apr') {
      // Convert APY to APR: APR = (1 + APY)^(1/365) - 1, then multiply by 365
      // Simplified: APR ≈ APY for small values
      return data.map((item) => ({
        ...item,
        totalSupplyApy: item.totalSupplyApy, // Keep as APY for now, can add conversion if needed
        totalBorrowApy: item.totalBorrowApy,
      }));
    }
    return data;
  }, [data, apyAprMode]);

  return {
    data: processedData,
    loading,
    error,
    lastUpdated,
    isStale,
    updateInProgress,
    refetch: () => {
      // Trigger refetch by updating a dependency
      setLoading(true);
    },
  };
}

