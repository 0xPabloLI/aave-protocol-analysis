# Aave 市场数据获取系统 - 模块架构图

## 整体流程图

```mermaid
graph TB
    Start[开始执行] --> Main[fetchAaveMarkets 主函数]
    
    Main --> GetNetworks[getAllAaveV3Networks<br/>获取所有 AaveV3 网络]
    Main --> FetchMerit[fetchMeritAPRs<br/>获取 Merit APR 数据]
    Main --> FetchMerkl[processMerklData<br/>处理 Merkl 数据]
    Main --> FetchMarkets[循环获取各链市场数据]
    
    FetchMerkl --> FetchMerklOpp[fetchMerklOpportunities<br/>获取 Merkl 机会]
    FetchMerklOpp --> FetchCampaign[fetchMerklCampaignDetails<br/>获取活动详情]
    
    FetchMarkets --> Format[formatMarketData<br/>格式化市场数据]
    FetchMerit --> Format
    FetchMerkl --> Format
    
    Format --> Utils1[getChainKey<br/>链名映射]
    Format --> Utils2[matchesChain<br/>匹配链]
    Format --> Utils3[matchesToken<br/>匹配代币]
    
    Format --> GenerateCSV[generateCSV<br/>生成 CSV 文件]
    Format --> SaveJSON[保存 JSON 文件]
    
    GenerateCSV --> End[结束]
    SaveJSON --> End
    
    style Main fill:#4CAF50,color:#fff
    style Format fill:#2196F3,color:#fff
    style End fill:#9C27B0,color:#fff
```

## 模块分类详解

### 1️⃣ 核心主函数模块

```mermaid
graph LR
    A[fetchAaveMarkets] --> B[orchestrates整个流程]
    A --> C[错误处理]
    A --> D[文件保存]
```

**职责**：
- 协调所有子模块
- 处理全局错误
- 保存最终数据到文件

---

### 2️⃣ 数据获取模块 (Data Fetchers)

```mermaid
graph TB
    subgraph Network["网络配置"]
        N1[getAllAaveV3Networks]
    end
    
    subgraph External["外部 API 获取"]
        E1[fetchMeritAPRs]
        E2[fetchMerklOpportunities]
        E3[fetchMerklCampaignDetails]
    end
    
    subgraph Markets["市场数据"]
        M1[markets from @aave/client]
    end
    
    N1 --> |提供网络列表| Main[主函数]
    E1 --> |Merit APR 数据| Main
    E2 --> |Merkl 机会| E3
    E3 --> |活动详情| Main
    M1 --> |原始市场数据| Main
```

**各函数职责**：

| 函数 | 数据源 | 返回值 | 用途 |
|------|--------|--------|------|
| `getAllAaveV3Networks()` | @bgd-labs/aave-address-book | `NetworkInfo[]` | 获取所有支持的网络配置 |
| `fetchMeritAPRs()` | https://apps.aavechan.com/api/merit/aprs | `Record<string, number>` | 获取激励 APR 数据 |
| `fetchMerklOpportunities()` | https://api.merkl.xyz/v4/opportunities | `MerklOpportunity[]` | 获取 Merkl 机会列表 |
| `fetchMerklCampaignDetails()` | https://api.merkl.xyz/v4/campaigns/{id} | `MerklCampaignDetails` | 获取单个活动详情 |

---

### 3️⃣ 数据处理模块 (Data Processors)

```mermaid
graph TB
    subgraph Process["处理流水线"]
        P1[processMerklData] --> P2[合并 Merkl 数据]
        P3[formatMarketData] --> P4[整合所有数据源]
        P4 --> P5[生成统一格式]
    end
    
    P2 --> P3
```

**processMerklData 流程**：
```mermaid
sequenceDiagram
    participant Main as 主函数
    participant PMD as processMerklData
    participant FMO as fetchMerklOpportunities
    participant FCD as fetchMerklCampaignDetails
    
    Main->>PMD: 调用
    PMD->>FMO: 获取所有机会
    FMO-->>PMD: 返回机会列表
    
    loop 每个机会
        PMD->>PMD: 筛选 Aave 协议
        PMD->>PMD: 识别底层代币
        loop 每个活动
            PMD->>FCD: 获取活动详情
            FCD-->>PMD: 返回活动数据
        end
        PMD->>PMD: 按代币+链分组
    end
    
    PMD-->>Main: Map<key, {supply, borrow}>
```

**formatMarketData 流程**：
```mermaid
graph LR
    A[原始市场数据] --> B[遍历每个市场]
    B --> C[遍历每个储备资产]
    C --> D{匹配激励数据}
    
    D --> D1[Merit APR]
    D --> D2[Merkl APR]
    
    D1 --> E[getChainKey]
    D1 --> F[matchesChain]
    D1 --> G[matchesToken]
    
    D2 --> H[查找 Merkl Map]
    
    E --> I[组装格式化数据]
    F --> I
    G --> I
    H --> I
    
    I --> J[FormattedReserveData[]]
```

