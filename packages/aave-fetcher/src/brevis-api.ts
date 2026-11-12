import { logger } from "./logger.js";
import type {
  BaseCampaignBreakdown,
  CampaignGroup,
} from "@internal/aave-shared-config";
import type { ForecastCampaignTypeLite } from "@internal/aave-shared-contracts";
import { isWithinLookbackWindow } from "@internal/aave-shared-contracts";

const BREVIS_ENDED_LOOKBACK_DAYS = 7;

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
 *
 * 按单个 pool 调试用的旧 client 形状与解析逻辑已迁出代码，见 `docs/api/brevis-supplement.md`。
 */
export interface BrevisCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  campaignType?: ForecastCampaignTypeLite;
  aprCap?: number;
  totalBudget?: number;
  latestTvl?: number;
  positionCapUsd?: number;
  budgetNormalizedAmount?: number;
  rewardTokenSymbol?: string;
}

// Brevis Campaign Item（按 campaign group 对外；细节放到 breakdowns 内）
export type BrevisCampaignItem = CampaignGroup<BrevisCampaignBreakdown>;

/**
 * 去掉 Brevis campaign 上仅供 enrich 的预算解析字段，使对象符合对外 / runtime 形状。
 * 在 `fetchBrevisAprs` 中于算出 `totalBudget` 后调用；命名与 `incentive-prune.ts` 中的 pruner 一致。
 */
export function pruneBrevisCampaignForRuntime(
  campaign: BrevisCampaignItem
): BrevisCampaignItem {
  return {
    ...campaign,
    breakdowns: (campaign.breakdowns ?? []).map((breakdown) => {
      const { budgetNormalizedAmount: _n, ...rest } = breakdown;
      return rest;
    }),
  };
}

export function filterRecentExpiredBrevis<
  T extends {
    breakdowns?: Array<{
      campaignEndedAt?: string;
      campaignType?: ForecastCampaignTypeLite;
    }>;
  },
>(items: T[]): T[] {
  const nowMs = Date.now();
  const active = items.filter((item) => {
    const bd = item.breakdowns ?? [];
    return (
      bd.length === 0 ||
      bd.some(
        (b) =>
          !b.campaignEndedAt || new Date(b.campaignEndedAt).getTime() >= nowMs
      )
    );
  });
  const byType = new Map<string, T>();
  for (const item of items) {
    const bd = item.breakdowns ?? [];
    if (bd.length === 0) continue;
    if (
      !bd.every(
        (b) =>
          b.campaignEndedAt && new Date(b.campaignEndedAt).getTime() < nowMs
      )
    )
      continue;
    const allRecent = bd.every((b) =>
      isWithinLookbackWindow(
        b.campaignEndedAt,
        nowMs,
        BREVIS_ENDED_LOOKBACK_DAYS
      )
    );
    if (!allRecent) continue;
    const type = bd[0]?.campaignType ?? "UNKNOWN";
    const existing = byType.get(type);
    const itemEnd = Math.max(
      ...bd.map((b) =>
        b.campaignEndedAt ? new Date(b.campaignEndedAt).getTime() : 0
      )
    );
    const existingEnd = existing
      ? Math.max(
          ...(existing.breakdowns ?? []).map((b) =>
            b.campaignEndedAt ? new Date(b.campaignEndedAt).getTime() : 0
          )
        )
      : 0;
    if (!existing || itemEnd > existingEnd) {
      byType.set(type, item);
    }
  }
  return [...active, ...byType.values()];
}

// Brevis 数据项结构（按 reserve key 索引的 supply/borrow 激励数组）
export interface BrevisDataItem {
  brevisSupplys: BrevisCampaignItem[];
  brevisBorrows: BrevisCampaignItem[];
  /** Protocol version. Currently only V3. */
  protocolVersion: "v3" | "v4";
}

/**
 * Campaign 文案在压缩后的 `_app` chunk 里的首尾锚点，按顺序尝试。
 * 锚点是扫 minified JSX 的定位手段，不是语义契约——所以给多个候选，
 * 让改词只影响命中哪一条，而不影响 cap 是否被抓到。
 */
const COPY_START_MARKERS: readonly string[] = [
  "Eligible MetaMask",
  "MetaMask Card users",
  "reward APR when lending",
  "reward APR",
];
const COPY_END_MARKERS: readonly string[] = [
  'per user."',
  "per user",
  "collateral and/or debt",
];

