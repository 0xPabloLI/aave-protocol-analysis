# Backend Hardcode and External Imports

## 1. Source Of Truth

| 主题 | 来源 | 本地使用 |
|---|---|---|
| Subgraph deployments | `aave/protocol-subgraphs`（由同步脚本抓取） | `docs/api/aave-subgraph-deployments.snapshot.json` |
| On-chain addresses | `@bgd-labs/aave-address-book` | `backend/src/services/rateInputsService.ts` |
| On-chain reserve reader | `@aave/contract-helpers` (`UiPoolDataProvider`) | `backend/src/services/rateInputsService.ts` |
| Shared RPC registry | `@internal/aave-shared-config` | `backend/src/services/ethProviderService.ts` |

## 2. 当前策略（Rate Inputs）

- 主路径：subgraph（含 retry + timeout）。
- 兜底路径：on-chain `UiPoolDataProvider`。
- 兜底配置：动态解析 `AaveV3*` 导出（不维护静态链列表）。
- 部分缺失补齐：subgraph 返回不完整时，仅缺失 token 走 on-chain 补齐。

## 3. 环境变量

- 仅保留：`THE_GRAPH_API_KEY`（gateway 子图访问）。
- RPC 不支持环境变量覆写，统一来自 shared RPC registry。

## 4. 自动化（GitHub Actions）

| 工作流 | 频率 | 作用 |
|---|---|---|
| `.github/workflows/subgraph-sync.yml` | 每天 1 次 | 同步 subgraph deployment snapshot，变更自动开 PR |
| `.github/workflows/subgraph-rate-inputs-health.yml` | 每天 1 次 | 兼容性/健康探测，产出健康报告 |

触发方式：
- `schedule`（每天）
- `repository_dispatch`（`event_type=upstream-change`，供 webhook relay 触发）

## 5. 非自动化项（保留人工）

| 项目 | 原因 | 处理方式 |
|---|---|---|
| 地址簿未覆盖链（如 Fantom/Harmony） | 上游 SDK 无 fallback metadata | 维持降级 + 业务需要时人工补链 |
| RPC 质量（配额/延迟/可用性） | 运行时基础设施问题 | 监控告警 + 更新 shared RPC 列表 |
| key 轮换 | 组织安全策略项 | 平台/密管流程处理 |
