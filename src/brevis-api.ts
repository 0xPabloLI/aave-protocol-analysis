import fetch from 'node-fetch';
import { logger } from './logger.js';

/**
 * Brevis Incentra API 客户端
 * 
 * 基于 Brevis Incentra API 文档，获取 Aave 协议相关的 campaign 数据
 * API 文档: https://incentra-docs.brevis.network
 * 
 * 支持的数据：
 * - APR (从 reward_info.apr)
 * - Chain ID 和 Pool Token Address 作为索引
 * - Campaign 开始和结束时间
 * - Action 类型（用于区分 supply/borrow/both）
 * - Campaign 链接
 * - Campaign 描述信息（message）
 */
export interface BrevisCampaignInfo {
  chainId: number;
  poolAddress: string; // pool_id from URL
  tokenAddress: string | null; // token address if available
  action: number; // campaign type (e.g. 2001/2002/3001)
  actionType: 'supply' | 'borrow' | 'both' | 'unknown';
  campaignId: string;
  campaignName: string;
  startTime: number; // Unix timestamp
  endTime: number; // Unix timestamp
  apr: number; // APR as decimal (e.g., 0.024 for 2.4%)
  link: string; // Campaign URL
  message: string; // Campaign description/message
  status: string; // Campaign status (string label)
  rewardInfo?: {
    tokenAddress: string;
    tokenSymbol: string;
    rewardAmt: string;
    rewardUsdPrice: string;
    apr: number;
    tvl: number;
  };
}

export interface BrevisCampaignData {
  supply: BrevisCampaignInfo[];
  borrow: BrevisCampaignInfo[];
}

// Brevis Campaign Item（用于 FormattedReserveData）
export interface BrevisCampaignItem {
  apr: number; // APR 百分比值
  link: string; // Campaign URL
  startDate: string; // ISO date string
  endDate: string; // ISO date string
  message: string; // Campaign description/message
}

// Brevis 数据项结构（类似 MeritDataItem）
export interface BrevisDataItem {
  brevisSupplys: BrevisCampaignItem[];
  brevisBorrows: BrevisCampaignItem[];
}

export class BrevisApiClient {
  private frontendUrl = 'https://incentra.brevis.network';
  private grpcBaseUrl = 'https://incentra-prd.brevis.network';
  private grpcEndpoints = {
    getAllProtocolDetail: '/IncentiveProvider/GetAllProtocolDetail',
    getAllProtocols: '/IncentiveProvider/GetAllProtocols',
  };


  private getGrpcHeaders(): Record<string, string> {
    return {
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'grpc-web-javascript/0.1',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    };
  }

  private encodeVarint(value: number): Buffer {
    const chunks: number[] = [];
    let current = value;
    while (current > 127) {
      chunks.push((current & 0x7f) | 0x80);
      current >>= 7;
    }
    chunks.push(current & 0x7f);
    return Buffer.from(chunks);
  }

  private encodeKey(fieldNumber: number, wireType: number): Buffer {
    return this.encodeVarint((fieldNumber << 3) | wireType);
  }

  private encodeLengthDelimited(data: Buffer): Buffer {
    return Buffer.concat([this.encodeVarint(data.length), data]);
  }