export class BrevisApiClient {
  private frontendUrl = "https://incentra.brevis.network";
  private grpcBaseUrl = "https://incentra-prd.brevis.network";
  private grpcEndpoints = {
    getAllProtocolDetail: "/IncentiveProvider/GetAllProtocolDetail",
    getAllProtocols: "/IncentiveProvider/GetAllProtocols",
  };

  private normalizeTokenAmount(
    rawAmount: string | undefined,
    decimals: number | undefined
  ): string | undefined {
    if (!rawAmount || typeof rawAmount !== "string") return undefined;
    if (decimals === undefined || decimals < 0 || !Number.isInteger(decimals))
      return undefined;
    if (!/^\d+$/.test(rawAmount)) return undefined;

    const value = BigInt(rawAmount);
    const scale = 10n ** BigInt(decimals);
    const integerPart = value / scale;
    const fractionPart = value % scale;
    if (fractionPart === 0n) return integerPart.toString();

    const fractionRaw = fractionPart.toString().padStart(decimals, "0");
    const trimmedFraction = fractionRaw.replace(/0+$/, "");
    return `${integerPart.toString()}.${trimmedFraction}`;
  }

  private getGrpcHeaders(): Record<string, string> {
    return {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-user-agent": "grpc-web-javascript/0.1",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
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

  private async grpcUnaryCall(
    endpoint: string,
    payload: Buffer
  ): Promise<Buffer> {
    const body = new Uint8Array(this.buildGrpcWebFrame(payload));
    const response = await fetch(`${this.grpcBaseUrl}${endpoint}`, {
      method: "POST",
      headers: this.getGrpcHeaders(),
      body,
    });

    if (!response.ok) {
      await response.text().catch(() => {});
      throw new Error(`gRPC 请求失败: ${response.status}`);
    }

    const ab = await response.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length < 5) {
      throw new Error("gRPC 响应为空");
    }

    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const flag = buffer.readUInt8(offset);
      const length = buffer.readUInt32BE(offset + 1);
      offset += 5;
      const chunk = Buffer.from(buffer.subarray(offset, offset + length));
      offset += length;
      if (flag === 0x00) {
        frames.push(chunk);
      }
    }

    if (frames.length === 0) {
      throw new Error("未解析到 gRPC message frame");
    }

    return frames[0];
  }

  private readVarint(
    buffer: Buffer,
    offset: number
  ): { value: number; offset: number } {
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

  private parseMessage(
    buffer: Buffer
  ): Array<{ field: number; wireType: number; value: number | Buffer }> {
    const fields: Array<{
      field: number;
      wireType: number;
      value: number | Buffer;
    }> = [];
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
        const value = Buffer.from(buffer.subarray(offset, offset + length));
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
      if (field.field === 1 && typeof field.value === "number")
        protocol.chainId = field.value;
      if (field.field === 2 && typeof field.value === "number")
        protocol.type = field.value;
      if (field.field === 3 && Buffer.isBuffer(field.value))
        protocol.id = field.value.toString("utf-8");
      if (field.field === 4 && Buffer.isBuffer(field.value))
        protocol.name = field.value.toString("utf-8");
      if (field.field === 6 && typeof field.value === "number")
        protocol.tvl = this.readFloatFromUint32(field.value);
      if (field.field === 7 && typeof field.value === "number")
        protocol.apr = this.readFloatFromUint32(field.value);
      if (field.field === 11 && typeof field.value === "number")
        protocol.protocolStatus = field.value;
    }
    return protocol;
  }

