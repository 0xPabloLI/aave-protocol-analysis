# Aave Markets Data Fetcher

这个项目使用 Aave TypeScript SDK 和 @bgd-labs/aave-address-book 获取所有支持网络的市场数据并将结果保存到 JSON 文件中。

## 功能特性

- 🌐 使用 @bgd-labs/aave-address-book 自动发现所有 AaveV3 网络
- 🔄 使用 Aave SDK 获取多链市场数据（12个链，15个市场）
- 💾 将数据保存到 JSON 文件
- 📊 在控制台显示详细的市场分布信息
- ⚠️ 自动识别并跳过不支持的网络
- ❌ 完善的错误处理和日志记录

## 项目结构

```
aave/
├── src/
│   ├── client.ts      # Aave 客户端配置
│   ├── logger.ts      # 日志配置模块
│   └── index.ts       # 主要逻辑
├── data/              # 输出数据文件夹
│   ├── aave-all-markets-data.json
│   ├── aave-formatted-data.json
│   └── aave-formatted-data.csv
├── logs/              # 日志文件文件夹
│   ├── combined.log   # 所有日志
│   └── error.log      # 错误日志
├── package.json       # 项目依赖
├── tsconfig.json      # TypeScript 配置
└── README.md          # 项目说明
```

## 安装依赖

```bash
npm install
```

## 运行项目

### 开发模式（推荐）
```bash
npm run dev
```

### 构建并运行
```bash
npm run build
npm start
```

## 输出文件

运行成功后，会在 `data/` 文件夹生成：
- `aave-all-markets-data.json` - 包含所有支持网络的完整市场数据
- `aave-formatted-data.json` - 格式化后的 JSON 数据
- `aave-formatted-data.csv` - CSV 格式数据
- `aave-all-markets-error.json` - 如果出现错误，会保存错误信息

## 日志系统

项目使用 [winston](https://github.com/winstonjs/winston) 日志库来统一管理日志输出。

### 日志文件

所有日志会自动保存到 `logs/` 文件夹：
- `logs/combined.log` - 包含所有级别的日志（info, warn, error, debug）
- `logs/error.log` - 仅包含 error 级别的日志

### 日志级别

- **info** - 一般信息（默认级别）
- **warn** - 警告信息
- **error** - 错误信息
- **debug** - 调试信息（开发环境启用）

### 日志配置

- 日志文件大小限制：5MB
- 日志文件保留数量：5个（自动轮转）
- 控制台输出：彩色格式，便于查看
- 文件输出：JSON 格式，包含时间戳和元数据

日志文件会自动创建，无需手动配置。

## 支持的网络

项目自动获取以下 12 个区块链网络的 15 个 Aave V3 市场：

### 以太坊 (Chain ID: 1) - 4 个市场
- **AaveV3Ethereum** - 主要市场 ($59.3B 市场规模)
- **AaveV3EthereumEtherFi** - EtherFi 市场
- **AaveV3EthereumLido** - Lido 市场 ($2.2B 市场规模)
- **AaveV3EthereumHorizon** - Horizon 市场

### 其他支持的网络 (各1个市场)
- **Arbitrum** (42161) - $2.2B 市场规模
- **Avalanche** (43114) - $1.5B 市场规模  
- **BNB Chain** (56) - $426M 市场规模
- **Base** (8453) - $1.9B 市场规模
- **Optimism** (10) - $242M 市场规模
- **Polygon** (137) - $372M 市场规模
- **Gnosis** (100) - $132M 市场规模
- **Linea** (59144) - $2.7B 市场规模
- **Metis** (1088) - $12M 市场规模
- **Scroll** (534352) - $43M 市场规模
- **zkSync** (324) - $15M 市场规模

### 暂不支持的网络
以下网络由于 API 限制暂时跳过：
- Celo (42220)
- InkWhitelabel (57073) 
- Plasma (9745)
- Soneium (1868)
- Sonic (146)

## 数据结构

输出的 JSON 文件包含以下字段：

```typescript
interface MarketData {
  timestamp: string;           // 数据获取时间
  totalNetworks: number;       // 总网络数量
  chainIds: number[];          // 查询的链ID列表
  networkInfo: NetworkInfo[];  // 网络详细信息
  markets: Market[];           // 市场数据数组
  errors: string[];            // 错误信息列表
}

interface NetworkInfo {
  name: string;        // 网络名称（如 AaveV3Ethereum）
  chainId: number;     // 链ID
  poolAddress: string; // 池合约地址
}
```

每个 Market 对象包含：
- `name`: 市场名称
- `chain`: 区块链信息
- `address`: 市场合约地址
- `totalMarketSize`: 市场总规模
- `totalAvailableLiquidity`: 可用流动性
- `supplyReserves`: 供应储备列表
- `borrowReserves`: 借贷储备列表
- `eModeCategories`: 效率模式类别

## 技术栈

- **TypeScript**: 类型安全的 JavaScript
- **@aave/client**: Aave 官方 SDK
- **@bgd-labs/aave-address-book**: Aave 地址簿，包含所有网络配置
- **winston**: 日志管理库
- **Node.js**: JavaScript 运行环境

## 相关链接

- [Aave V3 文档](https://aave.com/docs/developers/aave-v3/markets/data#listing-available-markets)
- [Aave SDK](https://github.com/aave/aave-sdk)
