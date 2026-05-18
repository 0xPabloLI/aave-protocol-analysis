# Campaign 历史保留方案

Last updated: 2026-05-19

## 背景

后端 API 只返回活跃 campaign：过期 campaign 在 root fetcher 层被过滤，前端无法展示历史激励数据。本方案在后端层保留 campaign 历史，不改动 root fetcher。

## DB Schema

```sql
CREATE TABLE campaign_history (
  id              BIGSERIAL     PRIMARY KEY,
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,       -- 'merit' | 'merkl' | 'brevis'
  side            TEXT          NOT NULL,       -- 'supply' | 'borrow' | 'hold'
  campaign_key    TEXT          NOT NULL,       -- dedupe key
  campaign_data   JSONB         NOT NULL,       -- 完整 campaign 快照（比例值），含 start/end
  first_seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  expired_at      TIMESTAMPTZ                    -- NULL = 当前仍在活跃快照中
);

CREATE UNIQUE INDEX idx_campaign_history_dedup
  ON campaign_history (reserve_id, source, side, campaign_key);

CREATE INDEX idx_campaign_history_status_window
  ON campaign_history (expired_at, last_seen_at DESC);

CREATE INDEX idx_campaign_history_reserve_source_seen
  ON campaign_history (reserve_id, source, side, last_seen_at DESC);

-- APR 时间序列（append-only）。完整快照在 campaign_history 中，此处只存变化点和 hash。
CREATE TABLE campaign_apr_observations (
  id              BIGSERIAL     PRIMARY KEY,
  observed_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,
  side            TEXT          NOT NULL,
  campaign_key    TEXT          NOT NULL,
  apr             DOUBLE PRECISION NOT NULL,    -- 比例值，不是百分值
  apr_data_hash   TEXT          NOT NULL        -- APR 相关字段 hash，用于变化检测
);

CREATE INDEX idx_campaign_apr_observations_series
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at);

CREATE INDEX idx_campaign_apr_observations_latest_hash
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at DESC);
```

### `expired_at` 和 `endDate` 不是同一件事

- `endDate` / `campaignEndedAt`：campaign 自己声明的业务结束时间，前端展示用
- `expired_at`：后端检测到 campaign 不再出现在活跃快照的时间，API 状态过滤用
- 两者通常接近但不保证相等（上游可能提前取消、延期、短暂漏报）

### 两表职责

| 表 | 模式 | 职责 |
|----|------|------|
| `campaign_history` | UPSERT 去重，每个 key 一行 | 当前状态 + 生命周期（`first_seen_at` / `expired_at`）+ 完整快照 |
| `campaign_apr_observations` | append-only，APR 变化时追加 | APR 时间序列，绘制变化曲线 |

完整快照只在 `campaign_history` 中存一份，`campaign_apr_observations` 不存 `campaign_data`，需快照时 JOIN 即可。

## 去重键 campaign_key 规则

| source | campaign_key | 来源 |
|--------|-------------|------|
| `merit` | `link::endDate` | Merit 无 campaignId，link + endDate 唯一 |
| `merkl` | `campaignId` | breakdown 中的 campaignId（必填） |
| `brevis` | `campaignId` 优先，无则 `hash(link,campaignStartedAt,campaignEndedAt)` | Brevis campaignId 可选 |

## Cron 写入流程

persist cron（每分钟 :20）执行：

1. **UPSERT campaign_history**：遍历内存快照 7 个 campaign 数组，`ON CONFLICT DO UPDATE SET campaign_data = EXCLUDED.campaign_data, last_seen_at = NOW(), expired_at = NULL`
2. **标记过期**：`UPDATE SET expired_at = NOW() WHERE expired_at IS NULL AND last_seen_at < NOW() - 2min`
3. **APR observation append**：APR hash 变化时追加一行到 `campaign_apr_observations`

## campaign_data JSONB 结构

存内存快照原始形状（比例值），API 响应时走 `x100` 序列化。

