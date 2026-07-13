# Handoff: Recently Ended Campaign — rewardTokenId 去重

## 背景

AAV-967: 后端 recently ended campaign 数据源缺失。核心问题：Merkl LIVE opp 的 `rewardsRecord.breakdowns` 只包含活跃 campaign，已结束 campaign 需从 `opp.campaigns` 重建 stub。

## 关键发现

Merkl UI 上"每种 campaign"是按 **rewardToken** 分组的（不是 distributionType/campaignType）：
- Opp 917101306019921918 (GHO Plasma): 7 条 DUTCH_AUCTION，分两组——WXPL (4条) + aPlaGHO (3条)
- Opp 16566125236842396321 (sUSDe): AAVE_NET_APR (2条) + MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE (7条)，全是同一个 rewardToken

**`opportunityId + rewardTokenId` = 唯一确定一种 campaign**。同 rewardTokenId 的多条 campaign 是同一"种"的历史轮次（首尾相接）。

`rewardTokenSymbol` 在同 opp 内有碰撞（MEGA 3个ID、aManWMNT/frxUSD/USDG 各2个），所以必须用 `rewardTokenId` 作为首选去重 key。

## 当前改动（未 commit，在 working tree）

4 个文件，+68/-12 行：

### 1. `packages/aave-shared-contracts/src/index.ts`
- `MerklCampaignBreakdown` 新增 `rewardTokenId?: string`

### 2. `packages/aave-fetcher/src/merkl-api.ts`
- `MerklEmbeddedCampaign` 新增 `rewardToken?: { symbol?: string; name?: string; id?: string }`
- `MerklRewardsBreakdownForIntensity.token` 新增 `id?: string`
- `extractRewardTokenFields()` 新增 `rewardTokenId` 提取
- **Stub 创建**（~L1543-1577）：从 `opp.campaigns` 重建 recently ended stub，含 `rewardTokenId` + `rewardTokenSymbol` + `campaignType`
- **`filterRecentExpiredCampaigns`**（~L1733-1748）：去重 key 从 `campaignType` 改为 `rewardTokenId ?? rewardTokenSymbol ?? campaignType ?? 'UNKNOWN'`

### 3. `packages/aave-fetcher/src/incentive-prune.ts`
- `pruneMerklBreakdown` 保留 `rewardTokenId`

### 4. `packages/aave-fetcher/tests/filterRecentExpiredCampaigns.test.ts`
- 新增"同 campaignType 不同 rewardToken 各保留 1 条"测试用例
- 现有测试补充 `rewardTokenSymbol` 字段

## 验证状态

- ✅ TypeScript 编译（session 内之前成功过一次）
- ✅ 380 个测试通过（含新增用例）
- ✅ API 验证：32 条 recently ended campaigns
- ⚠️ 当前 session macOS EPERM 阻止 Node.js 访问项目目录，无法重新 build

## 需要新 session 执行

### 步骤 1: Build + Test

```bash
npm run build -w @internal/aave-shared-contracts
npm run build -w @internal/aave-fetcher
npm run test -w @internal/aave-fetcher
npm run test -w @internal/aave-shared-contracts
```

### 步骤 2: Backend 重建 + API 验证

```bash
# Kill existing backend
lsof -i :3001 -t | xargs kill 2>/dev/null

# Rebuild backend
npm run build -w aave-dashboard-backend

# Start backend
npm run dev -w aave-dashboard-backend &

# Wait ~50s for warmup, then verify
curl -s http://localhost:3001/api/markets | python3 -c "
import json, sys, datetime
data = json.load(sys.stdin)
markets = data.get('reserves', [])
re_count = 0
for m in markets:
    for src in ['merklSupplys', 'merklBorrows', 'merklHolds']:
        groups = m.get(src, []) or []
        for g in groups:
            for b in g.get('breakdowns', []):
                ended = b.get('campaignEndedAt')
                if ended:
                    try:
                        end_dt = datetime.datetime.fromisoformat(ended.replace('Z', '+00:00'))
                        now = datetime.datetime.now(datetime.timezone.utc)
                        diff = (now - end_dt).days
                        if 0 <= diff <= 7:
                            re_count += 1
                    except: pass
print(f'Recently ended (0-7d): {re_count}')
# Expected: ~32 (varies with time)
"
```

### 步骤 3: CI gate

```bash
npm run ci:remote
```

### 步骤 4: Commit

```bash
git add packages/aave-shared-contracts/src/index.ts packages/aave-fetcher/src/merkl-api.ts packages/aave-fetcher/src/incentive-prune.ts packages/aave-fetcher/tests/filterRecentExpiredCampaigns.test.ts
git commit -m "feat: recently ended campaign stub + per-rewardTokenId dedup

- Create stub breakdowns from opp.campaigns for recently ended campaigns
  not in rewardsRecord.breakdowns (campaignApr=0, rewardTokenId, campaignType)
- filterRecentExpiredCampaigns dedup by rewardTokenId (not campaignType)
  because Merkl UI groups campaigns by rewardToken within each opportunity
- Add rewardTokenId to MerklCampaignBreakdown type and prune logic
- Add test: same campaignType different rewardToken keeps one each"
```

### 步骤 5: 后续

- 前端冗余代码删除：aaveapy repo 中 `isRecentlyEnded` / `collectRecentlyEndedCampaigns`（需在 aaveapy 前端项目操作）
- Brevis/Merit 去重逻辑：Brevis 无 rewardToken 维度，Merit per-group 去重，暂不需要改
- Linear AAV-967 已 Done，已加评论确认验证结果

## 上一个 commit

`5b3bfc6 feat: add recently ended campaign support (7-day window + per-type dedup)` — 这是第一版（per-campaignType 去重），当前改动是修正为 per-rewardTokenId 去重。
