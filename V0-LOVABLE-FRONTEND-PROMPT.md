# Aave APY Dashboard - 前端开发 Prompt

> 本文档用于 v0.dev / Lovable 等 AI 前端平台，指导构建 Aave APY Dashboard 前端应用。

## 🎯 项目概述

构建一个 **Aave 协议借贷 APY 数据展示仪表盘**，帮助 DeFi 用户快速找到最优的借贷机会。

### 目标用户
- DeFi 投资者，寻找最高收益的 lending 机会
- 套利者，寻找 looping 机会（低成本借入，高收益存入）
- Aave 协议用户，比较不同链和市场的 APY

### 核心功能
- 显示所有 Aave 上 token 的借贷 APY（17 条链，约 229 个代币）
- 支持按 APY 排序，找到最值得 farming 的借贷对
- 支持 looping 机会识别（找到 borrow 成本低、supply 收益高的套利对）
- APY/APR 切换显示
- 按市场和代币类型筛选

### 设计要求
- **参考 app.aave.com 的设计风格**，浅色/白色主题
- **现代、专业、简洁的 DeFi Dashboard 风格**
- **数据密度高但不杂乱**，用户能快速扫描找到目标
- **请根据 API 返回的数据结构，自由设计最佳的 UI 布局**

---

## 🔌 后端 API 文档

**API 基础 URL**: `https://api.aaveapy.com/api`

### 1. 获取市场数据

```
GET https://api.aaveapy.com/api/markets
```

**查询参数**:
| 参数 | 类型 | 说明 |
|------|------|------|
| `sort` | string | 排序字段: `totalSupplyApy`, `totalBorrowApy`, `apySpread` |
| `order` | string | 排序方向: `asc`, `desc` |
| `chain` | string | 链名筛选（多个用逗号分隔） |
| `token` | string | 代币符号搜索（模糊匹配） |

**响应示例**:
```json
{
  "data": [
    {
      "marketName": "AaveV3Ethereum",
      "chainName": "Ethereum",
      "chainId": 1,
      "tokenName": "Wrapped Ether",
      "tokenSymbol": "WETH",
      "tokenAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "supplyApy": "2.16",
      "borrowApy": "3.45",
      "totalSupplyApy": 0.0456,
      "totalBorrowApy": 0.0234,
      "apySpread": 0.0222,
      "totalIncentiveSupplyApy": 0.024,
      "totalIncentiveBorrowApy": 0.0111
    }
  ],
  "lastUpdated": "2026-01-07T08:30:00.000Z",
  "isStale": false,
  "updateInProgress": false
}
```

### 2. 获取统计信息

```
GET https://api.aaveapy.com/api/markets/stats
```

**响应**:
```json
{
  "totalMarkets": 20,
  "totalChains": 17,
  "totalTokens": 229,
  "chains": ["Ethereum", "Arbitrum", "Polygon", ...]
}
```

### 3. 获取市场列表

```
GET https://api.aaveapy.com/api/markets/list
```

**响应**:
```json
[
  { "marketName": "AaveV3Ethereum", "chainName": "Ethereum" },
  { "marketName": "AaveV3EthereumLido", "chainName": "Ethereum" },
  { "marketName": "AaveV3Arbitrum", "chainName": "Arbitrum" }
]
```

### 4. 手动刷新数据

```
POST https://api.aaveapy.com/api/markets/refresh
```

---

## 📊 数据类型定义

```typescript
interface MarketWithSpread {
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  supplyApy: string;           // 原生 Supply APY（百分比字符串，如 "2.16"）
  borrowApy: string | null;    // 原生 Borrow APY
  totalSupplyApy: number;      // 总 Supply APY（小数，如 0.0456 = 4.56%）
  totalBorrowApy: number | null; // 总 Borrow APY
  apySpread: number | null;    // 差值 = totalSupplyApy - totalBorrowApy
  totalIncentiveSupplyApy: number;
  totalIncentiveBorrowApy: number;
  // 激励明细（可选展示）
  meritSupplyApr: string[];
  meritBorrowApr: string[];
  merklSupplyApr: number;
  merklBorrowApr: number;
  brevisSupplyApr: number | null;
  brevisBorrowApr: number | null;
}

interface MarketsResponse {
  data: MarketWithSpread[];
  lastUpdated: string;         // ISO 时间戳
  isStale: boolean;            // 数据是否过期（超过1分钟）
  updateInProgress: boolean;   // 是否正在更新
}

type SortField = 'totalSupplyApy' | 'totalBorrowApy' | 'apySpread' | null;
type SortOrder = 'asc' | 'desc';
type TokenCategory = 'stablecoin' | 'eth-related' | 'btc-related' | 'pendle';
```

