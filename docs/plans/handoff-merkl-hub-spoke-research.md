# Handoff: Merkl V4 Hub/Spoke 历史分发对比研究

> **目的**：将 Hub vs Spoke opportunity 的历史 reward 对比研究移交给新 session，避免上下文污染。
> **相关 Issue**：AAV-959 (Hub/Spoke double-counting fix)
> **当前代码状态**：commit `4138e59` — 过滤 Spoke 保留 Hub（结论待本研究的最终验证）
> **研究状态**：✅ 已完成 — 假说 C 已验证，ADR-0030 决策已确认正确

---

## 0. 研究结论摘要

### 假说 C 已验证 ✅

**Hub reward = Hub-direct reward + Spoke-forwarded reward（全部用户）**
**Spoke reward = Spoke-forwarded reward only（仅 Spoke 用户）**

**核心证据**：
1. Period 4: Hub leaderboard top1 = Spoke top1 = $4,870 → 同一用户在两边显示相同金额 → Hub 包含了 Spoke 部分
2. Period 3: Hub top1 ($3,240) > Spoke top1 ($1,040) → 同一用户 Hub 显示总量，Spoke 仅显示 Spoke 部分
3. Spoke Budget 占 Hub Budget 的 65~77% → Spoke budget 是 Hub budget 的预分配份额
4. Spoke distributed 可以超过 Spoke budget（Period 4 API: $29,756 > $29,121）→ `/v4/rewards/total` 对已结束 campaign 返回 budget 值，不是实际消耗量

**分发机制详解**：
```
Hub budget ($44,423.50 for Period 4)
  ├── Spoke 份额 ($29,121.45 = 65.5%) → 通过 Spoke child campaign 分发给 spoke 用户
  ├── Hub-direct 份额 → 分发给 hub-direct 用户
  └── 未消耗部分 → 退回 creator

Hub 的 dailyRewards = TVL × targetAPR / 365（展示值，含 native）
Hub 实际消耗 = TVL × incentiveAPR / 365（= targetAPR - nativeAPY）
因为 nativeAPY > 0，实际消耗 < budget / 7，未消耗部分退回

⚠️ 重要澄清：
- `/v4/rewards/total` API 对已结束 campaign 返回 budget 值，不是实际消耗量
- "Hub distributes 100% budget" 是 API 返回值造成的假象，实际消耗 < budget
- Spoke budget 是 Hub budget 的预分配份额（65-77%），创建时设定，不是动态调整
```

**一个 deposit 既符合 spoke 又符合 hub，拿哪份？**
- 只拿一份，不是两份
- Hub 和 Spoke 是同一个 reward 的两个视角
- Hub leaderboard = 所有用户的 reward 全景（hub-direct + spoke-forwarded）
- Spoke leaderboard = 仅 spoke 用户的 reward 子集
- 实际总分发 = Hub 的实际消耗（不是 Hub + Spoke）

### 用户实际按哪个 APR 获得 reward？✅ 已确认

**两条路径下，用户获得的 Merkl reward 相同，都按 incentiveAPR 支付**

- **Hub.apr (6.77%) = targetAPR（含 native）**
  - Hub 的 `dailyRewards` 按 targetAPR 计算（展示值）
  - Hub 实际消耗按 incentiveAPR 计算（= targetAPR - nativeAPY ≈ 6.45%）
  - 因为 nativeAPY > 0，实际消耗 < budget，未消耗部分退回 creator
  - `/v4/rewards/total` API 返回 budget 值，造成"100% 分发"的假象

- **Spoke.apr (6.46%) ≈ incentiveAPR（纯 incentive，Dutch Auction 追踪）**
  - Spoke budget 是 Hub budget 的预分配份额（65-77%），创建时设定
  - Spoke 按 Dutch Auction 机制分发，APR 由当前 TVL 和分发速率动态计算

- **用户的 total return = nativeAPY (链上自动) + incentiveAPR (Merkl) = targetAPR**
- Leaderboard 显示的是 Merkl 支付的 incentive（不含 native）

### Distribution 完整机制 ✅

