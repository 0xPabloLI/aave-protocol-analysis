# Aave APY Dashboard - 前端开发需求

## 项目简介
构建一个 Aave 协议借贷 APY 数据展示仪表盘，深色主题，参考 app.aave.com 设计风格。

## API 接口（已部署）

**基础 URL**: `https://api.aaveapy.com/api`

### 获取市场数据
```
GET /markets?sort=totalSupplyApy&order=desc
```

响应格式：
```json
{
  "data": [{
    "tokenSymbol": "WETH",
    "tokenName": "Wrapped Ether", 
    "chainName": "Ethereum",
    "marketName": "AaveV3Ethereum",
    "totalSupplyApy": 0.0456,
    "totalBorrowApy": 0.0234,
    "apySpread": 0.0222
  }],
  "lastUpdated": "2026-01-07T08:30:00Z"
}
```

### 获取市场列表（用于筛选）
```
GET /markets/list
```

## 功能需求

1. **表格展示**：显示代币、市场、Supply APY、Borrow APY、Spread
2. **列头排序**：点击切换 无排序→升序→降序→无排序
3. **市场筛选**：按钮组多选，Ethereum 市场显示为 Core/Prime/Horizon RWA/EtherFi
4. **代币筛选**：Stablecoin / ETH Related / BTC Related / Pendle
5. **搜索框**：模糊匹配代币符号
6. **APY/APR 切换**：Toggle 开关

## 设计规范

- **背景色**: #0E0E2E (深蓝紫)
- **卡片背景**: rgba(27, 27, 58, 0.6) + backdrop-filter: blur(20px)
- **主色调**: 紫色 #B6509E，青色 #2EBAC6
- **渐变按钮**: linear-gradient(90deg, #B6509E, #2EBAC6)
- **文字**: 白色 #FFFFFF，次要 #A5A8B6
- **正收益**: 绿色 #3AB795
- **负 Spread**: 橙色 #F89D49

## 数据格式化

```typescript
// APY 是小数，需要 *100 显示为百分比
const formatPercent = (value: number | null) => {
  if (value === null) return '-';
  return `${(value * 100).toFixed(2)}%`;
};

// Spread 需要显示正负号
const formatSpread = (value: number | null) => {
  if (value === null) return '-';
  const pct = value * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
};
```

## 页面布局

```
┌─────────────────────────────────────────────────┐
│ Header: 标题 + APY/APR Toggle + 最后更新时间      │
├─────────────────────────────────────────────────┤
│ Filters: 市场按钮 | 代币类型按钮 | 搜索框         │
├─────────────────────────────────────────────────┤
│ Stats: 总市场数 | 平均Supply APY | 平均Borrow APY │
├─────────────────────────────────────────────────┤
│ Table: 代币 | 市场 | Supply APY | Borrow APY | Spread │
└─────────────────────────────────────────────────┘
```

请创建这个前端应用，使用 React + Tailwind CSS，深色主题。