---

### 4️⃣ 工具函数模块 (Utilities)

```mermaid
graph TB
    subgraph Matching["匹配工具"]
        M1[getChainKey<br/>链名 → 标准键]
        M2[matchesChain<br/>检查链是否匹配]
        M3[matchesToken<br/>检查代币是否匹配]
    end
    
    subgraph Export["导出工具"]
        E1[generateCSV<br/>生成 CSV 格式]
    end
    
    M1 --> M2
    M2 --> Parent[formatMarketData]
    M3 --> Parent
    E1 --> Save[保存文件]
```

**工具函数细节**：

1. **getChainKey(chainName)**: 
   - 输入：显示名称 (如 "Ethereum")
   - 输出：标准化键 (如 "ethereum")
   - 用途：统一链名称格式

2. **matchesChain(parts, chainKey)**:
   - 检查 Merit APR key 中的链是否匹配
   - 处理 `self-` 前缀情况

3. **matchesToken(parts, tokenSymbol)**:
   - 智能匹配代币符号
   - 处理变体 (如 USDT/USD₮, USDC/USDCe)
   - 使用映射表进行模糊匹配

4. **generateCSV(data)**:
   - 转换 JSON 为 CSV 格式
   - 处理数组字段
   - 添加适当的引号和转义

---

### 5️⃣ 数据流向图

```mermaid
graph LR
    subgraph Input["输入数据源"]
        I1[Address Book]
        I2[Merit API]
        I3[Merkl API]
        I4[Aave Client API]
    end
    
    subgraph Processing["处理层"]
        P1[网络信息]
        P2[激励数据]
        P3[Merkl 数据]
        P4[市场数据]
    end
    
    subgraph Formatting["格式化层"]
        F1[数据整合]
        F2[APR 匹配]
        F3[数据转换]
    end
    
    subgraph Output["输出文件"]
        O1[aave-all-markets-data.json<br/>原始数据]
        O2[aave-formatted-data.json<br/>格式化 JSON]
        O3[aave-formatted-data.csv<br/>CSV 格式]
    end
    
    I1 --> P1
    I2 --> P2
    I3 --> P3
    I4 --> P4
    
    P1 --> F1
    P2 --> F2
    P3 --> F2
    P4 --> F1
    
    F1 --> F3
    F2 --> F3
    
    F3 --> O1
    F3 --> O2
    F3 --> O3
```

---

## 数据类型接口关系

```mermaid
classDiagram
    class NetworkInfo {
        +string name
        +number chainId
        +string poolAddress
    }
    
    class MarketData {
        +string timestamp
        +number totalNetworks
        +number[] chainIds
        +NetworkInfo[] networkInfo
        +any[] markets
        +string[] errors
    }
    
    class FormattedReserveData {
        +string marketName
        +string chainName
        +number chainId
        +string tokenName
        +string tokenSymbol
        +string tokenAddress
        +string supplyApy
        +string borrowApy
        +string incentiveSupplyApr
        +string incentiveBorrowApr
        +string selfIncentiveSupplyApr
        +string selfIncentiveBorrowApr
        +boolean multiple
        +number merklSupplyApr
        +number merklBorrowApr
        +MerklCampaignBreakdown[] merklSupplyAprBreakdowns
        +MerklCampaignBreakdown[] merklBorrowAprBreakdowns
    }
    
    class MerklCampaignBreakdown {
        +number campaignApr
        +string campaignEndedAt
        +string campaignId
    }
    
    class MerklOpportunity {
        +string id
        +string action
        +number chainId
        +object protocol
        +object[] tokens
        +object rewardsRecord
        +object aprRecord
    }
    
    class MeritAPRResponse {
        +any previousAPR
        +object currentAPR
    }
    
    MarketData *-- NetworkInfo
    FormattedReserveData *-- MerklCampaignBreakdown
```

---

## 函数调用层次结构

```
fetchAaveMarkets() [主函数]
├── getAllAaveV3Networks()
│   └── 读取 @bgd-labs/aave-address-book
│
├── fetchMeritAPRs()
│   └── HTTP GET: apps.aavechan.com/api/merit/aprs
│
├── processMerklData()
│   ├── fetchMerklOpportunities()
│   │   └── HTTP GET: api.merkl.xyz/v4/opportunities
│   └── fetchMerklCampaignDetails(campaignId)
│       └── HTTP GET: api.merkl.xyz/v4/campaigns/{id}
│
├── markets() [from @aave/client]
│   └── 循环调用每个 chainId
│
├── formatMarketData(markets, meritAPRs, merklData)
│   ├── 遍历每个 market
│   ├── 遍历每个 reserve
│   ├── getChainKey(chainName)
│   ├── matchesChain(parts, chainKey)
│   ├── matchesToken(parts, tokenSymbol)
│   └── 组装 FormattedReserveData
│
├── generateCSV(formattedData)
│   └── 转换为 CSV 字符串
│
└── writeFile() [多次调用]
    ├── aave-all-markets-data.json
    ├── aave-formatted-data.json
    └── aave-formatted-data.csv
```