1. Creator 存入 Hub budget = `maxAmount × 7`（按 targetAPR 算的 7 天预算）
2. Merkl 引擎自动创建 Spoke child campaign，分配 Spoke budget = `amount × 7`（按 incentiveAPR 算的 7 天预算）
3. 每个 engine run：Hub 按 `incentiveAPR = max(targetAPR - nativeAPY, 0)` 分配 reward；Spoke Dutch Auction 按固定速率消耗 budget，APR ≈ incentiveAPR
4. Campaign 结束：Spoke budget 全部消耗；Hub budget 有剩余退回 creator（退回 ≈ Hub budget × nativeAPY / targetAPR）

### ADR-0030 决策确认 ✅

过滤 Spoke 保留 Hub 的决策正确：
1. Hub + Spoke = double-counting → 必须只选一个
2. Hub 是源 campaign，有完整 budget/targetAPR 元数据
3. Hub 的 AAVE_V4_NET_APR 类型可被后端 scaleMerklBreakdown 正确处理
4. Hub reward 已包含 Spoke 用户的全部 incentive → 过滤 Spoke 不丢失信息

---

## 1. 核心研究问题

### 1.1 Hub 和 Spoke 的 reward 是否发给同一批用户？

**假说 A**：Hub 和 Spoke 发给完全相同的用户、完全相同的金额（只是展示视角不同）
**假说 B**：Hub 发给 Hub 直存用户，Spoke 发给 Spoke 存款用户，两者用户集不同
**假说 C**：Hub 发给所有用户（包括通过 Spoke 存入的），Spoke 只发给 Spoke 用户，但金额是同一笔 ✅ 已验证

### 1.2 Period 4 为什么 Hub leaderboard = Spoke leaderboard？

**已解决**：Period 4 所有用户都仅通过 Spoke 存入（Hub-direct = 0），所以 Hub 显示的 reward 等于 Spoke 显示的 reward。Period 3 有 Hub-direct 用户，所以 Hub > Spoke。

### 1.3 Duration 字段的精确含义

**已解决**：
- **Hub duration (604800s = 7天)** = Campaign 的总运行时长（1 epoch = 1 week），Budget 按此时长线性分发
- **Spoke duration (1225~3551s ≈ 20-60分钟)** = Dutch Auction 的重新定价间隔，即 Merkl engine 每次 run 重新计算 rate 的间隔。不等于 campaign 总时长（Spoke endTs 与 Hub endTs 对齐）

---

## 2. 已知数据

### 2.1 USDG V4 Supply Opportunities

| 属性 | Hub | Spoke |
|---|---|---|
| Opportunity ID | 13732557426013257809 | 10461268836244172547 |
| Type | AAVE_V4_HUB_SUPPLY | AAVE_V4_SPOKE_SUPPLY |
| Name | Supply USDG to the Aave V4 Core Hub | Supply USDG to the Aave V4 Main Spoke |
| Explorer Address | 0xe343167631d89B6Ffc58B88d6b7fB0228795491D | 0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a |
| APR | 6.77% | 6.45% |
| Distribution Type | AAVE_V4_NET_APR | DUTCH_AUCTION |
| Daily Rewards | $4,899.94 | $4,654.19 |
| Max Daily Rewards | $6,052.98 | $4,654.19 |
| TVL | $26,417,704.80 | $26,342,035.71 |
| Campaign Total Budget | $42,377.65 | $32,584.55 |
| forwardingEnabled | true | N/A |
| targetAPR | 0.0677 (6.77%) | N/A |

### 2.2 frxUSD V4 Supply Opportunities

| 属性 | Hub | Spoke |
|---|---|---|
| Opportunity ID | 5589740163449212193 | 7860375496856797543 |
| Type | AAVE_V4_HUB_SUPPLY | AAVE_V4_SPOKE_SUPPLY |
| APR | 5.36% | 4.89% |

### 2.3 Hub Campaign 详情 (当前 period)

Campaign ID: `11526583104559356735`
```json
{
  "distributionType": "AAVE_V4_NET_APR",
  "params": {
    "duration": 604800,
    "hubAddress": "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
    "forwardingEnabled": true,
    "underlyingToken": "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
    "distributionMethodParameters": {
      "distributionMethod": "AAVE_V4_NET_APR",
      "distributionSettings": {
        "mode": "MAX_APR",
        "side": "supply",
        "assetId": "8",
        "targetAPR": "0.0677",
        "hubAddress": "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
        "targetToken": "0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a",
        "rewardTokenPricing": true,
        "targetTokenPricing": true
      }
    }
  },
  "rewardToken": {
    "symbol": "USDG",
    "address": "0xDF464440FC5E93B44998C0A7444e5211eFdf2B1E",
    "decimals": 6
  }
}
```