---

## 🎨 设计规范（Aave 风格）

### 颜色方案（浅色主题）

```css
/* 主色调 - Aave 品牌色 */
--aave-purple: #B6509E;
--aave-cyan: #2EBAC6;
--aave-blue: #1B3A6F;

/* 背景色 - 浅色系 */
--bg-primary: #FFFFFF;
--bg-secondary: #F7F8FA;
--bg-tertiary: #EBEEF2;

/* 文字颜色 */
--text-primary: #1A1A2E;
--text-secondary: #6B7280;
--text-muted: #9CA3AF;

/* 状态颜色 */
--success: #10B981;  /* 正收益 - 绿色 */
--warning: #F59E0B;  /* 负 spread - 橙色 */
--error: #EF4444;
--info: #3B82F6;

/* 边框和分割线 */
--border: #E5E7EB;
--border-hover: #D1D5DB;
```

### 设计特点
1. **白色/浅灰背景**，干净清爽
2. **卡片带轻微阴影**，层次分明
3. **Aave 品牌色点缀**：紫色和青色用于强调元素
4. **圆角设计**：卡片 12-16px，按钮 8px
5. **响应式布局**：移动端友好

---

## 🧩 功能组件需求

> **注意**：以下是功能需求，具体的 UI 布局请 AI 根据数据结构和用户体验自由设计。

### 1. 数据表格
- 展示所有市场数据，支持列头点击排序
- **排序交互**：点击切换 无排序(⇅) → 升序(↑) → 降序(↓) → 无排序
- 默认按 Total Supply APY 降序
- 可以考虑卡片式布局、虚拟滚动等优化大数据量展示

### 2. 筛选功能
- **市场筛选**：支持多选
  - Ethereum 市场映射：`AaveV3Ethereum` → "Core", `AaveV3EthereumLido` → "Prime", `AaveV3EthereumHorizon` → "Horizon RWA", `AaveV3EthereumEtherFi` → "EtherFi"
  - 其他链直接显示链名（如 Arbitrum, Polygon 等）
- **代币类型筛选**：Stablecoin / ETH Related / BTC Related / Pendle
- **搜索**：模糊匹配代币符号或名称

### 3. APY/APR 切换
- Toggle 开关，控制显示 APY 或 APR
- APY 模式（默认）：显示复利后的年化收益
- APR 模式：显示原始年化收益率

### 4. 统计概览
- 可以展示：总市场数、平均 Supply APY、平均 Borrow APY 等
- 布局形式自由设计（卡片、数字高亮等）

### 5. 数据状态
- 显示最后更新时间 (`lastUpdated`)
- 如果 `isStale: true`，提示数据可能过期
- 加载状态、错误处理

---

## 📋 功能需求详解

### 三种核心使用场景

| 场景 | 排序字段 | 排序方向 | 用途 |
|------|----------|----------|------|
| 找最高 APY 去 Lend | `totalSupplyApy` | 降序 | 找收益最高的 supply 机会 |
| 找最低 APY 去 Borrow | `totalBorrowApy` | 升序 | 找成本最低的 borrow 机会 |
| 找 Looping 机会 | `apySpread` | 升序 | 找套利对（负数优先） |

### APY Spread 说明
- `apySpread = totalSupplyApy - totalBorrowApy`
- **负数**（橙色高亮）：表示可以低成本 borrow，高收益 supply，形成套利
- **正数**（绿色）：正常情况

