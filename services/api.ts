'use client'

import axios from 'axios';
import type { MarketsResponse, MarketsStats } from '@/types';

// 在 Next.js 中，使用 NEXT_PUBLIC_ 前缀的环境变量
const getApiBaseUrl = () => {
  // 如果明确配置了环境变量，使用环境变量
  if (process.env.NEXT_PUBLIC_API_URL) {
    // 在生产环境中，如果配置的是 HTTP，使用代理路径
    if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_API_URL.startsWith('http://')) {
      return '/api'; // 使用 Next.js 代理
    }
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // 默认使用远程 HTTPS API
  return 'https://api.aaveapy.com/api';
};

const API_BASE_URL = getApiBaseUrl();

// 在浏览器控制台输出 API URL 用于调试（仅在开发环境）
if (process.env.NODE_ENV === 'development') {
  console.log('API Base URL:', API_BASE_URL);
  console.log('Environment variables:', {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NODE_ENV: process.env.NODE_ENV,
  });
}

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

// 添加请求拦截器用于调试
apiClient.interceptors.request.use(
  (config) => {
    if (process.env.NODE_ENV === 'development') {
      console.log('API Request:', config.method?.toUpperCase(), config.url);
    }
    return config;
  },
  (error) => {
    console.error('API Request Error:', error);
    return Promise.reject(error);
  }
);

// 添加响应拦截器用于错误处理
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // 提供更详细的错误信息
    if (error.response) {
      // 服务器返回了错误响应
      console.error('API Error Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: error.config?.url,
        baseURL: error.config?.baseURL,
      });
    } else if (error.request) {
      // 请求已发出但没有收到响应
      console.error('API Request Error (No Response):', {
        message: error.message,
        url: error.config?.url,
        baseURL: error.config?.baseURL,
        code: error.code,
      });
      
      // 提供更友好的错误消息
      if (error.code === 'ECONNABORTED') {
        error.message = '请求超时，请检查网络连接或 API 服务器是否正常运行';
      } else if (error.code === 'ERR_NETWORK' || error.message.includes('Network Error')) {
        error.message = `无法连接到 API 服务器。请检查：
1. API URL 是否正确配置: ${API_BASE_URL}
2. 后端服务是否正在运行
3. 是否存在 CORS 问题
4. 网络连接是否正常`;
      }
    } else {
      // 设置请求时出错
      console.error('API Error:', error.message);
    }
    return Promise.reject(error);
  }
);

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