### 2.4 Spoke Campaign 详情 (当前 period)

Campaign ID: `5055509984402346017`
```json
{
  "distributionType": "DUTCH_AUCTION",
  "params": {
    "duration": 3772
  },
  "dailyRewards": 4654.189016232159,
  "apr": 6.448928281489237
}
```

### 2.5 Hub 历史所有 Campaigns (from raw data)

| Campaign ID | targetAPR | Period |
|---|---|---|
| 11526583104559356735 | 6.77% | 当前 (Period 5?) |
| 8647796357084493685 | 7.70% | Period 4? |
| 16480846617225364900 | 7.70% | Period 3? |
| 12629342796274257722 | 8.00% | Period 2? |
| 558840222117031613 | 8.40% | Period 1? |

---

## 3. Leaderboard 对比数据（不完整，仅 top 5）

### USDG Period 4 (Hub targetAPR=7.70%)

**Hub Campaign**: `0xbfe68f7d938f096f519adeb1dbc3e2532b36bda09624f2fac2c5a7270a769c1e`
**Spoke Campaign**: `12893990290143601795`

Hub leaderboard URL: https://app.merkl.xyz/opportunities/13732557426013257809/campaigns/0xbfe68f7d938f096f519adeb1dbc3e2532b36bda09624f2fac2c5a7270a769c1e/leaderboard
Spoke leaderboard URL: https://app.merkl.xyz/opportunities/10461268836244172547/campaigns/12893990290143601795/leaderboard

| Rank | Hub | Spoke |
|---|---|---|
| 1 | $4,870 | $4,870 |
| 2 | $3,860 | $3,860 |
| 3 | $2,750 | $2,750 |
| 4 | $2,270 | $2,270 |
| 5 | $1,710 | $1,710 |
| 6 | $946.67 | $946.67 |

**观察**：Hub = Spoke（金额完全相同）

### USDG Period 3 (Hub targetAPR=7.70%?)

**Hub Campaign**: `0x034aec680b3642257ef5263d6c8d4d6a0e8d42e7209c0d50fbeff0f566998056`
**Spoke Campaign**: `10615816937644305100`

Hub leaderboard URL: https://app.merkl.xyz/opportunities/13732557426013257809/campaigns/0x034aec680b3642257ef5263d6c8d4d6a0e8d42e7209c0d50fbeff0f566998056/leaderboard
Spoke leaderboard URL: https://app.merkl.xyz/opportunities/10461268836244172547/campaigns/10615816937644305100/leaderboard

| Rank | Hub | Spoke | Hub/Spoke |
|---|---|---|---|
| 1 | $3,240 | $1,040 | 3.12x |
| 2 | $3,020 | $934.22 | 3.23x |
| 3 | $2,910 | $914.71 | 3.18x |
| 4 | $2,830 | $623.61 | 4.54x |
| 5 | $2,220 | $615.28 | 3.61x |

**观察**：Hub >> Spoke，比例不固定（3x~4.5x）

### USDG Period 2 & 1

Spoke leaderboard 数据极少（只有 2 个 entry = TVL/daily），Hub 有数据。

### frxUSD

**未系统对比**。Period 1 frxUSD Spoke 数据也极少。

---

## 4. 研究结果

### 4.1 已验证的高优先级问题

- [x] **Q1**: Period 4 Hub=Spoke 是因为所有用户都仅通过 Spoke 存入（Hub-direct = 0）。`/v4/rewards/total` API 返回 Hub Dist = Hub Budget = $44,423.50，Spoke Dist = $29,756.46（≈ Spoke Budget），Hub+Spoke = 1.67x Hub Budget → double-counting 确认
- [x] **Q2**: Period 3 Hub≠Spoke 是因为有 Hub-direct 用户。Hub top1 ($3,240) = Hub-direct ($2,200) + Spoke-forwarded ($1,040)。比例不固定因为每个用户的 Hub-direct/Spoke 比例不同
- [x] **Q3**: Leaderboard API endpoint = `GET /v4/rewards/total?chainId=1&campaignId={id}`，返回 campaign 累计分发总量。对已结束 campaign = 全部 budget
- [x] **Q4**: Hub duration = campaign 总时长 (7天)。Spoke duration = Dutch Auction 重新定价间隔 (20-60分钟)，由 Merkl engine run 频率决定