### Merit

```json
{ "apr": 0.0235, "selfApr": 0.01, "link": "https://...", "name": "Merit Round 42", "message": [], "startDate": "2025-05-01T00:00:00Z", "endDate": "2025-05-15T23:59:59Z" }
```

### Merkl / Brevis（单 breakdown 拆组）

```json
{ "link": "https://...", "name": "Merkl Campaign", "breakdowns": [{ "campaignApr": 0.018, "campaignId": "0xabc...", "campaignStartedAt": "...", "campaignEndedAt": "..." }] }
```

Merkl/Brevis 多 breakdown 的 CampaignGroup 按单 breakdown 拆组存储，每个 breakdown 独立一行，group 的 `link` / `name` / `message` 携带在 JSONB 内。

## Phase 1 已完成 ✅

| # | 任务 | 状态 |
|---|------|------|
| 1 | DB migration (`008_campaign_history.sql`) | ✅ |
| 2 | `persistCampaignHistory()` UPSERT 写入 | ✅ |
| 3 | `markExpiredCampaigns()` 过期标记 | ✅ |
| 4 | `appendAprObservations()` APR 观测写入 | ✅ |
| 5 | cron 集成 (`updateScheduler.ts`) | ✅ |
| 6 | `campaign_apr_observations` 去冗余 `campaign_data` (`010_drop_campaign_data_from_observations.sql`) | ✅ |
| 7 | 单元测试 (`persistenceService.test.ts`) | ✅ |

**现状**：`campaign_history` 和 `campaign_apr_observations` 通过 cron 每分钟写入，但**没有任何 API 读取**。数据只写不读，是纯归档状态。

---

## Phase 2：历史数据 API（待实现）

### 前置决策

Phase 2 的**数据层**（API route、查询参数、响应结构）可独立定义，**展示层**（过期 campaign 在 UI 中的位置、APR 曲线图交互）依赖前端设计。

需先确定：

1. **API 形式**：独立 endpoint `/api/campaigns/history` vs 合并进 `/api/markets` 响应？
   - 独立 endpoint 优势：不污染热路径、查询参数灵活、可独立缓存
   - 合并进 `/api/markets` 优势：前端一次请求拿到全部数据
   - **建议独立 endpoint**，`/api/markets` 保持内存快照只读
2. **前端是否需要 APR 曲线图**：决定是否暴露 `campaign_apr_observations` 查询
3. **过期窗口**：默认返回多少天内的过期 campaign（7 天 vs 30 天）

### 任务清单

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 查询函数 | `persistenceService.ts` | `getCampaignHistory(options)` — 支持 reserveId / source / side / windowDays 过滤 |
| 2 | API route | `routes/campaignHistoryRouter.ts` | `GET /api/campaigns/history?reserveId=&windowDays=7` |
| 3 | 响应序列化 | 新增或复用 | `campaign_data` JSONB → x100 百分值 + 附带 `expiredAt` / `firstSeenAt` / `lastSeenAt` |
| 4 | 类型定义 | `types/` | 响应 DTO |
| 5 | server 集成 | `server.ts` | 挂载 route |
| 6 | 测试 | `tests/` | 查询逻辑 + API 集成测试 |

### 可选：APR 曲线 API

如果前端需要 APR 变化曲线：

| # | 任务 | 说明 |
|---|------|------|
| 7 | `getAprObservations(reserveId, campaignKey, range)` | 查 `campaign_apr_observations`，可选 JOIN `campaign_history` 取快照 |
| 8 | `GET /api/campaigns/apr-series` | 返回 `{ observedAt, apr }[]`，前端自行绘图 |
| 9 | 采样/聚合策略 | 长时间范围（>30 天）可按小时/天聚合减少数据点 |

### 不改动

- root `src/` 下任何文件
- `RuntimeReserveData` 类型
- fetcher 过滤逻辑
- `/api/markets` 热路径
