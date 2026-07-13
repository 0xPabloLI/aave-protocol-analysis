# OOM 修复 Handoff — 待讨论项

## 状态：需要进一步讨论

修复了 truthy-gate bug（commit d9cad34 → fcbf02d → aa62283），线上已不再重试。但**内存泄漏的真正根因仍需确认**。

---

## 关键质疑：反复 fetch 一个 key 会造成 OOM 吗？

用户指出：每分钟 fetch 一次 `ethereum-new-sgho-boost`，fetch 完内存就释放了，怎么会造成 OOM？

### 旧部署日志事实

| 证据 | 值 |
|------|-----|
| `missing=[name,message]` 频率 | 每 ~1 分钟 |
| Worker 请求 | #305-#307，429s=287-289 |
| Worker launches | 0（从未成功启动浏览器） |
| Puppeteer fallback | 触发了（needDynamicCampaignInfo=true），但提取结果为空 |
| heap 波动 | 269-325MB，周期 ~2min，**无单调增长** |

### 我的分析存在的问题

1. **"反复 fetch 导致 OOM" 不成立**：heap 在 269-325MB 波动，GC 后回落，不是泄漏
2. **"Puppeteer 反复启动导致内存泄露" 不成立**：launches=0，Puppeteer 是本地 fallback，每次启动后关闭
3. **修复后 heap 降低 ~50MB**（260-279MB vs 269-325MB），但这可能只是因为不再触发 Worker 请求的 HTTP 开销

### 那真正的 OOM 根因是什么？

**【猜测，未验证】** 可能的原因：

1. **metricsCache 无界增长**（P2，已修复 bf88358）— 长期累积最可能的泄漏源
2. **workerDisabledResolvers 累积**（P1，已修复 bf88358）— Array→Set
3. **其他未发现的泄漏** — 需要用 `--inspect` 或 heap snapshot 确认

OOM crash 发生在 ~485MB heap。旧部署日志只覆盖了最后 ~15 分钟，看不到长期增长趋势。需要 Railway metrics API 获取 24h 内存曲线才能确认。

---

## 修复触发 Worker 429 的逻辑链

```
ethereum-new-sgho-boost 缓存中 name=undefined, message=undefined
  → isCachedTimeRangeComplete: missing=[name,message]
  → needsUpdate=true → keysToFetch=[ethereum-new-sgho-boost]
  → fetchMeritTimeRange
    → P1: extractCampaignInfo(html) → [] (静态 HTML 没有 action pattern)
    → needDynamicCampaignInfo = true (shouldFetchMessage && message.length === 0)
    → extractMeritDynamicInfoWithBrowser
      → Worker: 429 rate limited
      → Puppeteer fallback: 启动浏览器 → 提取 → 空
    → result.name = undefined (旧代码 if(name) 不赋值)
    → result.message = undefined (旧代码 if(msg.length>0) 不赋值)
  → 缓存写入: truthy spread 过滤掉 undefined
  → 下个周期: 重复
```

**关键**：`needDynamicCampaignInfo = shouldFetchMessage && message.length === 0`。只要 P1 静态提取不到 message（如客户端渲染的页面），就会触发 Worker/Puppeteer。这与 hasSelfAuth 无关。

---

## 待讨论和验证项

### 1. 真正的 OOM 根因
- 需要获取长期内存数据（24h+）确认是否单调增长
- metricsCache pruning 是否足够？
- 是否需要 heap snapshot 分析？

### 2. Docker 中 Puppeteer 能否正常启动？
- 本地验证通过：能启动 Chromium、渲染页面、提取内容
- Docker 中 puppeteer 是 prod dep，postinstall 下载 Chromium
- 但 **Docker 和本地环境有差异**（系统库、headless 模式、字体）
- 需要在 Docker 中实际测试 Puppeteer 启动

### 3. "提取成功但不是目标类型" vs "提取失败" 的区分

当前两种情况都返回 `name:""`, `message:[]`，语义不区分：

| 场景 | 当前结果 | 应有的语义 |
|------|----------|-----------|
| 提取失败（网络错误、HTML 解析失败） | `name:undefined` → 重试 | 正确：应该重试 |
| 提取成功但页面没有 supply/borrow（如 sgho-boost） | `name:undefined` → 重试 | **错误**：不是目标 incentive 类型，不应重试 |
| 提取成功，有 supply/borrow（如 celo-supply-usdt） | `name:"Supply USDT"` → complete | 正确 |

**建议**：引入 `extractionOutcome` 字段，区分：
- `"not_attempted"` → undefined → 重试
- `"extracted_empty"` → 确认不是目标类型 → 标记 complete，不再重试
- `"extracted_content"` → 有内容 → complete

### 4. endDate 修改的隐患

修改范围：

| 位置 | 变更 |
|------|------|
| `isCachedTimeRangeComplete` endDateOk | `!!endDate && trim!==""` → `endDate !== undefined` |
| `isCachedTimeRangeComplete` hasEndIndicatorOk | 增加 `endDate !== undefined` 判断 |
| `isCachedTimeRangeComplete` missing push | 增加 `endDate === undefined` 条件 |
| `loadCachedMeritCampaignMetadata` isValidEntry | `hasRequiredFields` → `hasLinkAndStart && (hasEndIndicator \|\| endDate!==undefined)` |
| `loadCachedMeritCampaignMetadata` endDate 写入 | `endDate!` → `endDate ?? ""` |

**潜在隐患**：
- `endDate:""` 现在被视为 complete → 如果 endDate 真的需要有效值才能判断 campaign 是否结束，`endDate:""` 的条目会跳过刷新
- 但 `cachedCampaignEnded = isMeritCampaignMetadataEnded("")` → `parseMeritEndDate("")` → null → false → 不会因为 endDate="" 触发 ended refresh
- **实际影响**：`ethereum-new-sgho-boost` 的 endDate 是 `"Wed Jun 17 2026"`（有值），所以 endDate 修改对当前 case 无实际效果

**建议**：endDate 修改是鲁棒性增强，不是解决当前 bug 必须的。如果担心隐患，可以 revert endDate 部分的修改，只保留 name/message 的修复。

---

## 已完成

- ✅ truthy-gate 修复（检查路径 + 写入路径 + 源值路径）
- ✅ 线上部署验证：0 campaigns need update，0 Worker 429
- ✅ 204 测试通过
- ✅ Self Auth 提取顺序文档 (`aaveapy-doc/merit-self-auth-extraction.md`)
- ✅ Linear AAV-781（endDate 语义统一 + data 目录重复）

## 需要新 session 继续

- Docker Puppeteer 启动验证
- 长期内存趋势分析
- "提取成功但非目标类型" 的语义设计
- endDate 修改是否 revert 的决策
