import type {
  RuntimeReserveData,
  ApiMeritAprEntry,
  ApiMerklOpportunityGroup,
  ApiBrevisCampaignItem,
} from '@internal/aave-shared-contracts';

/** GET /api/markets 响应形状；收益率类数字为百分数（序列化层由比例 ×100）。
 *  从 RuntimeReserveData 派生：覆写 nullable 漂移字段 + 激励子类型截断。 */
export type MarketWithSpread = Omit<
  RuntimeReserveData,
  | 'supplyApy' | 'borrowApy'
  | 'meritSupplys' | 'meritBorrows'
  | 'merklSupplys' | 'merklBorrows' | 'merklHolds'
  | 'brevisSupplys' | 'brevisBorrows'
> & {
  supplyApy?: number | null;
  borrowApy?: number | null;
  meritSupplys?: ApiMeritAprEntry[];
  meritBorrows?: ApiMeritAprEntry[];
  merklSupplys?: ApiMerklOpportunityGroup[];
  merklBorrows?: ApiMerklOpportunityGroup[];
  merklHolds?: ApiMerklOpportunityGroup[];
  brevisSupplys?: ApiBrevisCampaignItem[];
  brevisBorrows?: ApiBrevisCampaignItem[];
};

export interface MarketsResponse {
  snapshot: {
    lastUpdated: string; // ISO timestamp
    version: 'markets-v3';
    staleTimeMs: number;
    schemaFingerprint?: string; // Hash of API response field names; changes when shape changes
  };
  reserves: MarketWithSpread[];
}

// Note: ReserveRateInput and RateInputsResponse removed
// Rate-inputs are no longer a separate concept; only deficit is fetched from on-chain
// and merged into MarketWithSpread.deficit
