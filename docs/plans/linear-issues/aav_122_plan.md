# AAV-122 实施方案：API 响应体积优化

## 目标
在 gzip 已有 90% 压缩率基础上，通过 APY/APR 精度截断 + `protocolFee` 零值省略，减少 JSON 原始体积 ~70-140KB（gzip 后 ~3-8KB），消除浮点伪精度尾数。

## 前置结论

| 方案 | 决定 | 理由 |
|------|------|------|
| protobuf | 废弃 | gzip 后仅额外省 5-10KB/请求，双仓库高风险改造 |
| 分链接口 | 废弃 | 前端单次 fetch + 按链 filter 已够用，分链需改 9 处 |
| IncentiveTooltip 零值过滤 | 不做 | `[0]` = 配置了激励但暂停，`[]` = 无激励配置，语义不同 |
| rate-model 字段省略 | 不做 | slope/optimal/baseBorrowRate 无合理默认值，省略→模拟错误 |
| incentive 零值元素省略 | 不做 | `[0]` vs `[]` 语义不同，IncentiveTooltip 正确区分 |

---

## Step 1：新增 `roundTo6` 工具函数

**文件**：`backend/src/services/marketsApiSerialize.ts`

在文件顶部（现有工具函数区域）新增：

```typescript
function roundTo6(n: number): number {
  return Number(n.toFixed(6));
}
```

**验证**：`roundTo6(2.073456789012345)` → `2.073456`，`roundTo6(0)` → `0`，`roundTo6(-0.5)` → `-0.5`

---

## Step 2：APY/APR 精度截断

**文件**：`backend/src/services/marketsApiSerialize.ts`

在所有 `*100` 输出处包裹 `roundTo6`：

### 2.1 supplyApy / borrowApy

```diff
- ...(reserve.supplyApy !== undefined ? { supplyApy: reserve.supplyApy * 100 } : {}),
+ ...(reserve.supplyApy !== undefined ? { supplyApy: roundTo6(reserve.supplyApy * 100) } : {}),

- ...(reserve.borrowApy !== undefined ? { borrowApy: reserve.borrowApy * 100 } : {}),
+ ...(reserve.borrowApy !== undefined ? { borrowApy: roundTo6(reserve.borrowApy * 100) } : {}),
```

### 2.2 supplyIncentives / borrowIncentives

```diff
  ...(reserve.supplyIncentives?.length
-   ? { supplyIncentives: reserve.supplyIncentives.map((x) => x * 100) }
+   ? { supplyIncentives: reserve.supplyIncentives.map((x) => roundTo6(x * 100)) }
    : {}),

  ...(reserve.borrowIncentives?.length
-   ? { borrowIncentives: reserve.borrowIncentives.map((x) => x * 100) }
+   ? { borrowIncentives: reserve.borrowIncentives.map((x) => roundTo6(x * 100)) }
    : {}),
```

### 2.3 Merit apr / selfApr

修改 `scaleMeritEntry`：

```diff
 function scaleMeritEntry<T extends { apr: number; selfApr?: number }>(e: T): T {
   return {
     ...e,
-    apr: e.apr * 100,
-    ...(e.selfApr !== undefined ? { selfApr: e.selfApr * 100 } : {}),
+    apr: roundTo6(e.apr * 100),
+    ...(e.selfApr !== undefined ? { selfApr: roundTo6(e.selfApr * 100) } : {}),
   };
 }
```

### 2.4 Merkl campaignApr / aprCap

修改 `scaleMerklBreakdown`：

```diff
- const next = { ...b, campaignApr: b.campaignApr * 100 } as T;
+ const next = { ...b, campaignApr: roundTo6(b.campaignApr * 100) } as T;

  if (Object.prototype.hasOwnProperty.call(b, 'aprCap')) {
    const cap = b.aprCap;
    (next as { aprCap?: number | null }).aprCap =
-     cap === null || cap === undefined ? cap : cap * 100;
+     cap === null || cap === undefined ? cap : roundTo6(cap * 100);
  }
```

### 2.5 Brevis campaignApr

修改 `scaleBrevisBreakdown`：

```diff
 function scaleBrevisBreakdown<T extends { campaignApr: number }>(b: T): T {
-  return { ...b, campaignApr: b.campaignApr * 100 };
+  return { ...b, campaignApr: roundTo6(b.campaignApr * 100) };
 }
```

### 2.6 rate-model 字段

在 `serializeReserveForApi` 中，对以下字段应用 `roundTo6`（这些字段在内存中已是百分数，无需 `*100`，直接 roundTo6）：

