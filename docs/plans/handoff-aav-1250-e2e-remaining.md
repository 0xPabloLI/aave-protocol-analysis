# Handoff — AAV-1250 E2E 遗留问题 + 流程改进

> **日期**: 2026-08-04
> **上下文**: AAV-1250 (P3 maxBorrow) + AAV-1251 (P4 HF) 完成后的 E2E 回归修复
> **状态**: 21 个失败已修复至 1 个 pre-existing 失败。流程改进已全部落地。

---

## 1. 遗留 E2E 失败（1 个，pre-existing）→ Linear AAV-1257

### 失败测试

```
e2e/portfolio-incentive-calculation.spec.ts
Cap threshold crossing — current invariance › mobile › entering large delta preserves current incentive
```

### 失败详情

- **断言**: `expect(currentAfter).toBe(currentBefore)` — 当前 incentive 应不随 supply 金额变化
- **实际**: `currentBefore = "—"`, `currentAfter = "6.43%"` → 不相等
- **平台**: 仅 mobile-chromium，desktop 同名测试通过

### 根因分析

Desktop 版本通过 `span[data-current]` attribute 读取值，且预先断言 `incentiveCell` 不含 `"—"`。
Mobile 版本通过 `[data-testid="delta-current"]` 的 `textContent()` 读取值，**无预检查**。

大额 delta 改变 utilization rate 导致 current 值变化，与 P3 无关。

### 跟踪

- **Linear issue**: [AAV-1257](https://linear.app/aaveapy/issue/AAV-1257/fix-pre-existing-mobile-e2e-cap-threshold-crossing-current-invariance)
- **CI 影响**: E2E CI job 当前 `continue-on-error: true`，修复 AAV-1257 后移除
- **CI scope**: 当前仅跑 `--project=chromium`，修复后加 `--project=mobile-chromium`

---

## 2. Pre-commit Hook 空提交问题 ✅ 已修复

后端 `.prettierignore` 排除了两个生成文件：

```text
backend/static/openapi.json
packages/aave-shared-config/schema-fingerprint.ts
```

---

## 3. E2E 回归根因总结 ✅ 已修复（21 → 0 新增失败）

| 测试文件                                  | 失败数 | 根因                         | 修复                             |
| ----------------------------------------- | ------ | ---------------------------- | -------------------------------- |
| `portfolio-cross-reserve-offset.spec.ts`  | ~8     | USDe ltv=0 → borrow 截断到 0 | 过滤 ltv=0；supply 提升至 $100k  |
| `portfolio-incentive-calculation.spec.ts` | ~7     | USDC 失去 incentive          | 动态发现（findIncentiveReserve） |
| `portfolio-results-inline-delta.spec.ts`  | ~6     | 同上 + LTV clamping          | 动态发现（findIncentiveReserve） |

---

## 4. 流程改进 ✅ 已落地

### 4.1 E2E 加入 CI ✅

前端 `.github/workflows/ci.yml` 新增 `e2e` job：

- 触发条件：PR / push（与 build/lint 并行）
- 当前 `continue-on-error: true`（因 AAV-1257），修复后移除
- 当前仅 `--project=chromium`，修复后加 `--project=mobile-chromium`
- 上传 `test-results/` artifact（7 天保留）
- Playwright `webServer` 自动启动 dev server（`reuseExistingServer: !process.env.CI`）

### 4.2 E2E 测试数据韧性 ✅

新建 `e2e/test-reserves.ts` 共享模块：

- `findIncentiveReserve()`: 动态发现有 supply incentive + ltv > 0 的 reserve（按 ltv 降序排序）
- `findAnyActiveReserve()`: 动态发现任意 active + ltv > 0 的 reserve（优先 USDC/USDT/DAI/WETH/GHO）
- `setupPortfolioWithReserve()`: 共享 UI setup helper
- `getMarketChipLabel()`: market label 工具函数（从 cross-reserve-offset.spec.ts 抽取）

已更新的测试文件（4 个）：

- `portfolio-incentive-calculation.spec.ts` → `findIncentiveReserve()`
- `portfolio-results-inline-delta.spec.ts` → `findIncentiveReserve()`
- `portfolio-mobile-spacing.spec.ts` → `findAnyActiveReserve()`
- `portfolio-decimal-input.spec.ts` → `findAnyActiveReserve()`

未改动的测试文件（已有动态发现）：

- `portfolio-cross-reserve-offset.spec.ts`（已有自己的 `discoverScenarios()`）

### 4.3 工作流执行保障

- AGENTS.md 工作流 Step 6 已从 "Commit" 改为 "Commit & Push"
- CI E2E job 作为安全网：即使本地跳过 E2E，CI 会在 PR 阶段拦截回归

---

## 5. 下一步

| 优先级 | 任务          | 说明                                                                      |
| ------ | ------------- | ------------------------------------------------------------------------- |
| 高     | **AAV-1257**  | 修复 mobile E2E，移除 `continue-on-error`，加 `--project=mobile-chromium` |
| 中     | AAV-1249 (P5) | NE APY 展示                                                               |
| 中     | AAV-1252 (P6) | Summary 整合                                                              |
| 低     | AAV-1253 (P7) | on-chain HF baseline                                                      |
