# Proposal Review

> 给出代码、架构、工具、服务、模型或流程修改建议前执行。目标是让建议可追溯、影响面完整，并区分事实与推断。
> 底本 `~/Documents/code/agent-harness/core/proposal-review.md`；本 repo 的适配点：影响面检查对齐 monorepo 边界与 Linear/ADR 落档，事实双源与 AGENTS.md「Learned Preferences」同源。

## 1. 因果依据

每个「A 导致 B」的判断必须有可追溯证据：代码行、运行日志、`backend/logs/*.log`、`/metrics`、测试、spec 或官方文档。单一相关数据点不能直接推出代码层根因。

效果数据显示现状不佳时，重新审视旧设计决策；优化建议同样要说明作用机制和验证方法。

## 2. 影响面

提出改动前搜索：

- 定义与所有调用方（monorepo 五个包，依赖方向 `shared-config ← shared-contracts ← fetcher ← root/backend`）；
- 测试与 fixtures（`tests/`、各包 `tests/`）；
- 文档、ADR（`docs/adr/`）、spec（`docs/plans/`）、Linear issue；
- 跨 step 生产者与消费者（fetcher 产 `RuntimeReserveData` → backend 序列化 `MarketWithSpread` → 前端消费，任一层改字段都要三处对齐）；
- 同一契约在其他实现中的副本（前端 `aaveapy` 的 `src/types/aave.ts`、zod schema、OpenAPI 生成物、schema fingerprint mirror）。

列出 Modified Files Impact，并说明现有行为、下游消费者、最坏后果和验证方式。不能把未搜索到证据表述为「不受影响」。

## 3. 事实双源

影响设计选择的外部事实至少用两个独立来源验证。优先级：

1. 本地安装版本、源码、CLI `--help`、最小 smoke test；后端以 staging 真实 payload（`https://staging-api.aaveapy.com/api/*`）为地面真值；
2. 官方文档、官方仓库、release 或定价页；
3. 网络讨论仅证明「有人报告过」，不能证明当前版本仍存在或已修复。

冲突时以本地源码和实际调用结果为准，并记录版本差异。工具/CLI 是否存在：本地可执行性 + 官方文档。定价、费率、资源分配必须以官方页或官方 CLI 为准。

操作程序见 `docs/conventions/fact-verification.md`。

## 4. 新工具准入

推荐引入新工具、框架或服务前检查：

- 官方仓库是否 archived；
- 引用其他 repo 时用 `gh repo view` 或 webfetch 验证确有其物（代码/权重），不能凭链接推断；
- 最近 commit 与 release 日期；open/closed issue 活跃度；
- license、商业使用限制、安全边界（本 repo 另有 `docs/ci-security-automation.md` 的 supply-chain 门：非安全升级需 ≥7 天 cool-down）；
- 与现有工具重叠度（比较实现质量，不以「已有同类」直接否决）；
- 最小本地 smoke test；
- archived 或最近 commit 超 6 个月 → 不推荐引入；有活跃 fork 需作为独立候选重做本节检查。

## 5. AI 模型参数

每个模型的推理参数只从其自己的 README / Model Card 官方示例出发，不跨模型复制 steps、CFG、cache、offload 等。建议前：确认本地版本 → 读源码默认值与条件分支 → 验证参数是否被覆盖 → 先跑官方基线再做单变量优化 → 记录质量/速度/内存/硬件。

## 6. 输出检查

建议至少包含：已验证事实、仍属假设的部分、推荐方案与被否决替代方案、修改影响面、验证计划、未解决风险。
