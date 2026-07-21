/**
 * 从后端 TypeScript API 层类型自动生成 OpenAPI 3.1 规范文件。
 *
 * 原理：
 *  - 使用 ts-json-schema-generator 从 TypeScript interface/type 自动推导 JSON Schema
 *  - 入口类型：MarketWithSpread, MarketsResponse, SideDataPayload
 *  - 429/503 response metadata 保留手写模板（零变更历史，不纳入自动生成）
 *  - 生成产物写入 backend/static/openapi.json
 *
 * 用法：npx --no-install tsx scripts/generate-openapi.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createGenerator } from "ts-json-schema-generator";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// TypeScript → JSON Schema 自动生成
// ============================================================

const SHARED_CONTRACTS_PATH = resolve(
  __dirname,
  "../../packages/aave-shared-contracts/src/index.ts"
);
const BACKEND_TYPES_PATH = resolve(__dirname, "../src/types/index.ts");
const TSCONFIG_PATH = resolve(__dirname, "../tsconfig.json");

/** 为指定类型生成 JSON Schema（含 definitions） */
function generateSchemaForType(
  sourcePath: string,
  typeName: string
): Record<string, unknown> {
  const generator = createGenerator({
    path: sourcePath,
    tsconfig: TSCONFIG_PATH,
    type: typeName,
    expose: "export",
    jsDoc: "extended",
    functions: "hide",
    skipTypeCheck: true,
  });
  const schema = generator.createSchema(typeName);
  return schema as Record<string, unknown>;
}

/** 从 schema 中提取 definitions 和顶层数据 */
function extractDefinitions(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return (schema.definitions ?? {}) as Record<string, unknown>;
}

/**
 * 将 JSON Schema 的 #/definitions/ 引用重写为 OpenAPI 3.1 的 #/components/schemas/ 引用。
 * ts-json-schema-generator 输出 #/definitions/（JSON Schema 标准），
 * OpenAPI 3.1 期望 #/components/schemas/。
 * 同时处理 URL 编码的泛型类型名（如 CampaignGroup%3C...%3E → CampaignGroup<...>）。
 */
function rewriteRefs(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(
      /#\/definitions\/(.+)/,
      (_, name) => `#/components/schemas/${decodeURIComponent(name)}`
    );
  }
  if (Array.isArray(obj)) {
    return obj.map(rewriteRefs);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = rewriteRefs(value);
    }
    return result;
  }
  return obj;
}

/** 对 definitions 的 key 进行 URL 解码（ts-json-schema-generator 会编码泛型尖括号） */
function decodeDefinitionKeys(
  defs: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defs)) {
    result[decodeURIComponent(key)] = rewriteRefs(value);
  }
  return result;
}

// 为各入口类型生成 schema
const marketsResponseSchema = generateSchemaForType(
  BACKEND_TYPES_PATH,
  "MarketsResponse"
);
const marketWithSpreadSchema = generateSchemaForType(
  BACKEND_TYPES_PATH,
  "MarketWithSpread"
);
const sideDataPayloadSchema = generateSchemaForType(
  SHARED_CONTRACTS_PATH,
  "SideDataPayload"
);

// 合并所有 definitions（重写 $ref 并解码泛型 key）
const allDefinitions: Record<string, unknown> = {
  ...decodeDefinitionKeys(extractDefinitions(marketsResponseSchema)),
  ...decodeDefinitionKeys(extractDefinitions(marketWithSpreadSchema)),
  ...decodeDefinitionKeys(extractDefinitions(sideDataPayloadSchema)),
};

/**
 * 重命名泛型类型名（如 CampaignGroup<ApiMeritCampaignBreakdown>）
 * 为简单的非泛型名称（如 ApiMeritCampaignGroup），
 * 因为 OpenAPI/JSON Schema 规范不支持泛型语法，
 * 且下游工具（openapi-zod-client）无法处理 `<>` 字符。
 */
const GENERIC_NAME_MAP: Record<string, string> = {
  "CampaignGroup<ApiMeritCampaignBreakdown>": "ApiMeritCampaignGroup",
  "CampaignGroup<ApiBrevisBreakdown>": "ApiBrevisCampaignItem",
};

