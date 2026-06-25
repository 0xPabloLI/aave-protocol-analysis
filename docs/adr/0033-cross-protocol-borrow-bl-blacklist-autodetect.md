# ADR-0033: 跨协议 BORROW_BL offset 与 blacklist 自动识别

Date: 2026-06-25

## Status: Implemented

## Related Issues

- [AAV-958](https://linear.app/aaveapy/issue/AAV-958) — 处理 Merkl 跨协议 BORROW_BL 的 offset 和 blacklist 自动识别
- [AAV-1010](https://linear.app/aaveapy/issue/AAV-1010) — borrowBlacklist 增强：从 params.blacklist + hookType=14 自动推断
- [AAV-1011](https://linear.app/aaveapy/issue/AAV-1011) — MerklCampaignAccess 扩展：存储 hooks 中的 borrowBytesLike 信息

## Context

Merkl opportunity 9623615825108171573（Lend USDtb on Aave, Ethereum）的 campaign 包含跨协议 borrow 排除规则：
- 4 个 `hookType=14` 条目，指向不同 protocol 的 borrow 市场
- 5 个 `params.blacklist` 地址（被排除的协议/市场合约）
- 描述："Borrowers of USDtb on **any** Ethereum-based market or protocol are not eligible for rewards"

现有代码的两个不足：
1. `borrowBlacklist` 仅从 `identifier.includes('BORROW_BL')` 检测，未利用 `params.blacklist` + `hookType=14` 的组合语义
2. `MerklCampaignAccess` 不存储 `borrowBytesLike` 信息，前端无法展示"哪些协议的 borrow 会导致 incentive 归零"

## Decision

### D1: BORROW_BL offset 不扩展 offsetReserveIds

`borrowBytesLike` 中的地址是**其他协议**（如 Spark、Morpho）的合约地址，不在 Aave reserveIdSet 中。即使扩展 `resolveOffsetReserveIds` 也无法映射到 Aave reserve。

`borrowBlacklist: true` 已经充分表达了"有 borrow → incentive 归零"的二元排除语义，与 `offsetReserveIds` 的按比例抵消语义正交。无需在 offsetReserveIds 中包含跨协议 reserve。

### D2: borrowBlacklist 增强检测

扩展 borrowBlacklist 检测规则：

```typescript
const isBorrowBl = (opp.identifier?.includes('BORROW_BL') ?? false) || hasBlacklistWithBorrowHook(opp);
```

`hasBlacklistWithBorrowHook` 逻辑：遍历 opportunity 的所有 campaign，当某个 campaign 的 `params.blacklist` 非空且 `params.hooks` 包含 `hookType=14` 时返回 true。

这确保了即使 identifier 不含 BORROW_BL 后缀，只要有跨协议 borrow 排除规则（blacklist + hookType=14），borrowBlacklist 也能被自动识别。

### D3: borrowBytesLike 信息存储到 MerklCampaignAccess

扩展 `MerklCampaignAccess` 类型，新增可选字段：

```typescript
export interface MerklBorrowHookProtocol {
  protocol: number;
  borrowBytesLike: string[];
}

export interface MerklCampaignAccess {
  campaignId: string;
  chainId: number;
  whitelist: string[];
  blacklist: string[];
  borrowHookProtocols?: MerklBorrowHookProtocol[];  // 新增
}
```

`extractBorrowHookProtocols(hooks)` 从 campaign params.hooks 提取所有 hookType=14 条目的 protocol 和 borrowBytesLike。

## 实际数据：USDtb Campaign 1575990960628026476

| hook | protocol | borrowBytesLike 数量 | 说明 |
|---|---|---|---|
| 0 | 2 | 1 | 某协议的 1 个 borrow 市场 |
| 1 | 1 | 2 | 某协议的 2 个 borrow 市场 |
| 2 | 0 | 3 (bytes32 hash) | Aave 自身的 borrow 市场 |
| 3 | 3 | 5 | 某协议的 5 个 borrow 市场 |

`params.blacklist` 5 个地址：被排除的协议/市场合约。

identifier: `0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8BORROW_BL`（包含 BORROW_BL 后缀）

## Consequences

- borrowBlacklist 检测覆盖率提高：identifier + blacklist+hookType=14 双路径
- API 消费者可通过 `MerklCampaignAccess.borrowHookProtocols` 了解跨协议 borrow 排除细节
- `offsetReserveIds` 行为不变：BORROW_BL 是二元排除，不按比例抵消
- 向后兼容：`borrowHookProtocols` 为可选字段，旧消费者不受影响

## References

- ADR-0032: borrowBlacklist at CampaignGroup level + offsetLevel default 'spoke'
- ADR-0023: netPositionConstraint 检测架构
- `packages/aave-fetcher/src/merkl-api.ts`: `hasBlacklistWithBorrowHook`, `extractBorrowHookProtocols`
- `packages/aave-shared-contracts/src/index.ts`: `MerklBorrowHookProtocol`, `MerklCampaignAccess`