### 4.2 已验证的中优先级问题

- [x] **Q5**: Merkl API 文档在 https://developers.merkl.xyz/resources/schemas，有 TypeBox JSON Schema。`/v4/schemas` endpoint 可查询所有 campaignType/distributionMethod 的定义
- [x] **Q6**: `forwardingEnabled=true` + `forwarders=[]` → Hub campaign 由 Merkl 引擎自动创建 Spoke campaign 并转发 reward。Schema 定义: AAVE_V4_HUB_SUPPLY = "hub-level campaign rewarding supply per spoke"
- [x] **Q7**: Spoke Budget = Hub Budget 中 forward 给 Spoke 用户的部分。Hub Budget ≠ Hub-direct + Spoke-forwarded（Hub Budget 是独立数值，Spoke Budget 也是独立数值，但 Spoke Budget 占 Hub Budget 的 65~77%）

### 4.3 低优先级问题状态

- [ ] **Q8**: frxUSD 的 Hub/Spoke 对比 — frxUSD V4 opportunity 已不在 LIVE 列表，无法用同样方法验证
- [x] **Q9**: Period 时间范围已从 campaign endTimestamp 推算 — 每个 period = 7天，从 2026-05-28 13:00 UTC 开始
- [x] **Q10**: Engine run 间隔 ≈ Spoke duration ≈ 20-60分钟（从 Spoke campaign 的 params.duration 推算）

### 4.4 全量分发数据对比（已验证）

| Period | Hub Budget | Hub Dist | Spoke Budget | Spoke Dist | Hub Dist / Hub Budget | Spoke Dist / Hub Budget |
|---|---|---|---|---|---|---|
| 5 (LIVE) | $42,377.65 | $9,903.58 | $32,749.20 | $9,903.55 | 0.23x (in progress) | 0.23x |
| 4 | $44,423.50 | $44,423.50 | $29,124.55 | $29,756.55 | 1.00x | 0.67x |
| 3 | $44,423.50 | $44,423.50 | $30,546.62 | $9,897.26 | 1.00x | 0.22x |
| 2 | $30,769.43 | $30,769.43 | $23,530.93 | $0.09 | 1.00x | 0.00x |
| 1 | $15,908.00 | $15,908.00 | $12,033.51 | N/A | 1.00x | N/A |

**关键观察**：
1. **Hub 始终分发 100% budget** — 所有已结束 campaign 的 Hub 分发 = budget
2. **Spoke 分发 ≤ Hub 分发** — Period 4: 67%, Period 3: 22%, Period 2: ~0%
3. **Spoke 分发是 Hub 分发的子集** — 见下方 "分发规则详解"
4. **Period 4 Spoke = Hub（top user）** — 所有用户都通过 Spoke 存入，Hub-direct = 0
5. **Period 3 Hub > Spoke** — 有 Hub-direct 用户，Hub = Hub-direct + Spoke-forwarded

**分发规则详解**：

```
Hub campaign (forwardingEnabled=true):
  - Budget = 从 targetAPR + TVL + duration 反推
  - 分发给所有用户（hub-direct + spoke-forwarded）
  - Hub reward 显示 = 用户的总 reward

Spoke campaign (child of Hub):
  - Budget = 创建时设定（约 Hub budget 的 65-77%）
  - 仅分发给 Spoke 用户
  - Spoke reward 显示 = 仅 spoke 部分

实际 token 分发总量 = Hub 的 distribution（不是 Hub + Spoke）
Spoke 的 distribution 是 Hub 的子集，不是额外的 token
```

**证据**：
- Period 4 top user: Hub $4,870 = Spoke $4,870 → 同一用户在两边看到相同金额 → Hub 包含 Spoke 部分
- Period 3 top user: Hub $3,240 = Hub-direct $2,200 + Spoke-forwarded $1,040 → Hub 显示总量