function renameGenericTypes(
  defs: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defs)) {
    const newKey = GENERIC_NAME_MAP[key] ?? key;
    // Replace any $ref that points to the old generic name
    const rewritten = JSON.parse(
      JSON.stringify(value).replace(
        /#\/components\/schemas\/CampaignGroup%3C([^%]+)%3E/g,
        (_, inner) => {
          const oldName = `CampaignGroup<${inner}>`;
          const newName = GENERIC_NAME_MAP[oldName] ?? oldName;
          return `#/components/schemas/${newName}`;
        }
      )
    );
    result[newKey] = rewritten;
  }
  return result;
}

// 确保入口类型在 definitions 中（重写 $ref）
if (marketsResponseSchema.$ref) {
  allDefinitions.MarketsResponse = rewriteRefs(marketsResponseSchema);
}
if (!allDefinitions.MarketWithSpread && marketWithSpreadSchema.properties) {
  allDefinitions.MarketWithSpread = rewriteRefs(marketWithSpreadSchema);
}
if (!allDefinitions.SideDataPayload) {
  allDefinitions.SideDataPayload = rewriteRefs(sideDataPayloadSchema);
}

// 应用泛型重命名（在入口类型添加后）
const finalDefinitions = renameGenericTypes(allDefinitions);

// 从 MarketsResponse schema 提取顶层结构作为 $ref 目标
const marketsResponseRef = { $ref: "#/components/schemas/MarketsResponse" };
const sideDataPayloadRef = { $ref: "#/components/schemas/SideDataPayload" };

// ============================================================
// Response metadata 模板（手写，零变更历史）
// ============================================================

const rateLimitResponse = {
  description: "Rate limit exceeded (120 requests/min per IP)",
  headers: {
    "Retry-After": {
      schema: { type: "integer" },
      description: "Seconds until retry",
    },
  },
};

const serviceUnavailableResponse = (schemaRef: Record<string, unknown>) => ({
  description: "Service unavailable — data not ready or too stale",
  headers: {
    "Retry-After": {
      schema: { type: "integer" },
      description: "Seconds until retry (10=loading, 60=stale)",
    },
  },
  content: { "application/json": { schema: schemaRef } },
});

const marketsErrorResponse = {
  type: "object",
  properties: {
    errorCode: {
      type: "string",
      enum: ["MARKETS_SNAPSHOT_NOT_READY", "MARKETS_SNAPSHOT_STALE"],
    },
    error: { type: "string" },
    message: { type: "string" },
  },
  required: ["errorCode", "error", "message"],
};

// ============================================================
// 组装完整 OpenAPI spec
// ============================================================

const spec = {
  openapi: "3.1.0",
  info: {
    title: "AaveAPY API",
    version: "1.0.0",
    description: "Aave market data and yield analysis API",
  },
  servers: [
    { url: "https://staging-api.aaveapy.com/api", description: "Staging" },
    { url: "https://api.aaveapy.com/api", description: "Production" },
  ],
  paths: {
    "/markets": {
      get: {
        operationId: "getMarkets",
        summary: "Get all markets with reserve data",
        responses: {
          "200": {
            description: "Market snapshot and reserve array",
            content: {
              "application/json": { schema: marketsResponseRef },
            },
          },
          "429": rateLimitResponse,
          "503": serviceUnavailableResponse(marketsErrorResponse),
        },
      },
    },
    "/meta/side-data": {
      get: {
        operationId: "getMetaSideData",
        summary: "Get metadata including categories, FDV, and forecast",
        responses: {
          "200": {
            description: "Side data response",
            content: {
              "application/json": { schema: sideDataPayloadRef },
            },
          },
          "429": rateLimitResponse,
          "503": serviceUnavailableResponse(marketsErrorResponse),
        },
      },
    },
  },
  components: {
    schemas: {
      MarketsErrorResponse: marketsErrorResponse,
      ...finalDefinitions,
    },
  },
};

// ============================================================
// 写入文件
// ============================================================

const outPath = new URL("../static/openapi.json", import.meta.url);
mkdirSync(new URL("../static", import.meta.url), { recursive: true });
writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n");

console.log(`✅ OpenAPI spec written to ${outPath.pathname}`);
