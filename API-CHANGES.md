# API 接口变更说明

## 变更概述

移除了 `totalSupplyApy`、`totalBorrowApy` 和 `apySpread` 字段。接口现在只提供基础数据，前端需要根据用户选择（APR 或 APY）自行计算最终值。

## 字段变更

### 移除的字段
- `totalSupplyApy: number`
- `totalBorrowApy: number | null`
- `apySpread: number | null`

### 可用字段

**Supply：**
- `supplyApy: string` - 原生 Supply APY（百分比字符串，如 "2.50"）
- `totalIncentiveSupplyApr: number` - 激励 APR（小数形式，如 0.05 表示 5%）
- `totalIncentiveSupplyApy: number` - 激励 APY（小数形式）

**Borrow：**
- `borrowApy: string | null` - 原生 Borrow APY（百分比字符串，可为 null）
- `totalIncentiveBorrowApr: number` - 激励 APR（小数形式，可为负数）
- `totalIncentiveBorrowApy: number` - 激励 APY（小数形式，可为负数）

## 计算逻辑

### Supply 计算

```typescript
// 选择 APR
const nativeSupplyApr = parseFloat(item.supplyApy) / 100;
const totalSupplyApr = nativeSupplyApr + item.totalIncentiveSupplyApr;

// 选择 APY
const nativeSupplyApy = parseFloat(item.supplyApy) / 100;
const totalSupplyApy = nativeSupplyApy + item.totalIncentiveSupplyApy;
```

### Borrow 计算

```typescript
// 选择 APR
const nativeBorrowApr = item.borrowApy ? parseFloat(item.borrowApy) / 100 : 0;
const totalBorrowApr = item.borrowApy === null 
  ? -item.totalIncentiveBorrowApr 
  : nativeBorrowApr - item.totalIncentiveBorrowApr; // 注意是相减

// 选择 APY
const nativeBorrowApy = item.borrowApy ? parseFloat(item.borrowApy) / 100 : 0;
const totalBorrowApy = item.borrowApy === null 
  ? -item.totalIncentiveBorrowApy 
  : nativeBorrowApy - item.totalIncentiveBorrowApy; // 注意是相减
```

**重要：** Borrow 是**相减**（borrowApy - incentive），不是相加。

### Spread 计算（可选）

```typescript
const spread = totalSupplyApy - totalBorrowApy; // 或使用 APR 版本
```

## 排序和筛选

以下功能需要在前端实现：
- 按 `totalSupplyApy`/`totalSupplyApr` 排序
- 按 `totalBorrowApy`/`totalBorrowApr` 排序
- 按 `apySpread` 排序
- 最小 Supply APY 筛选
- 最大 Borrow APY 筛选

**仍支持的查询参数：**
- `sort=supplyApy`、`sort=borrowApy`（按原生值排序）
- `chain`、`market`、`token`（筛选）

## 数据类型

- `supplyApy`、`borrowApy`：百分比字符串，需除以 100 转为小数
- `totalIncentiveSupplyApr`、`totalIncentiveSupplyApy`、`totalIncentiveBorrowApr`、`totalIncentiveBorrowApy`：已是小数形式，直接使用
- 所有字段都可以为 0 或负数

## 注意事项

1. APR/APY 换算已由后端完成，前端只需根据用户选择使用对应字段
2. 前端需要实现基于计算出的 total 值的排序和筛选
3. 所有计算逻辑需要处理 null 值和负数情况
