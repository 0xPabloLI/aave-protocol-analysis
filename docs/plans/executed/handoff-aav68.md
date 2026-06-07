# Handoff: AAV-68 Merkl 跨 Reserve Net Position 收益扣减

**日期**: 2026-05-25
**状态**: ✅ 全部完成

## 摘要

AAV-68 是 Merkl 跨 Reserve Net Lending/Borrow 收益扣减方案。经历 5 个 bug 修复周期，核心 Bug 5 需要推翻旧的 `reserveLookup` 方案，改用 pool/spoke-scoped `reserveIdSet` 方案。所有修复已部署验证，GitHub 子 issue 已关闭，Linear 已标记 Done。

## 完成事项

### Bug 1-4（已修复部署，不动）
- Bug 1/2/3: 已修复 & commit & push & Railway staging 部署
- Bug 4: pool expansion 已回滚 — commit `b7caba6`

### Bug 5 核心修复（commit `b484be6`）

**根因**: 旧 `reserveLookup` 用 `chainId:tokenAddress` 作 key，只能区分 V3 vs V4，无法区分同链同版本的多个 pool（如 Ethereum V3 Main vs V3 Horizon）。

**新方案**: offset token 和 opp 自身在同 pool/spoke，从 opp 所在 reserve 的 `reserveIdId` 提取 pool/spoke 前缀，拼接 offset token 地址构建 candidate reserveId，在 `reserveIdSet` 中验证。

**关键变更**:
- 新辅助函数: `inferVersionFromReserveId`, `extractPoolSpokePrefix`, `resolveOffsetReserveIds`
- `ProcessMerklDataOptions`: `reserveLookup?: ReserveLookup` → `reserveIdSet?: Set<string>`
- 函数签名变更: `extractOffsetTokenAddresses`, `extractNetPositionConstraint`, `detectNetPositionConstraint` 均改为接收 `oppReserveId` + `reserveIdSet`
- LLM fallback 路径新增 `symbolLookup: Map<string, string>`

### 验证
- ✅ tsc 类型检查通过
- ✅ 117/117 测试全部通过
- ✅ Railway staging 部署: 跨 pool 污染 = 0
- ✅ Playwright 前端浏览器验证
- ✅ Linear AAV-68 标记 Done
- ✅ GitHub 子 issue #271 #272 #273 #274 #280 已关闭

## 仓库

| 仓库 | 路径 | 分支 | 关键 commit |
|------|------|------|-------------|
| 后端 | `/Users/pabloli/Documents/code/aave-protocol-analysis` | `railway` | `b484be6` (Bug 5), `b7caba6` (Bug 4 回滚) |
| 前端 | `/Users/pabloli/Documents/code/aaveapy` | `lovable` | `aa29c4ed` (方案文档更新) |

## 关键文件

### 后端
- `packages/aave-fetcher/src/merkl-api.ts` — 核心修改（L192-238 辅助函数, L367-372 Options, L1087-1101 反查, L1281-1404 三层检测）
- `packages/aave-fetcher/src/index.ts` — 调用点改造（L487-493, L532, L1166-1172）
- `packages/aave-fetcher/tests/bug5-pool-spoke-resolution.test.ts` — 新测试 11/11
- `packages/aave-fetcher/tests/detectNetPositionConstraint.test.ts` — 适配新签名
- `packages/aave-fetcher/tests/netPositionConstraint.test.ts` — 适配新签名

### 前端
- `docs/plans/linear-issues/aav_68_plan.md` — 方案文档
- `src/hooks/useRateSimulation.ts` — L1168-1194 消费 netPositionConstraint
- `src/lib/netLendingCrossReserve.ts` — 跨 reserve 抵消计算
- `src/types/aave.ts` — L36 netPositionConstraint 字段
- `src/shared/schema-fingerprint.ts` — Schema FP `2fde56319b7d`

## 重要设计决策

1. **offset 不跨 market/spoke** — 用户明确确认
2. **V4 同 spoke 内不同 hub 可共享** — offset 粒度是 spoke 级别，跨 hub
3. **LLM fallback 设计意图** — layer1 找到 constraint → early return，找不到才走 LLM
4. **reserveId 格式**: V3 = `chainId:poolAddress:tokenAddress`（3段），V4 = `chainId:spokeAddress:tokenAddress:hubName`（4段）

## 用户偏好摘要

- 中文沟通 + 英文技术术语
- AI 主动验证而非要求用户确认
- 代码尽量最简，不加注释
- `npm run ci:remote` 超时，commit 用 `--no-verify`
- 前端验证 → Playwright；后端验证 → 本地 tdd + typecheck + test → staging
- 详细 rationale + 信源引用
- 偏好确认性解释（保留 vs 删除）再执行清理

## Suggested Skills

- 无。AAV-68 已全部完成，无需后续 session。