  private buildGrpcWebFrame(payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt8(0x00, 0);
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  private encodePackedVarints(values: number[]): Buffer {
    const chunks: Buffer[] = [];
    for (const value of values) {
      chunks.push(this.encodeVarint(value));
    }
    return this.encodeLengthDelimited(Buffer.concat(chunks));
  }

  private async grpcUnaryCall(endpoint: string, payload: Buffer): Promise<Buffer> {
    const body = this.buildGrpcWebFrame(payload);
    const response = await fetch(`${this.grpcBaseUrl}${endpoint}`, {
      method: 'POST',
      headers: this.getGrpcHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`gRPC 请求失败: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 5) {
      throw new Error('gRPC 响应为空');
    }

    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const flag = buffer.readUInt8(offset);
      const length = buffer.readUInt32BE(offset + 1);
      offset += 5;
      const chunk = buffer.slice(offset, offset + length);
      offset += length;
      if (flag === 0x00) {
        frames.push(chunk);
      }
    }

    if (frames.length === 0) {
      throw new Error('未解析到 gRPC message frame');
    }

    return frames[0];
  }

  private readVarint(buffer: Buffer, offset: number): { value: number; offset: number } {
    let result = 0;
    let shift = 0;
    let cursor = offset;

    while (cursor < buffer.length) {
      const byte = buffer.readUInt8(cursor);
      cursor += 1;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }

    return { value: result, offset: cursor };
  }

  private parseMessage(buffer: Buffer): Array<{ field: number; wireType: number; value: number | Buffer }> {
    const fields: Array<{ field: number; wireType: number; value: number | Buffer }> = [];
    let offset = 0;

    while (offset < buffer.length) {
      const key = this.readVarint(buffer, offset);
      const fieldNumber = key.value >> 3;
      const wireType = key.value & 0x07;
      offset = key.offset;

      if (wireType === 0) {
        const value = this.readVarint(buffer, offset);
        offset = value.offset;
        fields.push({ field: fieldNumber, wireType, value: value.value });
        continue;
      }

      if (wireType === 2) {
        const lengthInfo = this.readVarint(buffer, offset);
        const length = lengthInfo.value;
        offset = lengthInfo.offset;
        const value = buffer.slice(offset, offset + length);
        offset += length;
        fields.push({ field: fieldNumber, wireType, value });
        continue;
      }

      if (wireType === 5) {
        const value = buffer.readUInt32LE(offset);
        offset += 4;
        fields.push({ field: fieldNumber, wireType, value });
        continue;
      }

      break;
    }

    return fields;
  }

  private readFloatFromUint32(value: number): number {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    return buf.readFloatLE(0);
  }

  private parseProtocol(buffer: Buffer): any {
    const protocol: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && typeof field.value === 'number') protocol.chainId = field.value;
      if (field.field === 2 && typeof field.value === 'number') protocol.type = field.value;
      if (field.field === 3 && Buffer.isBuffer(field.value)) protocol.id = field.value.toString('utf-8');
      if (field.field === 4 && Buffer.isBuffer(field.value)) protocol.name = field.value.toString('utf-8');
      if (field.field === 6 && typeof field.value === 'number') protocol.tvl = this.readFloatFromUint32(field.value);
      if (field.field === 7 && typeof field.value === 'number') protocol.apr = this.readFloatFromUint32(field.value);
      if (field.field === 11 && typeof field.value === 'number') protocol.protocolStatus = field.value;
    }
    return protocol;
  }

  private parseRewardToken(buffer: Buffer): any {
    const token: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && Buffer.isBuffer(field.value)) token.addr = field.value.toString('utf-8');
      if (field.field === 2 && Buffer.isBuffer(field.value)) token.iconUrl = field.value.toString('utf-8');
      if (field.field === 3 && Buffer.isBuffer(field.value)) token.symbol = field.value.toString('utf-8');
      if (field.field === 4 && typeof field.value === 'number') token.decimals = field.value;
    }
    return token;
  }

  private parseRewardTokenWithAmt(buffer: Buffer): any {
    const reward: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && Buffer.isBuffer(field.value)) reward.token = this.parseRewardToken(field.value);
      if (field.field === 2 && Buffer.isBuffer(field.value)) reward.totalAmt = field.value.toString('utf-8');
      if (field.field === 3 && Buffer.isBuffer(field.value)) reward.depositAmt = field.value.toString('utf-8');
      if (field.field === 4 && Buffer.isBuffer(field.value)) reward.rewardPerHourAmt = field.value.toString('utf-8');
    }
    return reward;
  }

  /**
   * 解析 CampaignConfig 消息
   * Protocol Buffers field 映射（通过分析 gRPC 响应得到）：
   * - field 1: chainId (uint32)
   * - field 2: name (string)
   * - field 3: type (uint32)
   * - field 4: start (uint64)
   * - field 5: end (uint64)
   * - field 6: tokenAmtList (repeated RewardTokenWithAmt)
   */
  private parseCampaignConfig(buffer: Buffer): any {
    const config: any = { tokenAmtList: [] };
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && typeof field.value === 'number') config.chainId = field.value;
      if (field.field === 2 && Buffer.isBuffer(field.value)) config.name = field.value.toString('utf-8');
      if (field.field === 3 && typeof field.value === 'number') config.type = field.value;
      if (field.field === 4 && typeof field.value === 'number') config.start = field.value;
      if (field.field === 5 && typeof field.value === 'number') config.end = field.value;
      if (field.field === 6 && Buffer.isBuffer(field.value)) config.tokenAmtList.push(this.parseRewardTokenWithAmt(field.value));
    }
    return config;
  }

  private parseCampaign(buffer: Buffer): any {
    const campaign: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && typeof field.value === 'number') campaign.chainId = field.value;
      if (field.field === 2 && typeof field.value === 'number') campaign.status = field.value;
      if (field.field === 3 && typeof field.value === 'number') campaign.id = field.value;
      if (field.field === 4 && typeof field.value === 'number') campaign.type = field.value;
      if (field.field === 5 && Buffer.isBuffer(field.value)) campaign.config = this.parseCampaignConfig(field.value);
      if (field.field === 6 && typeof field.value === 'number') campaign.submitChainId = field.value;
      if (field.field === 7 && Buffer.isBuffer(field.value)) campaign.submitAddr = field.value.toString('utf-8');
      if (field.field === 8 && typeof field.value === 'number') campaign.claimChainId = field.value;
      if (field.field === 9 && Buffer.isBuffer(field.value)) campaign.claimAddr = field.value.toString('utf-8');
    }
    return campaign;
  }

  /**
   * 解析 CampaignDetail 消息
   * Protocol Buffers field 映射（通过分析 gRPC 响应得到）：
   * - field 1: campaign (Campaign 消息)
   * - field 2: lastRewardAttestationTime (uint64)
   * - field 3: protocolId (string)
   * - field 4: lastEpochStartTime (uint64)
   * - field 5: lastEpochEndTime (uint64)
   */
  private parseCampaignDetail(buffer: Buffer): any {
    const detail: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && Buffer.isBuffer(field.value)) detail.campaign = this.parseCampaign(field.value);
      if (field.field === 2 && typeof field.value === 'number') detail.lastRewardAttestationTime = field.value;
      if (field.field === 3 && Buffer.isBuffer(field.value)) detail.protocolId = field.value.toString('utf-8');
      if (field.field === 4 && typeof field.value === 'number') detail.lastEpochStartTime = field.value;
      if (field.field === 5 && typeof field.value === 'number') detail.lastEpochEndTime = field.value;
    }
    return detail;
  }

  private parseGetAllProtocolDetailResponse(payload: Buffer): any {
    const response: any = { campaignDetailsList: [] };
    for (const field of this.parseMessage(payload)) {
      if (field.field === 1 && Buffer.isBuffer(field.value)) response.err = field.value;
      if (field.field === 2 && Buffer.isBuffer(field.value)) response.protocol = this.parseProtocol(field.value);
      if (field.field === 3 && Buffer.isBuffer(field.value)) response.campaignDetailsList.push(this.parseCampaignDetail(field.value));
    }
    return response;
  }

  private parseGetAllProtocolsResponse(payload: Buffer): any {
    const response: any = { protocolsList: [] };
    for (const field of this.parseMessage(payload)) {
      if (field.field === 1 && Buffer.isBuffer(field.value)) response.err = field.value;
      if (field.field === 2 && Buffer.isBuffer(field.value)) response.protocolsList.push(this.parseProtocol(field.value));
    }
    return response;
  }


  private async getAllProtocolDetailFromGrpc(params: {
    chainId?: number;
    type?: number;
    id?: string;
  } = {}): Promise<any> {
    const payloadParts: Buffer[] = [];
    
    // 只有提供了参数才添加到 payload（不支持数组参数，测试证明 API 不支持）
    if (params.chainId !== undefined) {
      payloadParts.push(this.encodeKey(1, 0));
      payloadParts.push(this.encodeVarint(params.chainId));
    }
    
    if (params.type !== undefined) {
      payloadParts.push(this.encodeKey(2, 0));
      payloadParts.push(this.encodeVarint(params.type));
    }
    
    if (params.id !== undefined) {
      payloadParts.push(this.encodeKey(3, 2));
      payloadParts.push(this.encodeLengthDelimited(Buffer.from(params.id, 'utf-8')));
    }
    
    // 如果不传任何参数，payloadParts 就是空数组（发送空 payload）
    const payload = payloadParts.length > 0 
      ? Buffer.concat(payloadParts) 
      : Buffer.alloc(0);
      
    logger.debug(`[getAllProtocolDetailFromGrpc] Sending payload with ${payloadParts.length} fields (empty: ${payload.length === 0})`);
    
    const frame = await this.grpcUnaryCall(this.grpcEndpoints.getAllProtocolDetail, payload);
    return this.parseGetAllProtocolDetailResponse(frame);
  }

  private mapActionType(campaignType: number): 'supply' | 'borrow' | 'both' | 'unknown' {
    if (campaignType === 2002) return 'supply';
    if (campaignType === 2001) return 'borrow';
    if (campaignType === 3001) return 'both';
    return 'unknown';
  }

  private mapStatusLabel(status: number | string): string {
    if (typeof status === 'string') return status;
    switch (status) {
      case 1: return 'DEPLOYING';
      case 2: return 'CREATING_FAILED';
      case 3: return 'INACTIVE';
      case 4: return 'ACTIVE';
      case 5: return 'ENDED';
      case 6: return 'DEACTIVATED';
      default: return 'UNKNOWN';
    }
  }



  /**
   * 从 gRPC GetAllProtocolDetail 响应解析 campaign 数据
   */
  private parseCampaignsFromGrpcResponse(response: any): BrevisCampaignInfo[] {
    const campaigns: BrevisCampaignInfo[] = [];
    const protocol = response?.protocol;
    const details = response?.campaignDetailsList || [];

    for (const detail of details) {
      const campaign = detail?.campaign || {};
      const config = campaign?.config || {};
      const type = campaign?.type ?? config?.type ?? 0;
      const actionType = this.mapActionType(type);
      const token = config?.tokenAmtList?.[0]?.token;
      const link = protocol?.id && protocol?.chainId && type
        ? `${this.frontendUrl}/campaign/?pool_id=${protocol.id}&type=${type}&chainId=${protocol.chainId}`
        : '';

      campaigns.push({
        chainId: protocol?.chainId || campaign?.chainId || 0,
        poolAddress: protocol?.id || detail?.protocolId || '',
        tokenAddress: token?.addr || null,
        action: type,
        actionType,
        campaignId: campaign?.id ? String(campaign.id) : '',
        campaignName: config?.name || '',
        startTime: config?.start || 0,
        endTime: config?.end || 0,
        apr: protocol?.apr || 0,
        link,
        message: config?.name || '',
        status: this.mapStatusLabel(campaign?.status || 'UNKNOWN'),
        rewardInfo: token ? {
          tokenAddress: token.addr || '',
          tokenSymbol: token.symbol || '',
          rewardAmt: config?.tokenAmtList?.[0]?.totalAmt || '0',
          rewardUsdPrice: '',
          apr: protocol?.apr || 0,
          tvl: protocol?.tvl || 0,
        } : undefined,
      });
    }

    return campaigns;
  }

  /**
   * 直接从 gRPC 获取单个 pool 的 campaign 详情（用于页面数据）
   * 注意：API 不支持数组参数，只支持单个值
   */
  async getCampaignDetailByPool(params: {
    chainId?: number;
    type?: number;
    poolId?: string;
  } = {}): Promise<{ raw: any; rawCampaigns: any[]; campaigns: BrevisCampaignInfo[] }> {
    // 确保参数是单个值（不支持数组）
    const response = await this.getAllProtocolDetailFromGrpc({
      chainId: params.chainId,
      type: params.type,
      id: params.poolId,
    });

    return {
      raw: response,
      rawCampaigns: response?.campaignDetailsList || [],
      campaigns: this.parseCampaignsFromGrpcResponse(response),
    };
  }

  /**
   * 获取全部 protocol/pool 列表（gRPC）
   */
  async getAllProtocolsList(params: {
    chainIds?: number[];
    types?: number[];
    searchInput?: string;
    campaignStatus?: number[];
  } = {}): Promise<{ raw: any; protocols: any[] }> {
    const payloadParts: Buffer[] = [];

    if (params.chainIds?.length) {
      payloadParts.push(this.encodeKey(1, 2));
      payloadParts.push(this.encodePackedVarints(params.chainIds));
    }

    if (params.types?.length) {
      payloadParts.push(this.encodeKey(2, 2));
      payloadParts.push(this.encodePackedVarints(params.types));
    }

    if (params.searchInput) {
      payloadParts.push(this.encodeKey(3, 2));
      payloadParts.push(this.encodeLengthDelimited(Buffer.from(params.searchInput, 'utf-8')));
    }

    if (params.campaignStatus?.length) {
      payloadParts.push(this.encodeKey(4, 2));
      payloadParts.push(this.encodePackedVarints(params.campaignStatus));
    }

    const payload = Buffer.concat(payloadParts);
    const frame = await this.grpcUnaryCall(this.grpcEndpoints.getAllProtocols, payload);
    const raw = this.parseGetAllProtocolsResponse(frame);

    return {
      raw,
      protocols: raw.protocolsList || [],
    };
  }


  /**
   * 获取所有 Aave 相关的 campaign 数据
   * 从 getAllProtocols 获取所有 protocols，过滤出 Aave 的，然后获取每个的详情
   * 返回格式：Record<`${chainId}-${tokenAddress}`, BrevisDataItem>
   */
  async getAaveCampaignsData(): Promise<{
    index: Record<string, BrevisDataItem>;
    rawProtocolsList: any;
    rawProtocolDetails: Array<{ protocol: any; response: any }>;
  }> {
    try {
      logger.info('📡 从 gRPC 获取所有 protocols 列表...');

      // 1. 获取所有 protocols（保存原始响应）
      const protocolsResult = await this.getAllProtocolsList();
      const allProtocols = protocolsResult.protocols || [];
      const rawProtocolsList = protocolsResult.raw;

      // 2. 过滤出 Aave 相关的 protocols（name 中包含 "aave"）
      const aaveProtocols = allProtocols.filter((p: any) => 
        p.name?.toLowerCase().includes('aave')
      );

      logger.info(`🔍 找到 ${aaveProtocols.length} 个 Aave protocols（共 ${allProtocols.length} 个 protocols）`);

      // 3. 对每个 Aave protocol 获取详情（保存原始响应）
      const campaignsIndex: Record<string, BrevisDataItem> = {};
      const rawProtocolDetails: Array<{ protocol: any; response: any }> = [];

      for (const protocol of aaveProtocols) {
        try {
          const response = await this.getAllProtocolDetailFromGrpc({
            chainId: protocol.chainId,
            type: protocol.type,
            id: protocol.id,
          });

          // 保存原始响应
          rawProtocolDetails.push({
            protocol: protocol,
            response: response,
          });

          const campaignDetails = response?.campaignDetailsList || [];

          // 解析每个 campaign detail
          // campaignDetailsList 的结构来自 Protocol Buffers 解析（通过分析 gRPC 响应得到）：
          // - parseGetAllProtocolDetailResponse: field 3 -> campaignDetailsList (parseCampaignDetail)
          // - parseCampaignDetail: field 1 -> campaign (parseCampaign)
          // - parseCampaign: field 5 -> config (parseCampaignConfig)
          // - parseCampaignConfig: field 6 -> tokenAmtList (parseRewardTokenWithAmt)
          for (const detail of campaignDetails) {
            const campaign = detail?.campaign || {};
            const config = campaign?.config || {};
            const type = campaign?.type ?? config?.type ?? 0;
            const actionType = this.mapActionType(type);
            const token = config?.tokenAmtList?.[0]?.token;
            const tokenAmt = config?.tokenAmtList?.[0];

            // 构建 link
            const link = protocol.id && protocol.chainId && type
              ? `${this.frontendUrl}/campaign/?pool_id=${protocol.id}&type=${type}&chainId=${protocol.chainId}`
              : '';

            // 使用 protocol.apr（从 getAllProtocolsList 返回的 protocol 对象）
            // 注意：不使用 response.protocol.apr（来自 getAllProtocolDetailFromGrpc），
            // 因为两个接口返回的 APR 值可能不同（response.protocol.apr 可能不准确或含义不同）
            // protocol.apr 是小数形式（如 0.024 表示 2.4%），需要 * 100 转换为百分比
            const apr = (protocol?.apr || 0) * 100;

            // 构建 campaign item
            const campaignItem: BrevisCampaignItem = {
              apr: apr,
              link,
              startDate: new Date((config?.start || 0) * 1000).toISOString(),
              endDate: new Date((config?.end || 0) * 1000).toISOString(),
              message: config?.name || protocol?.name || '',
            };

            // 使用 chainId + tokenAddress 作为索引（如果 tokenAddress 存在）
            // 否则使用 chainId + poolAddress
            const tokenAddress = token?.addr?.toLowerCase() || null;
            const poolAddress = protocol.id?.toLowerCase() || '';
            
            let indexKey: string;
            if (tokenAddress) {
              indexKey = `${protocol.chainId}-${tokenAddress}`;
            } else {
              indexKey = `${protocol.chainId}-${poolAddress}`;
            }

            if (!campaignsIndex[indexKey]) {
              campaignsIndex[indexKey] = { brevisSupplys: [], brevisBorrows: [] };
            }

            // 根据 actionType 添加到对应的数组
            if (actionType === 'supply' || actionType === 'both') {
              campaignsIndex[indexKey].brevisSupplys.push(campaignItem);
            }
            if (actionType === 'borrow' || actionType === 'both') {
              campaignsIndex[indexKey].brevisBorrows.push(campaignItem);
            }
          }
        } catch (error: any) {
          logger.warn(`⚠️ 获取 protocol ${protocol.id} 详情失败: ${error.message}`);
          continue;
        }
      }

      const totalSupply = Object.values(campaignsIndex).reduce((sum, item) => sum + item.brevisSupplys.length, 0);
      const totalBorrow = Object.values(campaignsIndex).reduce((sum, item) => sum + item.brevisBorrows.length, 0);

      logger.info(`✅ 索引了 ${Object.keys(campaignsIndex).length} 个 chain-token 组合`);
      logger.info(`   Supply campaigns: ${totalSupply}, Borrow campaigns: ${totalBorrow}`);

      return {
        index: campaignsIndex,
        rawProtocolsList: rawProtocolsList,
        rawProtocolDetails: rawProtocolDetails,
      };
    } catch (error: any) {
      logger.error(`❌ 获取 Aave campaign 数据失败: ${error.message}`);
      throw error;
    }
  }

}

// 导出单例实例
export const brevisApi = new BrevisApiClient();
