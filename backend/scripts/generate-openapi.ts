/**
 * 从后端类型体系生成 OpenAPI 3.1 规范文件。
 *
 * 原则：
 *  - 只文档化 serializeReserveForApi() 实际输出的字段（不假设、不抄袭前端 spec）
 *  - SEO / health 等内部/运维端点不纳入公开 API 文档
 *  - 生成产物写入 backend/static/openapi.json
 *
 * 用法：npx --no-install tsx scripts/generate-openapi.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';

// OpenAPI 3.1 类型定义（精简子集，仅覆盖本项目所需）
interface OpenAPISpec {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

// ============================================================
// Reserve 字段定义 —— 与 serializeReserveForApi() 的实际输出严格一致
// ============================================================

const RESERVE_PROPERTIES: Record<string, unknown> = {
  // --- 必填字段（始终返回） ---
  reserveId:     { type: 'string' },
  marketName:    { type: 'string' },
  chainName:     { type: 'string' },
  chainId:       { type: 'number' },
  tokenName:     { type: 'string' },
  tokenSymbol:   { type: 'string' },
  tokenAddress:  { type: 'string' },

  // --- 透传区（pickDefined: 有值时才出现） ---
  tokenPrice:         { type: 'number' },
  utilizationPct:     { type: 'number' },
  aTokenAddress:      { type: 'string', nullable: true },
  vTokenAddress:      { type: 'string', nullable: true },
  supplied:           { type: 'string' },
  borrowed:           { type: 'string' },
  liquidity:          { type: 'string' },
  supplyCap:          { type: 'string' },
  borrowCap:          { type: 'string' },
  deficit:            { type: 'string' },
  hubId:              { type: 'string' },
  hubName:            { type: 'string' },
  spokeId:            { type: 'string' },
  spokeName:          { type: 'string' },

  // --- 布尔开关区（仅 true 时出现） ---
  supplyDisabled:     { type: 'boolean' },
  borrowDisabled:     { type: 'boolean' },
  isFrozen:           { type: 'boolean' },
  isPaused:           { type: 'boolean' },
  isActive:           { type: 'boolean', description: 'Always false when present' },

  // --- 条件字段 ---
  aaveProReserveId:   { type: 'string' },
  decimals:           { type: 'number', description: 'Present when !== 18' },

  // --- 变换区（比例 ×100, roundTo6） ---
  supplyApy:          { type: 'number', nullable: true },
  borrowApy:          { type: 'number', nullable: true },
  protocolFee:        { type: 'number' },
  slopeBelowOptimal:  { type: 'number' },
  slopeAboveOptimal:  { type: 'number' },
  optimalUtilization: { type: 'number' },
  baseBorrowRate:     { type: 'number' },
  collateralRisk:     { type: 'number' },

  // --- 覆写区：激励数组 ---
  meritSupplys:   { type: 'array', items: { $ref: '#/components/schemas/MeritCampaignGroup' } },
  meritBorrows:   { type: 'array', items: { $ref: '#/components/schemas/MeritCampaignGroup' } },
  merklSupplys:   { type: 'array', items: { $ref: '#/components/schemas/MerklOpportunityGroup' } },
  merklBorrows:   { type: 'array', items: { $ref: '#/components/schemas/MerklOpportunityGroup' } },
  merklHolds:     { type: 'array', items: { $ref: '#/components/schemas/MerklOpportunityGroup' } },
  brevisSupplys:  { type: 'array', items: { $ref: '#/components/schemas/BrevisCampaignItem' } },
  brevisBorrows:  { type: 'array', items: { $ref: '#/components/schemas/BrevisCampaignItem' } },
};

const RESERVE_REQUIRED = [
  'reserveId', 'marketName', 'chainName', 'chainId',
  'tokenName', 'tokenSymbol', 'tokenAddress',
];

// ============================================================
// 子类型 schema 定义
// ============================================================

const meritCampaignBreakdown = {
  type: 'object',
  properties: {
    campaignApr:        { type: 'number' },
    campaignStartedAt:  { type: 'string' },
    campaignEndedAt:    { type: 'string' },
    campaignId:         { type: 'string' },
    campaignType:       { type: 'string' },
    positionCap:        { type: 'number' },
    message:            { type: 'string' },
    aprCap:             { type: 'number' },
    rewardTokenSymbol:  { type: 'string' },
    totalBudget:        { type: 'number' },
    latestTvl:          { type: 'number' },
  },
  required: ['campaignApr', 'campaignStartedAt', 'campaignEndedAt', 'campaignId'],
};

const meritCampaignGroup = {
  type: 'object',
  properties: {
    link:       { type: 'string' },
    name:       { type: 'string' },
    message:    { type: 'string' },
    breakdowns: { type: 'array', items: meritCampaignBreakdown },
  },
  required: ['breakdowns'],
};

const merklBreakdown = {
  type: 'object',
  properties: {
    campaignApr:        { type: 'number' },
    campaignStartedAt:  { type: 'string' },
    campaignEndedAt:    { type: 'string' },
    campaignId:         { type: 'string' },
    whitelistOnly:       { type: 'boolean' },
    pointsPerThousandUsd: { type: 'number' },
    rewardTokenSymbol:   { type: 'string' },
    rewardTokenIconUrl:  { type: 'string' },
    campaignType:        { type: 'string' },
    totalBudget:         { type: 'number' },
    aprCap:              { type: 'number', nullable: true },
    latestTvl:           { type: 'number' },
    plannedDaily:        { type: 'number' },
  },
  required: ['campaignApr', 'campaignStartedAt', 'campaignEndedAt', 'campaignId'],
};

const merklOpportunityGroup = {
  type: 'object',
  properties: {
    link:       { type: 'string' },
    name:       { type: 'string' },
    message:    { type: 'string' },
    breakdowns: { type: 'array', items: merklBreakdown },
    opportunityType: { type: 'string' },
    netPositionConstraint: {
      type: 'object',
      properties: {
        sourceSide:       { type: 'string', enum: ['supply', 'borrow'] },
        offsetReserveIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['sourceSide', 'offsetReserveIds'],
      nullable: true,
    },
  },
  required: ['breakdowns'],
};

const brevisBreakdown = {
  type: 'object',
  properties: {
    campaignApr:        { type: 'number' },
    campaignStartedAt:  { type: 'string' },
    campaignEndedAt:    { type: 'string' },
    campaignId:         { type: 'string' },
    totalBudget:        { type: 'number' },
    latestTvl:          { type: 'number' },
    positionCap:        { type: 'number' },
  },
  required: ['campaignApr', 'campaignStartedAt', 'campaignEndedAt'],
};

const brevisCampaignItem = {
  type: 'object',
  properties: {
    link:       { type: 'string' },
    name:       { type: 'string' },
    message:    { type: 'string' },
    breakdowns: { type: 'array', items: brevisBreakdown },
    // 扁平化 variant（无 breakdowns 的旧格式）
    campaignApr:        { type: 'number' },
    campaignStartedAt:  { type: 'string' },
    campaignEndedAt:    { type: 'string' },
    campaignId:         { type: 'string' },
    totalBudget:        { type: 'number' },
    latestTvl:          { type: 'number' },
    positionCap:        { type: 'number' },
  },
  required: ['link'],
};

// ============================================================
// 端点 response schema
// ============================================================

const marketsErrorResponse = {
  type: 'object',
  properties: {
    errorCode: { type: 'string', enum: ['MARKETS_SNAPSHOT_NOT_READY', 'MARKETS_SNAPSHOT_STALE'] },
    error:     { type: 'string' },
    message:   { type: 'string' },
  },
  required: ['errorCode', 'error', 'message'],
};

const marketsResponse = {
  type: 'object',
  properties: {
    snapshot: {
      type: 'object',
      properties: {
        lastUpdated:  { type: 'string' },
        version:      { type: 'string' },
        staleTimeMs:  { type: 'number' },
        schemaFingerprint:       { type: 'string' },
        deficitFallbackReserveIds: { type: 'array', items: { type: 'string' } },
        v4FallbackReserveIds:    { type: 'array', items: { type: 'string' } },
        stale:                   { type: 'boolean' },
        staleAgeMs:              { type: 'number', nullable: true },
      },
      required: ['lastUpdated'],
    },
    reserves: {
      type: 'array',
      items: {
        type: 'object',
        properties: RESERVE_PROPERTIES,
        required: RESERVE_REQUIRED,
      },
    },
  },
  required: ['snapshot', 'reserves'],
};

const sideDataMetaResponse = {
  type: 'object',
  properties: {
    generatedAt: { type: 'string' },
    partial:     { type: 'boolean' },
    categories: {
      type: 'object',
      properties: {
        uniqueSymbolsStablecoins: { type: 'array', items: { type: 'string' } },
        uniqueSymbolsEth:         { type: 'array', items: { type: 'string' } },
        fetchedAt:                { type: 'string' },
        staleTimeMs:              { type: 'number' },
      },
      required: ['uniqueSymbolsStablecoins', 'uniqueSymbolsEth', 'fetchedAt', 'staleTimeMs'],
    },
    fdv: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string', nullable: true },
              fdvUsd: { type: 'number', nullable: true },
            },
            required: ['symbol', 'fdvUsd'],
          },
        },
        fetchedAt:   { type: 'string' },
        staleTimeMs: { type: 'number' },
      },
      required: ['items', 'fetchedAt', 'staleTimeMs'],
    },
    forecast: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              campaignId:      { type: 'string' },
              requiredDaily:   { type: 'number' },
              distributedSoFar: { type: 'number' },
              endTimestamp:    { type: 'number' },
            },
            required: ['campaignId', 'distributedSoFar', 'endTimestamp'],
          },
        },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              campaignId: { type: 'string' },
              status:     { type: 'number' },
              message:    { type: 'string' },
            },
            required: ['campaignId', 'message'],
          },
        },
        staleTimeMs: { type: 'number' },
      },
      required: ['items', 'errors', 'staleTimeMs'],
    },
    campaignAccess: {
      type: 'object',
      properties: {
        campaigns: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              chainId:   { type: 'number' },
              whitelist: { type: 'array', items: { type: 'string' } },
              blacklist: { type: 'array', items: { type: 'string' } },
              borrowHookProtocols: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    protocol: { type: 'number' },
                    borrowBytesLike: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['protocol', 'borrowBytesLike'],
                },
              },
            },
            required: ['chainId', 'whitelist', 'blacklist'],
          },
        },
        updatedAt: { type: 'string' },
      },
      required: ['campaigns', 'updatedAt'],
    },
  },
};

// ============================================================
// 组装完整 spec
// ============================================================

const spec: OpenAPISpec = {
  openapi: '3.1.0',
  info: {
    title: 'AaveAPY API',
    version: '1.0.0',
    description: 'Aave market data and yield analysis API',
  },
  servers: [
    { url: 'https://staging-api.aaveapy.com/api', description: 'Staging' },
    { url: 'https://api.aaveapy.com/api', description: 'Production' },
  ],
  paths: {
    '/markets': {
      get: {
        operationId: 'getMarkets',
        summary: 'Get all markets with reserve data',
        responses: {
          '200': {
            description: 'Market snapshot and reserve array',
            content: { 'application/json': { schema: marketsResponse } },
          },
          '429': {
            description: 'Rate limit exceeded (120 requests/min per IP)',
            headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry' } },
          },
          '503': {
            description: 'Service unavailable — data not ready or too stale',
            headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry (10=loading, 60=stale)' } },
            content: { 'application/json': { schema: marketsErrorResponse } },
          },
        },
      },
    },
    '/meta/side-data': {
      get: {
        operationId: 'getMetaSideData',
        summary: 'Get metadata including categories, FDV, and forecast',
        responses: {
          '200': {
            description: 'Side data response',
            content: { 'application/json': { schema: sideDataMetaResponse } },
          },
          '429': {
            description: 'Rate limit exceeded (120 requests/min per IP)',
            headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry' } },
          },
          '503': {
            description: 'Service unavailable — data not ready or too stale',
            headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry (10=loading, 60=stale)' } },
            content: { 'application/json': { schema: marketsErrorResponse } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      MarketsResponse: marketsResponse,
      MarketsErrorResponse: marketsErrorResponse,
      SideDataMetaResponse: sideDataMetaResponse,
      Reserve: {
        type: 'object',
        properties: RESERVE_PROPERTIES,
        required: RESERVE_REQUIRED,
      },
      MeritCampaignBreakdown: meritCampaignBreakdown,
      MeritCampaignGroup: meritCampaignGroup,
      MerklCampaignBreakdown: merklBreakdown,
      MerklOpportunityGroup: merklOpportunityGroup,
      BrevisCampaignBreakdown: brevisBreakdown,
      BrevisCampaignItem: brevisCampaignItem,
    },
  },
};

// ============================================================
// 写入文件
// ============================================================

const outPath = new URL('../static/openapi.json', import.meta.url);
mkdirSync(new URL('../static', import.meta.url), { recursive: true });
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');

console.log(`✅ OpenAPI spec written to ${outPath.pathname}`);