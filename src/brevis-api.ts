import fetch from 'node-fetch';
import { logger } from './logger.js';

/**
 * Brevis Network Linea Surge API 客户端
 * 
 * 基于逆向工程的结果，可以提取活动的完整数据，包括：
 * - Last Week APR
 * - Last Week Rewards
 * - Last Week Rewards USD
 * - Last Week TVL
 * 
 * API 端点: https://linea-surge-endpoint.brevis.network/LineaSurgeV2Provider/GetActivities
 * 协议: gRPC-Web (application/grpc-web+proto)
 */
export class BrevisApiClient {
  private baseUrl = 'https://linea-surge-endpoint.brevis.network';
  private origin = 'https://linea-ignition.brevis.network';

  // 根据逆向工程确定的字段位置（相对活动描述结束位置）
  private readonly FIELD_OFFSETS = {
    LAST_WEEK_APR: 11,        // double64_le
    LAST_WEEK_REWARDS: 20,    // double64_le
    LAST_WEEK_REWARDS_USD: 29, // double64_le
  };

  /**
   * 获取默认请求头
   */
  private getDefaultHeaders(): Record<string, string> {
    return {
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'cache-control': 'no-cache',
      'content-type': 'application/grpc-web+proto',
      'origin': this.origin,
      'referer': `${this.origin}/`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'x-grpc-web': '1',
      'x-user-agent': 'grpc-web-javascript/0.1',
    };
  }

  /**
   * 编码 gRPC-Web 请求体
   */
  private encodeGrpcWebBody(data?: any): Uint8Array {
    // 空请求体，返回最小的 gRPC-Web 帧
    // gRPC-Web 帧格式: [flags(1 byte)][length(4 bytes)][data]
    const frame = new Uint8Array(5);
    frame[0] = 0; // 标志位：0 = 数据帧
    frame[1] = 0; // 长度 = 0
    frame[2] = 0;
    frame[3] = 0;
    frame[4] = 0;
    return frame;
  }

  /**
   * 解码 gRPC-Web 响应
   */
  private decodeGrpcWebResponse(buffer: ArrayBuffer): any {
    const uint8Array = new Uint8Array(buffer);
    
    if (buffer.byteLength === 0) {
      return {
        success: true,
        data: null,
        message: '响应为空'
      };
    }

    // 解析 gRPC-Web 帧
    const frames: any[] = [];
    let offset = 0;

    while (offset < buffer.byteLength) {
      if (offset + 5 > buffer.byteLength) break;

      const flags = uint8Array[offset];
      const length = (uint8Array[offset + 1] << 24) | 
                    (uint8Array[offset + 2] << 16) | 
                    (uint8Array[offset + 3] << 8) | 
                    uint8Array[offset + 4];

      if (length > 0 && offset + 5 + length <= buffer.byteLength) {
        const frameData = uint8Array.slice(offset + 5, offset + 5 + length);
        frames.push({
          flags,
          length,
          data: frameData
        });
        offset += 5 + length;
      } else {
        break;
      }
    }

    return {
      success: true,
      frames,
      rawLength: buffer.byteLength,
    };
  }

