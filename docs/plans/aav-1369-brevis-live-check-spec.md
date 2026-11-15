# AAV-1369 — Brevis campaign copy / cap 的 live 检查

> **Status: Active** — 实现完成，待真 run 证据。

## 问题

`positionCapUsd` 不在 Brevis 的 gRPC 响应里，而是从 `incentra.brevis.network` 的
minified `_app` chunk 里刮出来的。AAV-1365 已经把「单条正则 + 两个字面量锚点」换成
「句式候选表 + 锚点候选表 + 归属门 + 失败上报」，但它仍然是抓取器：

- 上游改文案 → cap 变 `null` → 只有一条 `logger.warn`；
- 第一个发现的人，是几周后看到收益数字不对的人。

同样的失败形态在本仓已经出现过多次（AAV-1294 / 1330 / 1349 / 1352 / 1376 / 1378）：
**检查在无法验证时报告成功**。所以这次的目标不是「加一个日志」，而是「让无法解析
变成一个会开 issue 的红灯」。

## 交付

| 文件                                      | 作用                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/brevis-live-check.ts`            | 实网抓取 + 断言 + 报告；纯逻辑与 CLI 同文件，CLI 用 `import.meta.url === pathToFileURL(argv[1])` 守卫，单测可直接 import                          |
| `tests/brevisLiveCheck.test.ts`           | 15 例：断言矩阵（含 `null` / `cap=0` / 无持仓词 / 未知 type / type 全缺失 / gRPC 抛错）+ workflow 形状守卫 + `package.json`·`.gitignore` 接线守卫 |
| `.github/workflows/brevis-live-check.yml` | 每日 + 触碰 scraper 的 push；失败开/更新 issue，恢复时评论并关闭                                                                                  |
| `package.json` → `check:brevis-live`      | `tsx scripts/brevis-live-check.ts`                                                                                                                |

### 断言与理由

1. **copy 抓得到**（`fetchMetaMaskCampaignDescription()` 非 `null`）
   —— `null` 同时覆盖「不可达」和「锚点全缺」，两者都必须红：不可达不是「没有可报的内容」。
2. **`positionCap > 0` 且句式命中** —— 报告里直接给出 `pattern`（`p1`…`p5`）与命中的锚点对。
3. **文案里仍有 `collateral` / `debt`** —— 有数字但没有持仓措辞，说明抓到的可能是**交易量/预算**
   上限，不是持仓上限。这一条比「cap 非空」更接近真实风险。
4. **`campaign.type` 全在动作类型表内**（2001/2002/3001/5001/5002/5003/6001）
   —— fetcher 把所有 Brevis campaign 的 `campaignType` 硬编码成
   `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`，而这个假设没有任何检查盯住。`campaign.type`
   是唯一可观测的信号（它是 action type，但新机制如果出现，只会先在这里露出新值）。
5. **campaign 解析出来但 `type` 全缺失**是独立的失败码 `campaign-types-unobservable`
   —— 字段挪位不能被当成「所有 type 都合规」。

### 刻意不做的判断

- **gRPC 不可达 = 失败，不是 skip。** 与 AAV-1352 同一条规则：读不到的源不能渲染成
  「没东西要报」。第三方宕机本身就是激励链路降级。
- **零 campaign 不失败。** Brevis 跑不跑 Aave campaign 是它的业务决定，不是抓取缺陷。
  计数仍然写进 run summary，掉到 0 能看见，但不发明一个没人测过的阈值。
- **不另写解析。** 抓取与解析全部复用 `brevisApi`，否则这个检查验证的是另一份实现。

## 证据

### 实网（2026-11-15）

经代理跑通完整链路（本机 Node 的 DNS 解析不到 `incentra-prd.brevis.network`，
用 `undici` ProxyAgent 绕开；见「残余风险」）：

```
- positionCap: 5000 (pattern p1)
- markers: Eligible MetaMask → per user."
- protocols: 1, campaigns: 1
- campaign.type: 3001×1
✅ All assertions passed.     (exit 0)
```

直连跑（不绕代理）时：

```
- positionCap: 5000 (pattern p1)
- protocols: 0, campaigns: 0
❌ 1 assertion(s) failed:
- `grpc-unreachable`: getAaveCampaignsData() threw: fetch failed   (exit 1)
```

即：**copy 侧断言与 gRPC 侧的失败分流各自都真的走了**，不是纸面断言。

### 当日真实数据（顺带取证，不改代码）

- Brevis 目前只有 1 个 Aave protocol（Linea，`apr 2.4%`，`tvl 1.13M`），1 条 campaign，
  `campaign.type = 3001`（METAMASK），`campaign.status = 5`、`config.end = 1786147200`。
- `status 5` 被 `getAaveCampaignsData()` 过滤（`!== 4 && !== 5`），所以
  `index` 为 0 个 chain-token 组合 —— 与生产 `/api/markets` 里 brevis 计数为 0 一致。
  **这是「活动已结束」，不是解析回归**，因此检查不能断言「campaign 数 > 0」。

### 变异验证

| 变异                                                 | 结果                             |
| ---------------------------------------------------- | -------------------------------- |
| 删掉 `.gitignore` 的 `!scripts/brevis-live-check.ts` | 14 pass / **1 fail**（接线守卫） |
| 给检查 step 加 `continue-on-error: true`             | 14 pass / **1 fail**（假绿守卫） |

### 门禁

- `npx tsx --test tests/brevisLiveCheck.test.ts` → 15/15
- `npm test` → 84 passed / 0 failed
- `npm run lint` → 0 error / 289 warning（**未新增**；第一版 `evaluateBrevisLiveCheck` 复杂度 23
  已拆成 `copyFailures` / `mechanismFailures`）
- jscpd 3.65%（< 5%）、test-naming 118 文件、feature-flags、AGENTS.md drift 全部通过
- knip 仅剩既有的 `playwright` 环境相关 hint（不动）

## 残余风险

1. **定时触发器只认默认分支 `main`。** 本仓 `main` 落后 `railway` 百余提交，所以文件落在
   `railway` 时 `schedule:` 不会跑。为了不让它变成第 7 个「文件存在但从不运行」，workflow
   额外挂了一条 `push`（仅当 `packages/aave-fetcher/src/brevis-api.ts`、
   `scripts/brevis-live-check.ts` 或 workflow 自身变化时触发）。promotion（AAV-1292）之后
   定时才真正生效。
2. **本机 Node 解析不到 `incentra-prd.brevis.network`**（`dig` 能解析、`getaddrinfo` 不能，
   `curl --resolve` 到 34.212.219.119 返回 404 = 主机本身是活的）。因此本机直连跑必然红在
   `grpc-unreachable`；GitHub runner 上预期正常。**若 runner 也解析不到，这条检查会持续红**，
   那是上游/网络事实，不应靠放宽断言消掉。
3. **未知 `campaign.type` 的语义仍需人工判断**：它可能是新的 action type，也可能是新机制。
   检查只负责把它变成红灯，不替人下结论。
4. **报告只截 400 字文案。** 定位够用，但不构成完整的文案存档。
5. **`campaignType` 硬编码仍未改。** 本票只加检查，不动数据模型。

## Out of scope

- 为 Brevis 引入非 FIX 机制做实现（本票只报警）。
- 修 `campaign.status === 5` 被过滤后 index 为空的现状（活动确实结束了）。
- 把 `campaign.type` 落成对外字段。