### 数据刷新
- 后端每 30 秒自动更新数据
- 前端显示 `lastUpdated` 时间戳
- 如果 `isStale: true`，显示警告提示

---

## 🛠️ 技术建议

### 推荐技术栈
- **框架**: React / Next.js
- **样式**: Tailwind CSS
- **HTTP**: fetch / axios
- **状态管理**: React hooks (useState, useEffect)

### API 调用示例

```typescript
// 获取市场数据
const fetchMarkets = async (params?: {
  sort?: string;
  order?: 'asc' | 'desc';
  chain?: string;
  token?: string;
}) => {
  const searchParams = new URLSearchParams();
  if (params?.sort) searchParams.set('sort', params.sort);
  if (params?.order) searchParams.set('order', params.order);
  if (params?.chain) searchParams.set('chain', params.chain);
  if (params?.token) searchParams.set('token', params.token);

  const response = await fetch(
    `https://api.aaveapy.com/api/markets?${searchParams}`
  );
  return response.json();
};

// 获取市场列表（用于筛选按钮）
const fetchMarketsList = async () => {
  const response = await fetch('https://api.aaveapy.com/api/markets/list');
  return response.json();
};
```

### 数据格式化

```typescript
// 格式化百分比显示
const formatPercent = (value: number | null): string => {
  if (value === null) return '-';
  return `${(value * 100).toFixed(2)}%`;
};

// 格式化 spread（带正负号）
const formatSpread = (value: number | null): string => {
  if (value === null) return '-';
  const percent = value * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;
};
```

---

## 🎯 UI 交互细节

### 表格列头排序
```
点击列头 → 无排序(⇅灰色) → 升序(↑青色) → 降序(↓青色) → 无排序
```

### 颜色编码
- **Supply APY**: 绿色 (`#3AB795`)
- **Borrow APY**: 青色 (`#2EBAC6`)
- **正 Spread**: 绿色
- **负 Spread**: 橙色 (`#F89D49`)

### 市场徽章
- 使用圆角徽章显示市场名
- 背景：半透明青色
- 边框：青色

### 加载状态
- 使用渐变色旋转动画
- 紫色到青色渐变

---

## 📱 响应式设计

### 断点
- **Mobile**: < 768px - 卡片式布局，表格横向滚动
- **Tablet**: 768px - 1024px - 紧凑表格
- **Desktop**: > 1024px - 完整表格

### 移动端适配
- Header 垂直堆叠
- 筛选按钮换行显示
- 表格支持横向滚动
- 统计卡片单列显示

---

## ✅ 验收标准

1. [ ] 能正确从 API 获取并显示市场数据
2. [ ] 表格支持按 Supply APY / Borrow APY / Spread 排序
3. [ ] 支持按市场和代币类型筛选
4. [ ] 支持代币搜索
5. [ ] APY/APR 切换正常工作
6. [ ] 负 Spread 用橙色高亮显示（这是 looping 套利机会）
7. [ ] 显示最后更新时间
8. [ ] 浅色主题，简洁专业，符合 Aave 设计风格
9. [ ] 响应式布局，移动端友好
10. [ ] 加载状态和错误处理

---

## 🔗 参考资源

- **Aave 官方应用**: https://app.aave.com （设计风格参考）
- **API 测试**: `curl https://api.aaveapy.com/api/markets | jq`

---

## 💡 给 AI 的提示

1. **请自由设计 UI 布局**，不必拘泥于传统表格形式，可以尝试卡片、网格、分组等
2. **参考 app.aave.com 的视觉风格**，但可以有自己的创新
3. **数据密度和可读性平衡**，用户需要快速扫描大量数据（约 229 条）
4. **突出关键信息**：
   - 高收益的 Supply APY（绿色）
   - 低成本的 Borrow APY（青色）
   - 负 Spread 的套利机会（橙色高亮，这是用户最关心的）
5. **可以考虑添加**：
   - 数据可视化（如 APY 分布图、热力图）
   - 快捷筛选标签
   - Top 10 高收益列表
   - 收藏/关注功能
6. **技术栈建议**：React + Tailwind CSS，可以使用 shadcn/ui 等组件库