  /**
   * 从二进制数据中提取活动描述
   */
  private extractActivities(bytes: Uint8Array): Array<{ description: string; offset: number; endOffset: number }> {
    const textDecoder = new TextDecoder('utf-8', { fatal: false });
    const activities: Array<{ description: string; offset: number; endOffset: number }> = [];
    let current: number[] = [];
    let startIdx = 0;

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 32 && b <= 126) {
        if (current.length === 0) startIdx = i;
        current.push(b);
      } else {
        if (current.length >= 4) {
          const text = textDecoder.decode(Uint8Array.from(current)).trim();
          if (text && /Supply to|Euler|Aave|Etherex|Provide liquidity/i.test(text)) {
            activities.push({
              description: text,
              offset: startIdx,
              endOffset: i - 1
            });
          }
        }
        current = [];
      }
    }

    return activities;
  }

  /**
   * 从活动描述位置提取字段值
   */
  private extractFieldValue(
    bytes: Uint8Array,
    activityEndOffset: number,
    fieldOffset: number
  ): number | null {
    const fieldPosition = activityEndOffset + fieldOffset;
    
    if (fieldPosition + 8 > bytes.length) {
      return null;
    }

    try {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + fieldPosition, 8);
      const value = dv.getFloat64(0, true); // little-endian
      return value;
    } catch (error) {
      return null;
    }
  }

  /**
   * 提取活动的完整数据
   */
  private extractActivityData(
    activity: { description: string; offset: number; endOffset: number },
    bytes: Uint8Array
  ): any {
    const data: any = {
      description: activity.description,
    };

    // 提取 Last Week APR
    const aprValue = this.extractFieldValue(bytes, activity.endOffset, this.FIELD_OFFSETS.LAST_WEEK_APR);
    if (aprValue && aprValue > 0.0001 && aprValue < 0.5) {
      const aprPercent = aprValue * 100;
      if (aprPercent > 0.01 && aprPercent < 50) {
        data.lastWeekApr = aprPercent;
        data.lastWeekAprRaw = aprValue;
      }
    }

    // 提取 Last Week Rewards
    const rewardsValue = this.extractFieldValue(bytes, activity.endOffset, this.FIELD_OFFSETS.LAST_WEEK_REWARDS);
    if (rewardsValue && rewardsValue > 0 && rewardsValue < 1e10) {
      data.lastWeekRewards = rewardsValue;
    }

    // 提取 Last Week Rewards USD
    const rewardsUsdValue = this.extractFieldValue(bytes, activity.endOffset, this.FIELD_OFFSETS.LAST_WEEK_REWARDS_USD);
    if (rewardsUsdValue && rewardsUsdValue > 0 && rewardsUsdValue < 1e6) {
      data.lastWeekRewardsUsd = rewardsUsdValue;
    }

    // 提取地址和 URL
    const searchWindow = 300;
    const searchStart = Math.max(0, activity.offset - searchWindow);
    const searchEnd = Math.min(bytes.length, activity.endOffset + searchWindow);
    const textDecoder = new TextDecoder('utf-8', { fatal: false });
    const contextText = textDecoder.decode(bytes.slice(searchStart, searchEnd));

    const addresses = [...new Set(contextText.match(/0x[a-fA-F0-9]{40}/g) || [])];
    const urls = [...new Set(contextText.match(/https?:\/\/[^\s"']+/g) || [])];

    // 识别协议
    let protocol = 'Unknown';
    if (activity.description.includes('Aave')) protocol = 'Aave';
    else if (activity.description.includes('Euler')) protocol = 'Euler Finance';
    else if (activity.description.includes('Etherex')) protocol = 'Etherex';

    data.protocol = protocol;
    data.pool_address = addresses[0] || null;
    data.token_address = addresses[1] || null;
    data.addresses = addresses.slice(0, 5);
    data.detail_url = urls[0] || null;
    data.reward_rules_url = urls.find((u: string) => u.includes('reward') || u.includes('rule')) || null;

    return data;
  }

  /**
   * 调用 GetActivities API
   */
  async getActivities(requestBody?: any): Promise<any> {
    const url = `${this.baseUrl}/LineaSurgeV2Provider/GetActivities`;
    const headers = this.getDefaultHeaders();
    const body = this.encodeGrpcWebBody(requestBody);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: Buffer.from(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/grpc-web+proto')) {
        const buffer = await response.arrayBuffer();
        return this.decodeGrpcWebResponse(buffer);
      } else {
        const text = await response.text();
        return { raw: text };
      }
    } catch (error: any) {
      throw new Error(`API 调用失败: ${error.message}`);
    }
  }

  /**
   * 获取所有活动数据
   */
  async getAllActivities(): Promise<any[]> {
    try {
      logger.info('📡 调用 Brevis GetActivities API...');
      const result = await this.getActivities();
      
      const successfulResult = result.frames?.find((f: any) => f.length > 0);
      if (!successfulResult) {
        throw new Error('没有找到响应数据');
      }

      const frameData = successfulResult.data;
      const bytes = Uint8Array.from(Object.values(frameData) as number[]);

      logger.info(`📦 处理 ${bytes.length} 字节的数据`);

      // 提取活动
      const activities = this.extractActivities(bytes);
      logger.info(`📋 找到 ${activities.length} 个活动描述`);

      // 提取每个活动的数据
      const activitiesData = activities.map(activity => 
        this.extractActivityData(activity, bytes)
      );

      // 去重
      const uniqueActivities = new Map<string, any>();
      for (const activity of activitiesData) {
        const key = activity.description.trim();
        if (!uniqueActivities.has(key) || 
            (activity.lastWeekApr && !uniqueActivities.get(key).lastWeekApr)) {
          uniqueActivities.set(key, activity);
        }
      }

      return Array.from(uniqueActivities.values());
    } catch (error: any) {
      logger.error(`❌ 获取活动数据失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取 Aave 相关的活动 APR 数据
   * 
   * @returns Aave 活动的 APR 数据数组
   */
  async getAaveAprs(): Promise<Array<{
    description: string;
    lastWeekApr: number | null;
    lastWeekRewards: number | null;
    lastWeekRewardsUsd: number | null;
    pool_address: string | null;
    token_address: string | null;
    detail_url: string | null;
  }>> {
    try {
      logger.info('🎯 获取 Aave 相关 APR 数据...');
      
      const allActivities = await this.getAllActivities();
      
      // 过滤出 Aave 相关的活动
      const aaveActivities = allActivities.filter(activity => 
        activity.protocol === 'Aave' && 
        activity.description.toLowerCase().includes('aave')
      );

      logger.info(`✅ 找到 ${aaveActivities.length} 个 Aave 活动`);

      // 格式化返回数据
      return aaveActivities.map(activity => ({
        description: activity.description,
        lastWeekApr: activity.lastWeekApr || null,
        lastWeekRewards: activity.lastWeekRewards || null,
        lastWeekRewardsUsd: activity.lastWeekRewardsUsd || null,
        pool_address: activity.pool_address || null,
        token_address: activity.token_address || null,
        detail_url: activity.detail_url || null,
      }));
    } catch (error: any) {
      logger.error(`❌ 获取 Aave APR 数据失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取指定协议的活动数据
   * 
   * @param protocol 协议名称 ('Aave', 'Euler Finance', 'Etherex')
   * @returns 该协议的活动数据数组
   */
  async getActivitiesByProtocol(protocol: string): Promise<any[]> {
    try {
      logger.info(`🎯 获取 ${protocol} 相关活动数据...`);
      
      const allActivities = await this.getAllActivities();
      
      const filteredActivities = allActivities.filter(activity => 
        activity.protocol === protocol
      );

      logger.info(`✅ 找到 ${filteredActivities.length} 个 ${protocol} 活动`);

      return filteredActivities;
    } catch (error: any) {
      logger.error(`❌ 获取 ${protocol} 活动数据失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 尝试不同的请求格式来获取数据（带重试机制）
   */
  async getActivitiesWithRetry(): Promise<any> {
    const results: any[] = [];

    // 尝试 1: 空请求体
    try {
      const result1 = await this.getActivities();
      results.push({ method: 'empty', success: true, data: result1 });
    } catch (error: any) {
      results.push({ method: 'empty', success: false, error: error.message });
    }

    return {
      timestamp: new Date().toISOString(),
      results
    };
  }
}

// 导出单例实例
export const brevisApi = new BrevisApiClient();