---

## 关键数据处理逻辑

### 激励 APR 匹配算法

```mermaid
graph TB
    Start[开始匹配激励] --> GetChain[获取链键]
    GetChain --> Loop[遍历 Merit APR entries]
    
    Loop --> Parse[解析 key: chain-action-token]
    Parse --> CheckSelf{是否 self 类型?}
    
    CheckSelf -->|是| SelfMatch[匹配 self-chain-action-token]
    CheckSelf -->|否| CheckMultiple{是否 multiple?}
    
    CheckMultiple -->|是| MultipleMatch[处理 multiple 激励]
    CheckMultiple -->|否| NormalMatch[普通激励匹配]
    
    SelfMatch --> CheckMatch{链和代币匹配?}
    MultipleMatch --> CheckMatch
    NormalMatch --> CheckMatch
    
    CheckMatch -->|是| AddAPR[添加到对应数组]
    CheckMatch -->|否| Loop
    
    AddAPR --> Loop
    Loop -->|完成| Return[返回激励数据]
```

### Merkl 数据聚合

```mermaid
graph TB
    Start[开始处理] --> Filter[筛选 Aave 协议]
    Filter --> FindToken[查找底层代币]
    FindToken --> GenKey[生成 key: chainId-tokenAddress]
    
    GenKey --> CheckMap{Map 中存在?}
    CheckMap -->|否| CreateEntry[创建新条目]
    CheckMap -->|是| GetEntry[获取现有条目]
    
    CreateEntry --> ProcessCampaigns
    GetEntry --> ProcessCampaigns
    
    ProcessCampaigns[处理活动] --> FetchDetails[获取活动详情]
    FetchDetails --> CheckAction{action 类型?}
    
    CheckAction -->|LEND| AddSupply[添加到 supply 数组]
    CheckAction -->|BORROW| AddBorrow[添加到 borrow 数组]
    
    AddSupply --> Delay[延迟 200ms]
    AddBorrow --> Delay
    Delay --> NextCampaign{更多活动?}
    
    NextCampaign -->|是| ProcessCampaigns
    NextCampaign -->|否| NextOpp{更多机会?}
    
    NextOpp -->|是| Filter
    NextOpp -->|否| Return[返回 Map]
```

---

## 外部依赖

```mermaid
graph TB
    subgraph External["外部包依赖"]
        A1[@aave/client]
        A2[@bgd-labs/aave-address-book]
        A3[node-fetch]
        A4[fs/promises]
    end
    
    subgraph APIs["外部 API"]
        B1[apps.aavechan.com - Merit APR]
        B2[api.merkl.xyz - Merkl 数据]
    end
    
    A1 --> |市场数据| App[应用程序]
    A2 --> |网络配置| App
    A3 --> |HTTP 请求| B1
    A3 --> |HTTP 请求| B2
    A4 --> |文件写入| Files[输出文件]
```

---

## 错误处理策略

```mermaid
graph TB
    Start[函数执行] --> TryCatch{Try-Catch}
    
    TryCatch -->|正常| Execute[执行逻辑]
    TryCatch -->|错误| Log[记录错误]
    
    Log --> CheckLevel{错误级别}
    
    CheckLevel -->|链级错误| Continue[继续下一个链]
    CheckLevel -->|API 错误| ReturnEmpty[返回空数据]
    CheckLevel -->|致命错误| SaveError[保存错误文件]
    
    Continue --> Next[处理下一项]
    ReturnEmpty --> Next
    SaveError --> Exit[退出程序]
    
    Execute --> Success[返回结果]
    Next --> End[完成]
    Success --> End
```

---

## 性能优化点

1. **并发控制**: Merkl API 调用间有 200ms 延迟避免限流
2. **去重处理**: chainId 数组去重减少重复请求
3. **错误隔离**: 单个链失败不影响其他链的数据获取
4. **数据缓存**: Merit 和 Merkl 数据只获取一次，供所有市场使用

---

## 使用示例

```bash
# 运行主程序
npm start

# 输出文件：
# - aave-all-markets-data.json      # 原始市场数据
# - aave-formatted-data.json        # 格式化 JSON
# - aave-formatted-data.csv         # CSV 格式
```

---

## 总结

这个系统的核心设计理念：

1. **模块化**: 清晰的职责分离
2. **可扩展**: 易于添加新的数据源
3. **容错性**: 完善的错误处理
4. **数据整合**: 多源数据统一格式化
5. **用户友好**: 提供 JSON 和 CSV 双格式输出

主要数据流：**获取 → 处理 → 整合 → 格式化 → 输出**