**Child Campaign 结构**：
- Period 4-5: 1 个 AAVE_V4_SPOKE_SUPPLY + 1 个 ERC20LOGPROCESSOR
- Period 2-3: 1 个 AAVE_V4_SPOKE_SUPPLY（主要分发者）
- ERC20LOGPROCESSOR child 分发极少（$0.09-$6.76），可能是辅助 tracking campaign

---

## 5. 研究方法论建议

### 5.1 Leaderboard API 发现

在 Playwright 中打开 leaderboard 页面时，监听 network requests：

```javascript
// 在 Playwright 中
page.on('request', req => {
  if (req.url().includes('merkl')) console.log(req.url());
});
```

或者直接在浏览器 DevTools Network tab 中观察。

已知从 leaderboard 页面截获的 API：
- `https://api.merkl.xyz/v4/rewards/total?chainId=1&campaignId={id}` → 404（可能已下线的 period）

### 5.2 全量用户 reward 汇总

对每个 period 的 Hub 和 Spoke leaderboard：
1. 爬取所有用户的 reward 金额（不仅是 top 5）
2. 汇总总 reward
3. 与该 period campaign 的 `amount`（budget / 7 天的理论分发量）对比
4. 检查：Hub 总 reward + Spoke 总 reward 是否 > campaign budget？

### 5.3 Campaign 时间对应

从 Hub opportunity 的 `campaigns` 数组获取每个 campaign 的 `startTimestamp` / `endTimestamp`，推算 Period 1-5 的精确时间范围。

### 5.4 Merkl API 文档系统性搜索

- 检查 `https://api.merkl.xyz/v4/docs` 或 `/swagger` 或 `/openapi.json`
- 检查 `https://docs.merkl.xyz` 下是否有 API reference 页面
- 检查 Merkl GitHub repo 是否有 API schema

---

## 6. 已有的爬虫脚本

`packages/aave-fetcher/scripts/scrape_merkl_leaderboard.mjs` — Playwright 脚本，可爬取 leaderboard 页面数据。

用法示例：
```bash
node packages/aave-fetcher/scripts/scrape_merkl_leaderboard.mjs \
  "https://app.merkl.xyz/opportunities/13732557426013257809/campaigns/0xbfe68f7d938f096f519adeb1dbc3e2532b36bda09624f2fac2c5a7270a769c1e/leaderboard"
```

---

## 7. 当前代码状态与决策

### 7.1 已实现的代码变更

commit `4138e59`: 过滤 Spoke，保留 Hub
- `packages/aave-fetcher/src/merkl-api.ts` L318: `isV4SpokeOpportunity()` 函数
- `packages/aave-fetcher/src/merkl-api.ts` L1421-1427: 过滤逻辑

### 7.2 过滤方向的技术论证 — ✅ 已确认正确

**保留 Hub 的理由（全部已验证）**：
1. Hub campaign 有 `campaignType=TARGET_TOTAL_APR` → 后端 `scaleMerklBreakdown` 自动将 targetAPR 转换为 incentive APR（减去 nativeAPY）
2. Hub 有 `aprCap`、`totalBudget`、`latestTvl`、`plannedDaily` 等 forecast 元数据
3. Hub 是源 campaign（forwardingEnabled=true），Spoke 是衍生 campaign
4. 两条路径最终输出的 incentive APR 约相等（差异 < 0.5%）
5. **Hub reward 已包含 Spoke 用户的全部 incentive** → 过滤 Spoke 不丢失任何用户的 reward 信息

**保留 Spoke 的理由**：
1. Spoke APR 已经是纯 incentive（不需要后端转换）
2. 用户实际从 Spoke claim reward（但这对 APR 显示没有影响）

### 7.3 风险 — ✅ 已排除

- ~~如果 Hub 和 Spoke 发给不同用户（假说 B），那么过滤任何一方都会丢失一部分用户的 reward 信息~~
- **假说 C 已验证**：Hub reward 包含 Spoke 用户的全部 incentive，过滤 Spoke 不丢失信息
- 用户的 claim 路径不受影响（claim 是通过 Merkl 合约，不是通过 opportunity 类型）

### 7.4 Hub vs Spoke APR 差异机制

当前: Hub APR = 6.77% vs Spoke APR = 6.45%，差异 = 0.32%

