# 开发方案：AAV-144 V3/V4 incentive matching: external sources cannot distinguish protocol version

## 1. Issue 概述
当前外部激励数据源（Merit、Merkl、Brevis）无法区分同链上相同代币的V3和V4协议版本，导致激励匹配错误。需在匹配逻辑中加入协议版本区分，并持续监控外部数据源V4激励上线情况，及时调整匹配逻辑。

## 2. 当前状态
- 4.1 监控日志已实施
- 4.2/4.3 等 V4 数据到达后实施
- V4激励数据尚未上线，暂无直接风险
- Merkl 已实现 protocolVersion 推导（ADR-0018 四步优先级）和匹配时过滤
- Brevis 和 Merit 类型定义中有 `protocolVersion` 字段但硬编码 `'v3'`，匹配时不过滤

## 3. 影响范围
- 后端仓库：`aave-protocol-analysis`（railway分支）
  - Fetcher层（`packages/aave-fetcher/src/`）
- 前端和 Backend API 层无影响

## 4. 实现方案

### 4.1 监控日志：检测 V4 激励数据出现
- 修改文件：
  - `packages/aave-fetcher/src/index.ts` — `enrichDatasetWithIncentiveData` 匹配时加 V4 误配检测
  - `packages/aave-fetcher/src/merkl-api.ts` — `findMatchingMerklOpportunities` 中加跨版本过滤日志
- 检测点：
  - **匹配时误配检测**：V4 reserve（`marketName.startsWith('AaveV4')`）获得了 Brevis 或 Merit incentive 时，打印 `warn` 日志（因这两个源当前仅 V3，匹配到 V4 reserve 意味着上游可能已上线 V4 数据或存在误配）
  - **Merkl 跨版本过滤日志**：`findMatchingMerklOpportunities` 中，仅当有 opportunity 被版本过滤掉时输出 `info` 日志（含被过滤数量和 reserve 信息）
  - 无需改 `fetchBrevisAprs` / Merit 函数签名，无需传入 baseDataset 做反查
- 日志内容包含 chainId、token 地址/symbol、激励源名称、protocolVersion

### 4.2 Brevis 索引逻辑（V4 数据到达后实施）
- 当前索引键：`chainId-tokenAddress`（underlying）
- 当前 `protocolVersion` 硬编码 `'v3'`，匹配时不过滤
- V4 数据到达后，采用与 Merkl 相同模式：同 key 存数组 + protocolVersion 过滤
- 不改上游索引键格式（不引入 protocolId），保持与 Brevis 团队现有接口兼容

### 4.3 Merit 匹配逻辑（V4 数据到达后实施）
- 当前索引键：`chainName-tokenSymbol`
- 当前 `protocolVersion` 硬编码 `'v3'`，匹配时不过滤
- V4 数据到达后，同 key 存数组 + protocolVersion 过滤
- Merit 使用 symbol 匹配，V3/V4 同链同 symbol 一定冲突，必须加版本过滤

### 4.4 Merkl：已完成，无需修改
- Merkl 已实现 ADR-0018 四步 protocolVersion 推导
- 匹配时已按 `opp.protocolVersion === protocolVersion` 过滤
- 同 key 存数组结构已就位

## 5. 依赖关系
- 4.1（监控日志）无外部依赖，可立即实施
- 4.2（Brevis 适配）依赖 Brevis 上游返回 V4 campaign 数据
- 4.3（Merit 适配）依赖 Merit 上游返回 V4 campaign 数据

## 6. 验收标准
- 4.1：V4 reserve 获得 Brevis/Merit incentive 时输出 warn 日志；Merkl 有 opportunity 被版本过滤时输出 info 日志
- 4.2：Brevis 激励匹配正确区分 V3/V4（V4 数据到达后验证）
- 4.3：Merit 激励匹配正确区分 V3/V4（V4 数据到达后验证）
- 通过后端单元测试验证监控日志和匹配逻辑

## 7. 复杂度评估
- Low（当前阶段）
  - 4.1 仅加日志，零风险
  - 4.2/4.3 等 V4 数据到达后再实施，当前不阻塞
  - Merkl 已完成，无需额外工作
