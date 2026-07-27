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
 * 清理 schema 名称：移除泛型尖括号等在 OpenAPI 3.1 $ref 中不安全的字符。
 * ts-json-schema-generator 会生成类似 "CampaignGroup<ApiMeritCampaignBreakdown>" 的名称，
 * 其中尖括号在 $ref URL 中会被编码为 %3C/%3E，导致 openapi-zod-client 无法解析。
 */
function sanitizeSchemaName(name: string): string {
  return name.replace(/[<>]/g, "");
}

/**
 * 递归遍历 JSON 对象，执行两个变换：
 * 1. 将所有 $ref 从 "#/definitions/..." 重写为 "#/components/schemas/..."
 * 2. 清理 $ref 中的 schema 名称（移除尖括号）
 * ts-json-schema-generator 默认使用 JSON Schema 的 #/definitions/ 格式，
 * 而 OpenAPI 3.1 要求 #/components/schemas/ 格式。
 */
function rewriteRefs(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(rewriteRefs);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const rewritten = value.replace(
        /^#\/definitions\//,
        "#/components/schemas/"
      );
      // 清理 $ref 中的 schema 名称（处理 URL 编码的尖括号）
      result[key] = rewritten
        .replace(/%3C/g, "")
        .replace(/%3E/g, "")
        .replace(/<([^>]*)>/g, "$1");
    } else {
      result[key] = rewriteRefs(value);
    }
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

// 合并所有 definitions
const allDefinitions: Record<string, unknown> = {
  ...extractDefinitions(marketsResponseSchema),
  ...extractDefinitions(marketWithSpreadSchema),
  ...extractDefinitions(sideDataPayloadSchema),
};

// 从 MarketsResponse schema 提取顶层结构作为 $ref 目标
const marketsResponseRef = { $ref: "#/components/schemas/MarketsResponse" };
const sideDataPayloadRef = { $ref: "#/components/schemas/SideDataPayload" };

// 确保入口类型在 definitions 中
if (marketsResponseSchema.$ref) {
  allDefinitions.MarketsResponse = marketsResponseSchema;
}
if (!allDefinitions.MarketWithSpread && marketWithSpreadSchema.properties) {
  allDefinitions.MarketWithSpread = marketWithSpreadSchema;
}
if (!allDefinitions.SideDataPayload) {
  allDefinitions.SideDataPayload = sideDataPayloadSchema;
}

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
    schemas: Object.fromEntries(
      Object.entries({
        MarketsErrorResponse: marketsErrorResponse,
        ...allDefinitions,
      }).map(([name, schema]) => [sanitizeSchemaName(name), schema])
    ),
  },
};

// ============================================================
// 写入文件
// ============================================================

// 重写 $ref 路径：#/definitions/ → #/components/schemas/
const finalSpec = rewriteRefs(spec) as typeof spec;

const outPath = new URL("../static/openapi.json", import.meta.url);
mkdirSync(new URL("../static", import.meta.url), { recursive: true });
writeFileSync(outPath, JSON.stringify(finalSpec, null, 2) + "\n");

console.log(`✅ OpenAPI spec written to ${outPath.pathname}`);
