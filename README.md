# Aave Markets Data Fetcher

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

这个项目使用 Aave TypeScript SDK 和 @bgd-labs/aave-address-book 获取所有支持网络的市场数据，并整合 Merit、Merkl 和 Brevis 激励数据，将结果保存到 JSON 和 CSV 文件中。

## 📋 目录

- [功能特性](#功能特性)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [使用说明](#使用说明)
- [输出文件](#输出文件)
- [数据字段说明](#数据字段说明)
- [技术栈](#技术栈)
- [API 数据源](#api-数据源)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

## 功能特性

- 🌐 使用 @bgd-labs/aave-address-book 自动发现所有 AaveV3 网络
- 🔄 使用 Aave SDK 获取多链市场数据（17个链，20个市场）
- 💰 整合 Merit APR 激励数据
- 🎁 整合 Merkl 激励活动数据
- 🌐 整合 Brevis Network Linea Surge APR 数据
- 💾 将数据保存到 JSON 和 CSV 文件
- 📊 在控制台显示详细的市场分布信息
- ⚠️ 自动识别并跳过不支持的网络
- ❌ 完善的错误处理和日志记录

## 项目结构

```
aave/
├── src/
│   ├── index.ts          # 主要逻辑
│   ├── logger.ts         # 日志配置模块
│   └── brevis-api.ts     # Brevis API 客户端
├── data/                 # 输出数据文件夹
│   ├── aave-all-markets-data.json      # 原始市场数据
│   ├── aave-formatted-data.json        # 格式化后的 JSON 数据
│   ├── aave-formatted-data.csv         # CSV 格式数据
│   ├── brevis-raw-activities.json      # Brevis 原始活动数据
│   └── merkl-raw-data.json             # Merkl 原始数据
├── logs/                 # 日志文件文件夹
│   ├── combined.log      # 所有日志
│   └── error.log         # 错误日志
├── dist/                 # TypeScript 编译输出
├── package.json          # 项目依赖
├── tsconfig.json         # TypeScript 配置
└── README.md             # 项目说明
```

## 快速开始

### 前置要求

- Node.js 20 或更高版本
- npm 或 yarn 包管理器

### 安装依赖

```bash
npm install
```

### 运行项目

#### 开发模式（推荐）
```bash
npm run dev
```

#### 构建并运行
```bash
npm run build
npm start
```

运行成功后，数据文件将保存在 `data/` 目录中。

## 输出文件

运行成功后，会在 `data/` 文件夹生成：

- `aave-all-markets-data.json` - 包含所有支持网络的完整市场数据
- `aave-formatted-data.json` - 格式化后的 JSON 数据，包含所有激励信息
- `aave-formatted-data.csv` - CSV 格式数据，便于在 Excel 中查看
- `brevis-raw-activities.json` - Brevis Network Linea Surge 原始活动数据
- `merkl-raw-data.json` - Merkl 激励活动原始数据

## 数据字段说明

输出的格式化数据包含以下字段：

### 基础字段
- `marketName` - 市场名称（如 AaveV3Ethereum）
- `chainName` - 链名称（如 ethereum）
- `chainId` - 链 ID
- `tokenName` - 代币名称
- `tokenSymbol` - 代币符号
- `tokenAddress` - 代币合约地址
- `supplyApy` - 供应 APY
- `borrowApy` - 借贷 APY

### 协议激励
- `supplyIncentives` - Aave 协议供应激励
- `borrowIncentives` - Aave 协议借贷激励

### Merit 激励
- `meritSupplyApr` - Merit 供应 APR
- `meritBorrowApr` - Merit 借贷 APR
- `meritSelfSupply` - Merit 自供应 APR
- `meritSelfBorrow` - Merit 自借贷 APR
- `meritBorrowWithSupplyRequirement` - 需要先供应才能获得的借贷 APR
- `meritSupplyWithBorrowRequirement` - 需要先借贷才能获得的供应 APR

### Merkl 激励
- `merklSupplyApr` - Merkl 供应 APR（数组）
- `merklBorrowApr` - Merkl 借贷 APR（数组）
- `merklHoldApr` - Merkl 持有 APR（数组）
- `merklSupplyAprBreakdowns` - Merkl 供应活动详情
- `merklBorrowAprBreakdowns` - Merkl 借贷活动详情
- `merklHoldAprBreakdowns` - Merkl 持有活动详情

### Brevis 激励
- `brevisSupplyApr` - Brevis Network Linea Surge 供应 APR
- `brevisBorrowApr` - Brevis Network Linea Surge 借贷 APR

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

项目自动获取所有 AaveV3 网络的市场数据。根据运行时的实际情况，通常会获取：

- **19 个 AaveV3 网络**，分布在 **17 个不同的链**上
- **约 20 个市场**
- **约 229 个代币储备**

### 主要支持的网络

- **Ethereum** (Chain ID: 1) - 4 个市场（AaveV3Ethereum, AaveV3EthereumEtherFi, AaveV3EthereumLido, AaveV3EthereumHorizon）
- **Arbitrum** (42161)
- **Avalanche** (43114)
- **BNB Chain** (56)
- **Base** (8453)
- **Optimism** (10)
- **Polygon** (137)
- **Gnosis** (100)
- **Linea** (59144)
- **Metis** (1088)
- **Scroll** (534352)
- **zkSync** (324)
- **Celo** (42220)
- **InkWhitelabel** (57073)
- **Plasma** (9745)
- **Soneium** (1868)
- **Sonic** (146)

项目会自动跳过测试网络（如 Sepolia、Fuji）和不支持的网络。

## 技术栈

- **TypeScript**: 类型安全的 JavaScript
- **@aave/client**: Aave 官方 SDK
- **@bgd-labs/aave-address-book**: Aave 地址簿，包含所有网络配置
- **winston**: 日志管理库
- **node-fetch**: HTTP 请求库
- **Node.js**: JavaScript 运行环境

## API 数据源

项目从以下 API 获取激励数据：

- **Merit APR**: `https://apps.aavechan.com/api/merit/aprs`
- **Merkl Opportunities**: `https://api.merkl.xyz/v4/opportunities?name=aave`
- **Merkl Campaigns**: `https://api.merkl.xyz/v4/campaigns/{campaignId}`
- **Brevis Network**: `https://linea-surge-endpoint.brevis.network/LineaSurgeV2Provider/GetActivities`

## 使用说明

### 数据更新

项目会自动从以下数据源获取最新数据：
- Aave 官方 SDK 获取市场数据
- Merit API 获取 APR 激励数据
- Merkl API 获取活动激励数据
- Brevis Network API 获取 Linea Surge APR 数据

### 日志查看

所有日志文件保存在 `logs/` 目录：
- `combined.log` - 所有级别的日志
- `error.log` - 仅错误日志

### 数据文件说明

生成的数据文件位于 `data/` 目录：
- `aave-all-markets-data.json` - 原始市场数据（包含所有网络信息）
- `aave-formatted-data.json` - 格式化后的完整数据（包含所有激励信息）
- `aave-formatted-data.csv` - CSV 格式数据（便于 Excel 分析）
- `brevis-raw-activities.json` - Brevis 原始活动数据
- `merkl-raw-data.json` - Merkl 原始激励数据

## 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

### 开发规范

- 使用 TypeScript 编写代码
- 遵循现有的代码风格
- 添加适当的注释和文档
- 确保代码通过 TypeScript 编译检查

## 许可证

本项目采用 MIT 许可证。详情请参阅 [LICENSE](LICENSE) 文件。

## 相关链接

- [Aave V3 文档](https://aave.com/docs/developers/aave-v3/markets/data#listing-available-markets)
- [Aave SDK](https://github.com/aave/aave-sdk)
- [Merit Protocol](https://apps.aavechan.com/)
- [Merkl](https://merkl.xyz/)
- [Brevis Network](https://brevis.network/)

## 作者

如有问题或建议，请提交 Issue 或 Pull Request。