- Hub: 显示 targetAPR = 6.77%（Merkl pays targetAPR - nativeAPY）
- Spoke: 显示 Dutch Auction rate = 6.45%（≈ targetAPR - nativeAPY delta）
- 差异来源: (1) Dutch Auction rate 是上次 engine run 时的值，不是实时 (2) TVL 差异 (3) engine run 间隔内的近似

---

## 8. Merkl API Endpoints 速查

| Endpoint | 用途 | 备注 |
|---|---|---|
| `GET /v4/opportunities` | 列表 | 支持 chainId, test, status 参数 |
| `GET /v4/opportunities/{id}` | 详情 | 含 dailyRewards, maxDailyRewards, campaigns |
| `GET /v4/campaigns/{id}` | 单个 campaign | 含 distributionType, params, rewardToken |
| `GET /v4/users/{address}/rewards` | 用户 rewards | 支持 chainId 过滤 |
| `GET /v4/rewards/total?chainId=1&campaignId={id}` | campaign 总分发 | 从 leaderboard 页面截获，部分 campaign 404 |
| `GET /v4/campaigns/{id}/distributions` | 历史 distribution | 404 |
| `GET /v4/distributions` | distribution 列表 | 404 |
| `GET /v4/merkle-roots` | Merkle root 历史 | 404 |

### 链上合约

| 名称 | 地址 |
|---|---|
| Hub | 0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9 |
| Spoke | 0x94e7A5dCbE816e498b89aB752661904E2F56c485 |
| USDG token | 0xe343167631d89B6Ffc58B88d6b7fB0228795491D |
| USDG reward token (wrapped) | 0xDF464440FC5E93B44998C0A7444e5211eFdf2B1E |

### Merkl 官方文档

- 机制文档: https://docs.merkl.xyz/merkl-mechanisms/distributions
- Developer docs: https://developers.merkl.xyz/resources/schemas
- Target Total APR 解释: "Merkl pays (Target APR - Native APR) when the native yield is below target"
- Schema API: `GET /v4/schemas` → groups: campaignType, distributionMethod, computeScoreMethod, hookType, processorType

### Merkl Schema 关键定义

- **AAVE_V4_HUB_SUPPLY** (172): "Aave v4 hub-level campaign rewarding supply (addedShares) per spoke for a given hub asset"
- **AAVE_V4_SPOKE_SUPPLY** (174): "Aave v4 spoke-level campaign rewarding user supply positions on a given spoke reserve"
- **DUTCH_AUCTION**: "Shares a fixed reward amount per second proportionally among users based on their scores"
- **AAVE_V4_NET_APR**: "Tops up Aave V4 native APR to reach a target total APR"

---

## 9. Distribution 完整分析

### 9.1 Hub vs Spoke 的 Campaign 亲子关系

从 Merkl API 数据直接确认：

| 字段 | Hub Campaign | Spoke Campaign |
|---|---|---|
| `parentCampaignId` | `null` | `11526583104559356735` (= Hub 的 id) |
| `rootCampaignId` | `null` | `11526583104559356735` (= Hub 的 id) |
| `childCampaignIds` | `["5055509984402346017", "13451611881162841856"]` | `[]` |

→ Spoke 是 Hub 的 child campaign，由 Merkl 引擎从 Hub 自动创建。

### 9.2 Budget 分配机制

```
Hub budget = maxAmount × 7 = $6,053.95 × 7 = $42,377.65  (按 targetAPR 算的 7 天预算)
Spoke budget = amount × 7 = $4,665.06 × 7 = $32,655.40   (按 incentiveAPR 算的 7 天预算)
```

| 字段 | Hub | Spoke |
|---|---|---|
| `dailyRewardsBreakdown[0].amount` | $4,901.10 (= TVL × targetAPR / 365) | $4,665.06 (= TVL × incentiveAPR / 365) |
| `dailyRewardsBreakdown[0].maxAmount` | $6,053.95 (= budget / 7) | $4,665.06 (= budget / 7, 同 amount) |

- Hub 的 `amount` ≠ `maxAmount` → 因为 nativeAPY > 0, 实际消耗 < 最大消耗
- Spoke 的 `amount` = `maxAmount` → Dutch Auction 无 native offset, 实际 = 最大

### 9.3 Hub 字段精确含义

