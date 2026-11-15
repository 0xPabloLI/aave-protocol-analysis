import type {
  RuntimeReserveData,
  ApiMerklOpportunityGroup,
  ApiBrevisCampaignItem,
} from "@internal/aave-shared-contracts";

/** GET /api/markets 响应形状；收益率类数字为百分数（序列化层由比例 ×100）。
 *  从 RuntimeReserveData 派生：覆写 nullable 漂移字段 + 激励子类型截断。 */
export type MarketWithSpread = Omit<
  RuntimeReserveData,
  | "supplyApy"
  | "borrowApy"
  | "merklSupplys"
  | "merklBorrows"
  | "merklHolds"
  | "brevisSupplys"
  | "brevisBorrows"
> & {
  supplyApy?: number | null;
  borrowApy?: number | null;
  merklSupplys?: ApiMerklOpportunityGroup[];
  merklBorrows?: ApiMerklOpportunityGroup[];
  merklHolds?: ApiMerklOpportunityGroup[];
  brevisSupplys?: ApiBrevisCampaignItem[];
  brevisBorrows?: ApiBrevisCampaignItem[];
};

/**
 * `GET /api/markets` 的版本号，破坏性字段变更（改名/删字段）时递增。
 *
 * 放在这里而不是 controller：常量要能被测试直接读取，而 controller 会拉起
 * `marketsService` → `@aave/client-v4`，其 `.d.ts` 在 tsx 下单跑解析不了
 * （AAV-1378）。这里是纯类型模块，加载零副作用。
 */
export const MARKETS_API_VERSION = "snapshot-v3";

export interface MarketsResponse {
  snapshot: {
    lastUpdated: string; // ISO timestamp
    version: typeof MARKETS_API_VERSION;
    staleTimeMs: number;
    schemaFingerprint?: string; // Hash of API response field names; changes when shape changes
    deficitFallbackReserveIds: string[]; // ReserveIds where deficit fell back to '0' (no onchain data)
    v4FallbackReserveIds?: string[]; // ReserveIds whose V4 data came from RPC fallback
    stale?: boolean; // true when snapshot exceeds hardTtl (data still served but marked stale)
    staleAgeMs?: number | null; // age in ms when stale=true
  };
  reserves: MarketWithSpread[];
}

// Note: ReserveRateInput and RateInputsResponse removed
// Rate-inputs are no longer a separate concept; only deficit is fetched from on-chain
// and merged into MarketWithSpread.deficit
