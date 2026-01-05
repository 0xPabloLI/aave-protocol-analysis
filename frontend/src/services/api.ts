import axios from 'axios';
import type { MarketsResponse, MarketsStats } from '../types/index.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

export const marketsApi = {
  /**
   * 获取市场数据
   */
  async getMarkets(params?: {
    sort?: string;
    order?: 'asc' | 'desc';
    chain?: string;
    market?: string;
    token?: string;
    minSupplyApy?: number;
    maxBorrowApy?: number;
  }): Promise<MarketsResponse> {
    const response = await apiClient.get<MarketsResponse>('/markets', { params });
    return response.data;
  },

  /**
   * 获取统计信息
   */
  async getStats(): Promise<MarketsStats> {
    const response = await apiClient.get<MarketsStats>('/markets/stats');
    return response.data;
  },

  /**
   * 获取链列表
   */
  async getChains(): Promise<string[]> {
    const response = await apiClient.get<string[]>('/markets/chains');
    return response.data;
  },

  /**
   * 获取市场列表
   */
  async getMarketsList(): Promise<Array<{ marketName: string; chainName: string }>> {
    const response = await apiClient.get<Array<{ marketName: string; chainName: string }>>('/markets/list');
    return response.data;
  },

  /**
   * 手动刷新数据
   */
  async refreshMarkets(): Promise<{ status: string; message: string; lastUpdated: string | null }> {
    const response = await apiClient.post('/markets/refresh');
    return response.data;
  },
};