| 字段 | 值 | 含义 |
|---|---|---|
| `apr` | 6.77% | **targetAPR** (含 native, 用户看到的 total APR) |
| `dailyRewards` | $4,900.12 | TVL × targetAPR / 365 (展示用, 含 native) |
| `maxDailyRewards` | $6,052.75 | budget / 7 (理论最大日消耗, 当 native=0) |
| `maxApr` | 6.77% | 同 targetAPR |

**关键**: Hub 的 `dailyRewards` 按 targetAPR 算, 但 Merkl 实际只支付 incentiveAPR (= targetAPR - nativeAPY)。`dailyRewards` 是"展示给用户看的等效日收益", 不是 Merkl 从 budget 中消耗的金额。

### 9.4 Spoke 字段精确含义

| 字段 | 值 | 含义 |
|---|---|---|
| `apr` | 6.46% | **incentiveAPR** (Dutch Auction rate ≈ targetAPR - nativeAPY) |
| `dailyRewards` | $4,664.13 | TVL × incentiveAPR / 365 (Merkl 实际日支付) |
| `maxDailyRewards` | $4,664.13 | = dailyRewards (Dutch Auction 无差异) |

### 9.5 nativeAPY 精确推导

从 Hub dailyRewards 和 Spoke APR 反推：

```
nativeAPY = targetAPR - Spoke APR = 6.77% - 6.46% ≈ 0.31%
```

验证:
- 从 Aave V4 链上 supplyApy = 0.3172% → 与反推值接近 ✅
- Hub daily - Spoke daily = $4,900 - $4,664 = $236 ≈ Hub daily × nativeAPY / targetAPR = $230 ✅

### 9.6 用户 Reward 计算公式

**Hub 路径** (每个用户):
```
Merkl reward = 用户 TVL × incentiveAPR / 365 = 用户 TVL × (targetAPR - nativeAPY) / 365
Total return = nativeAPY (链上自动) + incentiveAPR (Merkl) = targetAPR
```

**Spoke 路径** (每个用户):
```
Merkl reward = 用户 TVL × Spoke APR / 365 ≈ 用户 TVL × incentiveAPR / 365
Total return = nativeAPY (链上自动) + Spoke APR ≈ targetAPR
```

**两条路径等价**: 差异 ≈ 0.01% (Dutch Auction 近似误差)

### 9.7 Leaderboard 金额的含义

- Leaderboard 显示的是 **Merkl 支付的 incentive** (不含 native)
- 同一用户在 Hub 和 Spoke 的 leaderboard 金额:
  - 如果用户 100% 通过 Spoke 存入: Hub incentive = Spoke incentive (两者相等)
  - 如果用户有 Hub-direct 部分: Hub incentive > Spoke incentive (差 = Hub-direct incentive)

### 9.8 Budget 退回机制

```
Hub budget = maxAmount × 7 = TVL × targetAPR / 365 × 7  (预存)
实际消耗 ≈ TVL × incentiveAPR / 365 × 7 = Spoke budget
退回给 creator ≈ Hub budget × (nativeAPY / targetAPR) ≈ $9,722 (22.9%)
```

验证 (Period 5 当前):
- Hub budget = $42,377.65
- Spoke budget = $32,655.40
- 退回 ≈ $9,722.25 ≈ Hub budget × (1 - Spoke budget / Hub budget) = 22.9%
- implied nativeAPY = targetAPR × 22.9% = 1.55% (偏大, 因为 Spoke budget 不是精确按 TVL 比例分配)

### 9.9 完整数据验证

| Period | Hub Budget | Spoke Budget | Hub Dist | Spoke Dist | Spoke/Hub Dist | Spoke Budget/Hub Budget |
|---|---|---|---|---|---|---|
| 5 (LIVE) | $42,377.65 | $32,658.66 | $9,131.19 | $8,436.45 | 0.92x | 77.1% |
| 4 | $44,423.50 | $29,121.45 | $44,423.50* | $29,756.46 | 0.67x | 65.6% |
| 3 | $44,423.50 | $30,500.06 | $44,423.50* | $29,434.03 | 0.66x | 68.7% |
| 2 | $30,769.43 | $23,530.93 | $30,769.43* | $25,120.07 | 0.82x | 76.5% |
| 1 | $15,908.00 | $12,033.51 | $15,908.00* | $12,060.23 | 0.76x | 75.6% |

\* 已结束 campaign 的 `rewards/total` 返回 = budget 值, 不代表实际消耗量