  private parseRewardToken(buffer: Buffer): any {
    const token: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && Buffer.isBuffer(field.value))
        token.addr = field.value.toString("utf-8");
      if (field.field === 2 && Buffer.isBuffer(field.value))
        token.iconUrl = field.value.toString("utf-8");
      if (field.field === 3 && Buffer.isBuffer(field.value))
        token.symbol = field.value.toString("utf-8");
      if (field.field === 4 && typeof field.value === "number")
        token.decimals = field.value;
    }
    return token;
  }

  private parseRewardTokenWithAmt(buffer: Buffer): any {
    const reward: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && Buffer.isBuffer(field.value))
        reward.token = this.parseRewardToken(field.value);
      if (field.field === 2 && Buffer.isBuffer(field.value))
        reward.totalAmt = field.value.toString("utf-8");
      if (field.field === 3 && Buffer.isBuffer(field.value))
        reward.depositAmt = field.value.toString("utf-8");
      if (field.field === 4 && Buffer.isBuffer(field.value))
        reward.rewardPerHourAmt = field.value.toString("utf-8");
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
      if (field.field === 1 && typeof field.value === "number")
        config.chainId = field.value;
      if (field.field === 2 && Buffer.isBuffer(field.value))
        config.name = field.value.toString("utf-8");
      if (field.field === 3 && typeof field.value === "number")
        config.type = field.value;
      if (field.field === 4 && typeof field.value === "number")
        config.start = field.value;
      if (field.field === 5 && typeof field.value === "number")
        config.end = field.value;
      if (field.field === 6 && Buffer.isBuffer(field.value))
        config.tokenAmtList.push(this.parseRewardTokenWithAmt(field.value));
    }
    return config;
  }

  private parseCampaign(buffer: Buffer): any {
    const campaign: any = {};
    for (const field of this.parseMessage(buffer)) {
      if (field.field === 1 && typeof field.value === "number")
        campaign.chainId = field.value;
      if (field.field === 2 && typeof field.value === "number")
        campaign.status = field.value;
      if (field.field === 3 && typeof field.value === "number")
        campaign.id = field.value;
      if (field.field === 4 && typeof field.value === "number")
        campaign.type = field.value;
      if (field.field === 5 && Buffer.isBuffer(field.value))
        campaign.config = this.parseCampaignConfig(field.value);
      if (field.field === 6 && typeof field.value === "number")
        campaign.submitChainId = field.value;
      if (field.field === 7 && Buffer.isBuffer(field.value))
        campaign.submitAddr = field.value.toString("utf-8");
      if (field.field === 8 && typeof field.value === "number")
        campaign.claimChainId = field.value;
      if (field.field === 9 && Buffer.isBuffer(field.value))
        campaign.claimAddr = field.value.toString("utf-8");
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
      if (field.field === 1 && Buffer.isBuffer(field.value))
        detail.campaign = this.parseCampaign(field.value);
      if (field.field === 2 && typeof field.value === "number")
        detail.lastRewardAttestationTime = field.value;
      if (field.field === 3 && Buffer.isBuffer(field.value))
        detail.protocolId = field.value.toString("utf-8");
      if (field.field === 4 && typeof field.value === "number")
        detail.lastEpochStartTime = field.value;
      if (field.field === 5 && typeof field.value === "number")
        detail.lastEpochEndTime = field.value;
    }
    return detail;
  }

  private parseGetAllProtocolDetailResponse(payload: Buffer): any {
    const response: any = { campaignDetailsList: [] };
    for (const field of this.parseMessage(payload)) {
      if (field.field === 1 && Buffer.isBuffer(field.value))
        response.err = field.value.toString("utf-8");
      if (field.field === 2 && Buffer.isBuffer(field.value))
        response.protocol = this.parseProtocol(field.value);
      if (field.field === 3 && Buffer.isBuffer(field.value))
        response.campaignDetailsList.push(
          this.parseCampaignDetail(field.value)
        );
    }
    return response;
  }

  private parseGetAllProtocolsResponse(payload: Buffer): any {
    const response: any = { protocolsList: [] };
    for (const field of this.parseMessage(payload)) {
      if (field.field === 1 && Buffer.isBuffer(field.value))
        response.err = field.value.toString("utf-8");
      if (field.field === 2 && Buffer.isBuffer(field.value))
        response.protocolsList.push(this.parseProtocol(field.value));
    }
    return response;
  }

  private async getAllProtocolDetailFromGrpc(
    params: {
      chainId?: number;
      type?: number;
      id?: string;
    } = {}
  ): Promise<any> {
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
      payloadParts.push(
        this.encodeLengthDelimited(Buffer.from(params.id, "utf-8"))
      );
    }

    // 如果不传任何参数，payloadParts 就是空数组（发送空 payload）
    const payload =
      payloadParts.length > 0 ? Buffer.concat(payloadParts) : Buffer.alloc(0);

    logger.debug(
      `[getAllProtocolDetailFromGrpc] Sending payload with ${payloadParts.length} fields (empty: ${payload.length === 0})`
    );

    const frame = await this.grpcUnaryCall(
      this.grpcEndpoints.getAllProtocolDetail,
      payload
    );
    return this.parseGetAllProtocolDetailResponse(frame);
  }

  private mapActionType(
    campaignType: number
  ): "supply" | "borrow" | "both" | "unknown" {
    if (
      campaignType === 2002 ||
      campaignType === 5001 ||
      campaignType === 5003 ||
      campaignType === 6001
    )
      return "supply";
    if (campaignType === 2001 || campaignType === 5002) return "borrow";
    if (campaignType === 3001) return "both";
    return "unknown";
  }

  /**
   * 获取全部 protocol/pool 列表（gRPC）
   */
  async getAllProtocolsList(
    params: {
      chainIds?: number[];
      types?: number[];
      searchInput?: string;
      campaignStatus?: number[];
    } = {}
  ): Promise<{ raw: any; protocols: any[] }> {
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
      payloadParts.push(
        this.encodeLengthDelimited(Buffer.from(params.searchInput, "utf-8"))
      );
    }

    if (params.campaignStatus?.length) {
      payloadParts.push(this.encodeKey(4, 2));
      payloadParts.push(this.encodePackedVarints(params.campaignStatus));
    }

    const payload = Buffer.concat(payloadParts);
    const frame = await this.grpcUnaryCall(
      this.grpcEndpoints.getAllProtocols,
      payload
    );
    const raw = this.parseGetAllProtocolsResponse(frame);

    return {
      raw,
      protocols: raw.protocolsList || [],
    };
  }

  /**
   * 从 Brevis 前端 JS bundle 动态提取 MetaMask campaign 描述文字
   * 用于监控 position cap 等关键参数变化
   *
   * 原理：该描述文字不在 gRPC API 中返回，而是硬编码在前端 _app JS chunk 中，
   * 条件为 campaign.type === CampaignType.METAMASK (3001)。
   * 我们通过 fetch HTML → 找到 _app chunk → 正则提取描述文字。
   */
  async fetchMetaMaskCampaignDescription(): Promise<{
    description: string;
    positionCap: number | null;
    /** 命中的金额句式（`p1`…`p5`），null 表示文案里没解析出 cap。 */
    pattern: string | null;
    /** 命中的首尾锚点，仅用于告警定位。 */
    markerPair: string;
  } | null> {
    try {
      // 1. Fetch 页面 HTML，找到 _app chunk 文件名（含构建 hash）
      const pageResponse = await fetch(`${this.frontendUrl}/campaign/`);
      if (!pageResponse.ok) {
        logger.warn(`⚠️ Brevis 页面请求失败: ${pageResponse.status}`);
        return null;
      }
      const html = await pageResponse.text();

      const appChunkMatch = html.match(
        /src="(\/_next\/static\/chunks\/pages\/_app-[^"]+\.js)"/
      );
      if (!appChunkMatch) {
        logger.warn("⚠️ 未找到 Brevis _app JS chunk URL");
        return null;
      }

      // 2. Fetch JS chunk
      const chunkUrl = `${this.frontendUrl}${appChunkMatch[1]}`;
      const chunkResponse = await fetch(chunkUrl);
      if (!chunkResponse.ok) {
        logger.warn(`⚠️ Brevis JS chunk 请求失败: ${chunkResponse.status}`);
        return null;
      }
      const jsContent = await chunkResponse.text();

      // 3. 定位 METAMASK 描述文字块
      //    锚点也走候选表：文案换个开头时继续抓，而不是静默返回 null。
      const startMarker = COPY_START_MARKERS.find((marker) =>
        jsContent.includes(marker)
      );
      if (!startMarker) {
        logger.warn(
          `⚠️ JS bundle 中未找到 MetaMask campaign 描述（锚点全缺: ${COPY_START_MARKERS.join(" | ")}）`
        );
        return null;
      }
      const idx = jsContent.indexOf(startMarker);

      // 提取从起始锚点到结尾锚点的 JSX 块
      // 需要包含结尾的引号，否则最后一段文字无法被 regex 捕获
      const endMarker = COPY_END_MARKERS.find(
        (marker) => jsContent.indexOf(marker, idx) > idx
      );
      if (!endMarker) {
        logger.warn(
          `⚠️ JS bundle 中未找到描述文字结尾（锚点全缺: ${COPY_END_MARKERS.join(" | ")}）`
        );
        return null;
      }
      const endIdx = jsContent.indexOf(endMarker, idx);
      const block = jsContent.substring(idx, endIdx + endMarker.length);

      // 4. 从 JSX 块中提取可读文字
      //    在 minified JSX 中，文本字符串出现在三种位置：
      //    A) children:"text"              → span 子节点单值
      //    B) children:["t1","t2"]         → span 子节点数组
      //    C) }),"text"  或  ,"text",      → 顶层 children 数组中的独立字符串
      //    注意：C 中 ,"text" 与 A 中 children:"text" 的 :"text" 会重叠，
      //          所以用 children 模式优先的 OR 正则按顺序扫描
      const textParts: string[] = [];

      // block 起始是 'Eligible MetaMask Card users"}),...'
      // 提取开头文字（在第一个 " 之前的部分）
      const leadingTextEnd = block.indexOf('"');
      if (leadingTextEnd > 0) {
        const leadingText = block.substring(0, leadingTextEnd).trim();
        if (leadingText.length > 0) {
          textParts.push(leadingText);
        }
      }

      // 逐段扫描 block，按位置提取所有文字：
      // 用 OR 正则一次性匹配所有类型，保证位置顺序且不重叠
      // Group 1: children:"text"
      // Group 2: children:["text","text",...] (整个数组内容)
      // Group 3: 独立字符串 — 出现在 }), 或 ], 或 ", 之后的 "text"
      // Group 4: 紧跟在 ,"text" 后的下一个 ,"text"（无 })\]" 前导）
      const contentRe =
        /children:"([^"]*)"|children:\[([^\]]*)\]|[})\]"],\s*"([^"]*)"|,"([^"]+)"/g;
      let m;
      while ((m = contentRe.exec(block)) !== null) {
        if (m[1] !== undefined) {
          const t = m[1].trim();
          if (t.length > 0) textParts.push(t);
        } else if (m[2] !== undefined) {
          for (const im of m[2].matchAll(/"([^"]*)"/g)) {
            const t = im[1].trim();
            if (t.length > 0) textParts.push(t);
          }
        } else if (m[3] !== undefined) {
          const t = m[3].trim();
          if (t.length > 0) textParts.push(t);
        } else if (m[4] !== undefined) {
          // 过滤 JSX 语法噪音（如 (0,n.jsx)( 或 className 等）
          const t = m[4].trim();
          if (t.length > 0 && !t.includes("(0,") && !t.includes("className")) {
            textParts.push(t);
          }
        }
      }

      const description = textParts.join(" ").replace(/\s+/g, " ").trim();

      const analysis = analyzePositionCapCopy(description);

      logger.debug(
        `📋 MetaMask campaign 描述提取成功: positionCap=${analysis.capUsd} (${analysis.pattern ?? "no pattern"})`
      );
      logger.debug(`📋 完整描述: ${description}`);

      return {
        description,
        positionCap: analysis.capUsd,
        pattern: analysis.pattern,
        markerPair: `${startMarker} → ${endMarker}`,
      };
    } catch (error: any) {
      logger.warn(`⚠️ 提取 MetaMask campaign 描述失败: ${error.message}`);
      return null;
    }
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
    submitContracts: Map<
      string,
      {
        submitAddr: string;
        submitChainId: number;
        tokenAddr: string;
        decimals: number;
        chainId: number;
      }
    >;
  }> {
    try {
      logger.info("📡 从 gRPC 获取所有 protocols 列表...");

      // 0. 并行获取 MetaMask campaign 描述（不阻塞主流程）
      const metaMaskDescPromise = this.fetchMetaMaskCampaignDescription();

      // 1. 获取所有 protocols（保存原始响应）
      const protocolsResult = await this.getAllProtocolsList();
      const allProtocols = protocolsResult.protocols || [];
      const rawProtocolsList = protocolsResult.raw;

      // 2. 过滤出 Aave 相关的 protocols（name 中包含 "aave"）
      const aaveProtocols = allProtocols.filter((p: any) =>
        p.name?.toLowerCase().includes("aave")
      );

      logger.info(
        `🔍 找到 ${aaveProtocols.length} 个 Aave protocols（共 ${allProtocols.length} 个 protocols）`
      );

      // 3. 对每个 Aave protocol 获取详情（保存原始响应）
      const metaMaskDesc = await metaMaskDescPromise;
      const campaignsIndex: Record<string, BrevisDataItem> = {};
      const rawProtocolDetails: Array<{ protocol: any; response: any }> = [];
      const submitContracts = new Map<
        string,
        {
          submitAddr: string;
          submitChainId: number;
          tokenAddr: string;
          decimals: number;
          chainId: number;
        }
      >();

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
            const normalizedTotalReward = this.normalizeTokenAmount(
              tokenAmt?.totalAmt,
              token?.decimals
            );
            const normalizedTotalRewardNumber = normalizedTotalReward
              ? Number(normalizedTotalReward)
              : undefined;
            const campaignStatus =
              typeof campaign?.status === "number" ? campaign.status : 0;

            // 构建 link
            const link =
              protocol.id && protocol.chainId && type
                ? `${this.frontendUrl}/campaign/?pool_id=${protocol.id}&type=${type}&chainId=${protocol.chainId}`
                : "";

            // protocol.apr 为年化比例（如 0.024 = 2.4%/年）；与 Aave/Merkl 内存口径一致
            const apr = protocol?.apr || 0;
            const endTime = config?.end || 0;
            const now = Math.floor(Date.now() / 1000);

            if (campaignStatus !== 4 && campaignStatus !== 5) {
              continue;
            }

            const isEnded = campaignStatus === 5;
            if (isEnded) {
              const endTimeIso =
                endTime > 0
                  ? new Date(endTime * 1000).toISOString()
                  : undefined;
              if (
                !isWithinLookbackWindow(
                  endTimeIso,
                  Date.now(),
                  BREVIS_ENDED_LOOKBACK_DAYS
                )
              ) {
                continue;
              }
            }

            const tokenAddressLower =
              typeof token?.addr === "string"
                ? token.addr.trim().toLowerCase()
                : "";
            // 与 Aave reserve 合并只按 underlying token 地址匹配，无 addr 则跳过（不用 pool id 占位）
            if (!tokenAddressLower) {
              continue;
            }

            // 抓来的文案属于 MetaMask Card 这一族；别的族若继承同一个 cap，
            // 就是拿 A 的持仓上限去砍 B 的收益。
            const campaignName =
              typeof config?.name === "string" ? config.name : undefined;
            const isMetaMaskFamily = isMetaMaskCampaignFamily(campaignName);
            const campaignCopy = isMetaMaskFamily ? metaMaskDesc : null;
            if (
              isMetaMaskFamily &&
              metaMaskDesc &&
              metaMaskDesc.positionCap == null
            ) {
              logger.warn(
                `⚠️ Brevis MetaMask 文案未解析出 position cap（句式 ${metaMaskDesc.pattern ?? "none"}，锚点 ${metaMaskDesc.markerPair}），本次按无 cap 处理`,
                {
                  event: "brevis_position_cap_extraction_failed",
                  campaignId: String(campaign?.id ?? ""),
                  campaignName,
                  chainId: protocol?.chainId,
                  snippet: metaMaskDesc.description.slice(0, 240),
                }
              );
            }
            if (!isMetaMaskFamily && metaMaskDesc) {
              logger.info(
                `ℹ️ Brevis campaign「${campaignName ?? "unnamed"}」不属于 MetaMask 族，未套用抓取的文案与 position cap`,
                {
                  event: "brevis_campaign_family_without_copy",
                  campaignId: String(campaign?.id ?? ""),
                  chainId: protocol?.chainId,
                }
              );
            }

            // 构建 campaign item；budget* 仅供 fetchBrevisAprs 算 totalBudget，enrich 后剥离
            const campaignItem: BrevisCampaignItem = {
              link,
              ...(typeof config?.name === "string" &&
              config.name.trim().length > 0
                ? { name: config.name.trim() }
                : {}),
              // METAMASK campaigns: 附加从前端 JS bundle 提取的描述和 position cap
              ...(campaignCopy
                ? {
                    message: campaignCopy.description,
                  }
                : {}),
              breakdowns: [
                {
                  campaignApr: apr,
                  campaignStartedAt: new Date(
                    (config?.start || 0) * 1000
                  ).toISOString(),
                  campaignEndedAt: new Date(
                    (config?.end || 0) * 1000
                  ).toISOString(),
                  campaignId: String(campaign.id),
                  // Brevis has no Dutch auction or MAX reward mechanism — all campaigns are fixed APR + fixed budget.
                  // gRPC campaign.type is an action type (2001=borrow, 2002=supply, 3001=both), NOT a distribution type.
                  // If Brevis introduces non-FIX mechanisms in the future, this default needs updating.
                  campaignType:
                    "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE" as ForecastCampaignTypeLite,
                  aprCap: apr,
                  ...(typeof protocol?.tvl === "number" &&
                  Number.isFinite(protocol.tvl)
                    ? { latestTvl: protocol.tvl }
                    : {}),
                  ...(campaignCopy?.positionCap != null
                    ? {
                        positionCapUsd: campaignCopy.positionCap,
                        isCombineCap: true,
                      }
                    : {}),
                  ...(normalizedTotalRewardNumber !== undefined &&
                  Number.isFinite(normalizedTotalRewardNumber)
                    ? { budgetNormalizedAmount: normalizedTotalRewardNumber }
                    : {}),
                  ...(token?.symbol ? { rewardTokenSymbol: token.symbol } : {}),
                },
              ],
            };

            const indexKey = `${protocol.chainId}-${tokenAddressLower}`;

            if (
              campaign.id &&
              typeof campaign.submitAddr === "string" &&
              typeof campaign.submitChainId === "number"
            ) {
              submitContracts.set(String(campaign.id), {
                submitAddr: campaign.submitAddr,
                submitChainId: campaign.submitChainId,
                tokenAddr: tokenAddressLower,
                decimals:
                  typeof token?.decimals === "number" ? token.decimals : 0,
                chainId: protocol.chainId,
              });
            }

            if (!campaignsIndex[indexKey]) {
              campaignsIndex[indexKey] = {
                brevisSupplys: [],
                brevisBorrows: [],
                protocolVersion: "v3",
              };
            }

            // 根据 actionType 添加到对应的数组
            if (actionType === "supply" || actionType === "both") {
              campaignsIndex[indexKey].brevisSupplys.push(campaignItem);
            }
            if (actionType === "borrow" || actionType === "both") {
              campaignsIndex[indexKey].brevisBorrows.push(campaignItem);
            }
          }
        } catch (error: any) {
          logger.warn(
            `⚠️ 获取 protocol ${protocol.id} 详情失败: ${error.message}`
          );
          continue;
        }
      }

      // 对每个 indexKey 的 brevisSupplys 和 brevisBorrows 应用最近过期过滤
      for (const key of Object.keys(campaignsIndex)) {
        campaignsIndex[key].brevisSupplys = filterRecentExpiredBrevis(
          campaignsIndex[key].brevisSupplys
        );
        campaignsIndex[key].brevisBorrows = filterRecentExpiredBrevis(
          campaignsIndex[key].brevisBorrows
        );
      }

      const totalSupply = Object.values(campaignsIndex).reduce(
        (sum, item) => sum + item.brevisSupplys.length,
        0
      );
      const totalBorrow = Object.values(campaignsIndex).reduce(
        (sum, item) => sum + item.brevisBorrows.length,
        0
      );

      logger.info(
        `✅ 索引了 ${Object.keys(campaignsIndex).length} 个 chain-token 组合`
      );
      logger.info(
        `   Supply campaigns: ${totalSupply}, Borrow campaigns: ${totalBorrow}`
      );

      return {
        index: campaignsIndex,
        rawProtocolsList: rawProtocolsList,
        rawProtocolDetails: rawProtocolDetails,
        submitContracts,
      };
    } catch (error: any) {
      logger.error(`❌ 获取 Aave campaign 数据失败: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Brevis 不返回结构化的 position cap：数字只活在前端 campaign 文案里，所以这段文案
 * 就是契约本身（`/up to X,XXX USDC/` 一类句式）。改用有序候选表而不是单条正则，
 * 因为 Brevis 换一种说法（"capped at"、"limited to"）时，单条正则会让 cap 静默变 null，
 * 前端随即按名义 APR 显示——一个只会偏高、不会报错的失效。
 */
const POSITION_CAP_PATTERNS: ReadonlyArray<RegExp> = [
  // 最具体的先试：combined/total 一句里同时带出金额
  /(?:combined|total)[^.]{0,80}?up to \$?([\d,]+(?:\.\d+)?)\s*(?:USDC|USD)/i,
  /up to \$?([\d,]+(?:\.\d+)?)\s*(?:USDC|USD)/i,
  /(?:capped|limited)\s+(?:at|to)\s+\$?([\d,]+(?:\.\d+)?)\s*(?:USDC|USD)/i,
  /(?:cap|ceiling)\s+of\s+\$?([\d,]+(?:\.\d+)?)\s*(?:USDC|USD)/i,
  /\$?([\d,]+(?:\.\d+)?)\s*(?:USDC|USD)[^.]{0,60}?\b(?:cap|ceiling|combined)\b/i,
];

/** 命中金额附近出现这些词，才说明它在讲持仓/用户上限而不是交易量或预算。 */
const POSITION_CONTEXT_RE =
  /\b(collateral|debt|supply|borrow|position|lend(?:ing)?|per user|per wallet)\b/i;
const PER_USER_CONTEXT_RE =
  /\b(per user|per wallet|combined|collateral|debt)\b/i;
/** 超过 10 亿美金的"cap"一定是解析到了别的东西。 */
const MAX_PLAUSIBLE_CAP_USD = 1_000_000_000;

export interface PositionCapCopyAnalysis {
  /** 解析出的 cap（USD），解析不到为 null。 */
  capUsd: number | null;
  /** 命中的候选 ID（`p1`…`p5`），便于在告警里定位是哪条句式撑住的。 */
  pattern: string | null;
  /** 金额是否落在持仓口径的措辞里；false 时 cap 仍然采用，但语义存疑。 */
  hasPositionContext: boolean;
}

interface PositionCapCandidate {
  capUsd: number;
  pattern: string;
  rank: number;
  hasPositionContext: boolean;
  perUser: boolean;
  index: number;
}

/** 择优顺序：句式越具体越优先，其次看是否落在持仓口径，最后取最靠前的出现位置。 */
function isBetterCandidate(
  candidate: PositionCapCandidate,
  incumbent: PositionCapCandidate
): boolean {
  if (candidate.rank !== incumbent.rank) return candidate.rank < incumbent.rank;
  if (candidate.hasPositionContext !== incumbent.hasPositionContext) {
    return candidate.hasPositionContext;
  }
  if (candidate.perUser !== incumbent.perUser) return candidate.perUser;
  return candidate.index < incumbent.index;
}

/**
 * 解析 Brevis campaign 文案里的 position cap，并报告命中的句式与上下文。
 */
export function analyzePositionCapCopy(
  description: string
): PositionCapCopyAnalysis {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { capUsd: null, pattern: null, hasPositionContext: false };

  let best: PositionCapCandidate | null = null;

  for (const [rank, candidatePattern] of POSITION_CAP_PATTERNS.entries()) {
    const global = new RegExp(
      candidatePattern.source,
      `${candidatePattern.flags}g`
    );
    for (const match of text.matchAll(global)) {
      const amount = Number((match[1] ?? "").replace(/,/g, ""));
      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > MAX_PLAUSIBLE_CAP_USD
      ) {
        continue;
      }
      const index = match.index ?? 0;
      const window = text.slice(
        Math.max(0, index - 140),
        index + match[0].length + 140
      );
      const candidate: PositionCapCandidate = {
        capUsd: amount,
        pattern: `p${rank + 1}`,
        rank,
        hasPositionContext: POSITION_CONTEXT_RE.test(window),
        perUser: PER_USER_CONTEXT_RE.test(window),
        index,
      };
      if (best === null || isBetterCandidate(candidate, best)) best = candidate;
    }
  }

  if (best === null) {
    return { capUsd: null, pattern: null, hasPositionContext: false };
  }
  return {
    capUsd: best.capUsd,
    pattern: best.pattern,
    hasPositionContext: best.hasPositionContext,
  };
}

/**
 * 从 Brevis campaign 描述文字中提取 position cap（USD）。
 * 不限 actionType——只要描述中能匹配到 cap 就设值。
 */
export function extractPositionCapFromDescription(
  description: string
): number | null {
  return analyzePositionCapCopy(description).capUsd;
}

/**
 * 抓来的文案只属于 MetaMask Card 那一族 campaign；别的族若继承了同一个 cap，
 * 就是拿 A 的持仓上限去砍 B 的收益。
 */
export function isMetaMaskCampaignFamily(name: string | undefined): boolean {
  return /metamask/i.test(name ?? "");
}

// 导出单例实例
export const brevisApi = new BrevisApiClient();