- `protocolFee`
- `slopeBelowOptimal`
- `slopeAboveOptimal`
- `optimalUtilization`
- `baseBorrowRate`

逐个确认当前代码中这些字段的输出方式，在输出处包裹 `roundTo6`。

---

## Step 3：`protocolFee` 零值省略

**文件**：`backend/src/services/marketsApiSerialize.ts`

在 `serializeReserveForApi` 中，将 `protocolFee` 的输出从无条件输出改为零值省略：

```diff
- protocolFee: reserve.protocolFee,
+ ...(reserve.protocolFee ? { protocolFee: reserve.protocolFee } : {}),
```

**前端安全**：`useRateSimulation.ts:1599` — `Number.isFinite(reserveRateInput.protocolFee) && reserveRateInput.protocolFee > 0 ? reserveRateInput.protocolFee : 0`，缺失时 fallback 0。`interestRateCalculator.ts:157` — `Math.max(0, Math.min(100, ...))` clamp [0,100]。

**Zod schema**：`protocolFee: z.number().optional()` — 已 optional，省略后 parse 为 undefined。

---

## Step 4：后端测试

**文件**：`backend/tests/marketsApiSerialize.test.ts`（新增或追加到现有测试文件）

```typescript
describe('roundTo6', () => {
  it('truncates to 6 decimal places', () => {
    expect(roundTo6(2.073456789012345)).toBe(2.073457);
    expect(roundTo6(0.123456789)).toBe(0.123457);
  });

  it('preserves exact 6-decimal values', () => {
    expect(roundTo6(2.073456)).toBe(2.073456);
  });

  it('handles zero', () => {
    expect(roundTo6(0)).toBe(0);
  });

  it('handles negative', () => {
    expect(roundTo6(-0.123456789)).toBe(-0.123457);
  });

  it('eliminates floating point artifacts', () => {
    expect(roundTo6(5.200000000000001)).toBe(5.2);
  });
});

describe('serializeReserveForApi precision', () => {
  it('supplyApy is rounded to 6 decimal places', () => {
    // 构造 supplyApy ratio = 0.02073456789
    // 期望输出 supplyApy = 2.073457 (roundTo6(0.02073456789 * 100))
  });

  it('protocolFee zero is omitted', () => {
    // 构造 protocolFee = 0
    // 期望输出中不含 protocolFee 字段
  });

  it('protocolFee non-zero is preserved', () => {
    // 构造 protocolFee = 10
    // 期望输出 protocolFee = 10
  });
});
```

---

## Step 5：验证

```bash
npm run build -w @internal/aave-shared-contracts && \
npm run build -w @internal/aave-fetcher && \
npm run build && \
npm run build -w aave-dashboard-backend && \
npm run test -w aave-dashboard-backend
```

确认：
- [ ] build 全部通过
- [ ] 后端测试全部通过
- [ ] 手动 `curl /api/markets` 验证 APY 字段最多 6 位小数
- [ ] 手动验证 `protocolFee: 0` 的 reserve 不含 `protocolFee` 字段
- [ ] 前端访问 staging 验证显示无差异

---

## 不做的事项及理由

| 事项 | 理由 |
|------|------|
| protobuf 二进制格式 | ROI 低：gzip 后仅额外省 5-10KB/请求，双仓库高风险改造 |
| 分链接口 | 过度工程：前端需改 9 处，缓存合并策略复杂 |
| IncentiveTooltip 零值过滤 | `[0]` = 有激励但暂停，`[]` = 无激励配置，语义不同 |
| slopeBelowOptimal / slopeAboveOptimal / optimalUtilization 省略 | 利率曲线核心参数，无合理默认值 |
| baseBorrowRate 零值省略 | V4/GHO 等非零资产，`?? 0` 会静默算错模拟利率 |
| supplyIncentives/borrowIncentives 零值元素省略 | `[0]` vs `[]` 语义不同 |
| 前端任何改动 | 所有后端变更前端已有防御，无需配合 |

## 精度分层参考

| 层级 | 精度 | 说明 |
|------|------|------|
| 内存/cron | ratio（JS double，完整精度） | 与 on-chain 回退计算一致 |
| API 传输 | percent，**6 位小数** | 本次优化目标 |
| 聚合持久化 | 6 位小数 | 已有 `toFixed(6)` |
| 前端显示 | 2 位小数 | `formatPercent` → `smartPercent` |
| 业界参考 | 4-6 位 | Bloomberg 4 位，FIX Protocol 4-6 位 |
