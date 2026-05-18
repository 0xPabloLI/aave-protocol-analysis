# 开发方案 - AAV-170 后端 onchain RPC 数据获取支持 v4 deficit

## 1. Issue 概述
后端需要增强 onchain RPC 数据获取逻辑，使其支持 Aave V4 的 deficit 数据获取。目前 V4 SDK 不直接返回 deficit 字段，需通过后端调用链上 RPC 接口补充该数据，保证后端 API 能完整返回 V4 市场的 deficit 信息。

## 2. 当前状态
- 未开始
- 目前后端 onchainDataService.ts 仅对 V3 deficit 支持较完善，V4 相关缺失
- V4 数据主要通过 v4-fetcher.ts 获取，但缺少 deficit 字段补充

## 3. 影响范围
- 后端仓库：aave-protocol-analysis（railway 分支）
- 主要涉及后端服务中的 onchainDataService.ts、v4-fetcher.ts、marketsService.ts

## 4. 实现方案

### 4.1 需求分析
- V4 SDK 不直接返回 deficit，需要调用链上合约的对应方法获取
- 需在后端 onchainDataService 中新增针对 V4 的 deficit 获取逻辑
- 将获取的 deficit 数据整合到后端内存快照中，供 API 返回

### 4.2 具体步骤

#### 4.2.1 调研 V4 deficit 获取方式
- 查阅 Aave V4 官方合约接口，确认 deficit 相关字段或方法（如 getTotalDebt、getAvailableLiquidity 等）
- 确认 RPC 调用方式（ethers.js 或 web3.js）

#### 4.2.2 修改后端代码

- **文件：`src/onchainDataService.ts`**
  - 新增针对 V4 市场的 deficit 获取函数，调用对应合约方法
  - 复用现有 RPC provider，确保调用链上数据
  - 设计接口统一返回 V3/V4 deficit 格式

- **文件：`src/v4-fetcher.ts`**
  - 在获取 V4 市场数据后，调用 onchainDataService 的 deficit 获取函数补充数据
  - 将 deficit 字段合并到 RuntimeReserveData 类型中

- **文件：`backend/src/services/marketsService.ts`**
  - 确保 marketsService 在构建内存快照时包含 deficit 字段
  - 处理 V4 市场数据时正确读取和存储 deficit

#### 4.2.3 测试与验证
- 编写单元测试覆盖 V4 deficit 获取逻辑
- 集成测试确保 API `/api/markets` 返回的 V4 市场数据包含 deficit 字段且数值正确
- 本地联调，使用主网或测试网数据验证

### 4.3 数据流变更
- 数据源：链上 RPC -> onchainDataService (V4 deficit 获取) -> v4-fetcher 补充数据 -> marketsService 组装快照 -> API 返回
- 保障数据结构兼容前端消费

## 5. 依赖关系
- 无直接依赖其他未完成 Issue
- 但建议同步关注 V4 deficit 相关合约接口变动（若有）

## 6. 验收标准
- 后端 `/api/markets` 接口返回的所有 V4 市场数据均包含准确的 deficit 字段
- 单元测试覆盖新增的 deficit 获取函数，测试通过
- 集成测试验证整体数据链路正确
- 本地及 staging 环境验证无异常，数据符合链上实际

## 7. 复杂度评估
- Medium
- 需要理解 V4 合约接口及链上 RPC 调用，涉及后端多模块协作
- 但已有 V3 类似实现可参考，技术难度适中

---

以上为 AAV-170 后端 onchain RPC 支持 V4 deficit 的详细开发方案。