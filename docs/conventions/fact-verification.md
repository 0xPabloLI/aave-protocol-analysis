# Fact Verification Procedures

> 规则本体在 `docs/agents/proposal-review.md`（§3 事实双源、§4 新工具准入）；本文件是操作程序。加载时机：执行 proposal-review §3/§4 检查时。

## 源码验证链（库/框架功能支持）

1. 包管理器确认版本（`npm ls <pkg>`、`npx --no-install <pkg> --version`）；
2. `Grep` 读实现与默认值（优先 `node_modules/<pkg>/dist` 与 `src`，不只看 README）；
3. 用正确 API 做最小 smoke test（本 repo 用 `npx tsx` 跑单文件脚本，不写临时测试文件）；
4. 再查文档/网络讨论作为补充；冲突时以源码与实际调用为准——文档常滞后于代码。

## CLI / 工具存在性

`command -v` / `--help` + 官方文档双源确认。本机特有坑：`timeout` 不存在（BSD 无 GNU 版），探网络用 `GIT_TERMINAL_PROMPT=0 git ls-remote` 带超时，不要用 `timeout` 包裹。

## 网络讨论的解读边界

网络讨论反映**已报告**的问题，不代表**已修复**状态。要证明当前版本行为，必须本地复现。

## 数值性事实（定价 / 费率 / 资源分配）

必须查官方定价页或官方 CLI；不能以模型记忆为准——同一平台可能有多套定价（标准 compute 与 Sandbox）。本 repo 的链上数值（RAY、decimals、USD 换算）另按 AGENTS.md「Data Validity Rule」核对 `data/debug/` 实际文件，`raw` 与 `value` 不可互换。

## 新工具 / 框架 / 服务引入前维护状态检查

1. 仓库是否 archived（`gh repo view --json isArchived`）；
2. 最近 commit 日期（`gh api repos/<owner>/<repo>/commits?per_page=1`）；
3. open/closed issue 活跃度；
4. 是否有新 release。

已停止维护或超 6 个月无新 commit 的项目不得推荐引入——平台 API 变更后无人修复会直接变生产故障。存在活跃 fork / 新 maintainer 时，作为独立候选重做本节检查，而不是把「计划中会维护」当作豁免。

## 平台事实（本 repo 高频）

- **Railway 部署**：push 即部署（`railway`→staging、`main`→production）；CI 失败不是「拦住部署」而是「跳过部署」（deployment `SKIPPED`，旧 commit 继续服务且 `/health` 仍 `ok`）→ 必须轮询 `/health` 的 `commitSha` 才能确认生效。
- **本机 npm registry** 是 npmmirror，`npm audit` 端点未实现 → audit 类结论要用 `npm_config_registry=https://registry.npmjs.org` 复跑才可信。
- **GitHub 连通性**不稳定：`curl 52/56`、75s connect timeout 都出现过；推送/查询结论以 `git ls-remote` 回读为准，不以单次命令返回码为准。
