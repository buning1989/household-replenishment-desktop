# 对话 Agent 路由说明

> 适用版本：AgentPlan 第一阶段（与 AgentDraft 并存）
> 关联代码：`src/agent/householdOrchestrator.ts` `decideSync()`、`src/agent/orchestrator.ts`

## 总览

用户在 403管家对话框输入一句话后，所有路径都先经过 `orchestrator.decide()`。`decideSync()` 按固定优先级判定，命中本地规则就返回 sync turn；未命中时返回 `needLlm`，由 `App.tsx` 调 LLM 并回 `normalizeLlmResponse` 归一化。

判定优先级：

1. pending plan 状态机（confirm / cancel / revise / pendingStatus）
2. pending batch（订单导入后的逐条/全部确认）
3. pending proposal（旧 AgentDraft 状态机）
4. writeDraft 意图：clarification → planner（plan-only）→ 旧 AgentDraft → LLM
5. 边界分类：identityOrMeta / realtimeExternal / casual 直接回 sync answer；adjacentHomeLife 交 LLM

下面四类是落地后的实际分流。

## 1. 继续走 AgentDraft 的场景

旧 `AgentDraft` 协议保持不变，覆盖单条草稿 + 确认/取消/修订 + 内联编辑。

| 场景 | 触发示例 | turn 类型 |
| --- | --- | --- |
| 简单补货（已有物品） | "帮我加一袋猫砂"（state 中已有"猫砂"） | `proposal` (restock draft) |
| 简单新建消耗品 | "帮我加一袋猫砂"（state 中无"猫砂"） | `proposal` (createItemWithRestock draft) |
| 通知补货 | 通知中心"补货"按钮触发的草稿 | `proposal` (restock draft) |
| 订单导入逐条草稿 | 订单截图识别后逐行确认 | `proposalBatch` → 批量草稿 |
| 订单导入对话修正 | "全部确认" / "第 2 个跳过" / "价格都改成 59.9" | `planCommand` (batchConfirm/batchCancel/batchReviseIndex/batchReviseAll) |

**为什么保留**：单条草稿的 confirm/cancel/revise/inline-edit 已经稳定，AgentPlanCard 不提供内联字段编辑，强行替换会丢失"45 补价格"、"京东 补平台"这种对话式修订的兼容性。

## 2. 走 AgentPlan 的场景

新 `AgentPlan` 协议覆盖 AgentDraft 无法表达的能力。plan-only 句式走 `planProposal` turn，UI 渲染 `AgentPlanCard`。确认前不写 state；确认后由 `commitAgentPlan → applyAgentAction → domain` 统一写入。

| 场景 | 触发示例 | 生成 action |
| --- | --- | --- |
| 建分类 | "新建一个宠物用品分类" | `createCategory` |
| 设置预算 | "这个月预算设成 500" | `setMonthlyBudget` |
| 修改消耗品周期 | "猫砂周期改成 20 天" | `updateItem` (cycleDays) |
| 多动作组合计划 | 后续阶段支持（如"加一袋猫砂并把猫粮周期改 30 天"） | 多 action 数组 |
| 未来产品操作 | 重命名 / 删除 / 移动 / 常购商品编辑 / 提醒设置 | 第二阶段补 |

**plan-only 判定**：planner 返回的 plan 中只要含 `createCategory` / `setMonthlyBudget` / `updateItem` 任一，就走 `planProposal`；否则回退到旧 AgentDraft。

**风险分级**：createCategory / createItem / recordRestock / addPurchaseOption / setMonthlyBudget 为 `low`；updateItem / updateRestockRecord 为 `medium`；删除类（第二阶段）为 `high`。

## 3. 走只读查询的场景

查询意图不写 state，默认交 LLM 回答。LLM 失败时由 `answerHouseholdQuickly` 兜底（基于 buildQueryFacts 的本地事实）。

| 场景 | 触发示例 | 路径 |
| --- | --- | --- |
| 时段补货 | "今天优先补什么" / "这周可能要补什么" | needLlm → LLM；失败用 quick answer |
| 预算查询 | "本月预算还剩多少" / "这个月花了多少" | needLlm → LLM；失败用 quick answer |
| 价格异常 | "哪些价格异常" / "最近哪笔买贵了" | needLlm → LLM；失败用 quick answer |
| 信息缺失 | "哪些信息还缺" / "还差什么没填" | needLlm → LLM；失败用 quick answer |

**注意**：查询意图的 WRITE_SIGNALS 匹配已收紧。例如 "月预算" 不在 WRITE_SIGNALS 里，避免 "本月预算怎么样" 被误判为写入；只有 "预算设/预算改/预算调成" 才触发 writeDraft。

## 4. 走边界回复的场景

非管家问题不再统一机械拒绝，由 `classifyConversationBoundary` 分流。

| 边界类型 | 触发示例 | 回复策略 |
| --- | --- | --- |
| identityOrMeta | "你是谁" / "你能干什么" | sync answer（说明 403管家功能，不调 LLM） |
| realtimeExternal | "明天天气咋样" / "今天新闻" / "股票" | sync answer（说明无实时信息能力，引导回家务/补货，不编造） |
| casual | "你好" / "谢谢" / "辛苦了" | sync answer（自然应答） |
| adjacentHomeLife | "明天适合洗衣服吗" / "猫砂买哪种好" | needLlm → LLM；LLM 失败时用 `composeBoundaryAnswer` 兜底 |
| unsupported | 其他不支持的问题 | sync answer（说明边界并引导至可处理事务） |

## 并存原则

AgentPlan 是未来主方向，但当前阶段必须与 AgentDraft 并存：

- **不替换**：restock / createItem / createItemWithRestock 继续走旧 AgentDraft，保持 confirm/cancel/revise/inline-edit 不变。
- **不混用**：同一个 turn 要么是 `proposal`（AgentDraft），要么是 `planProposal`（AgentPlan），不允许同时携带 `agentDraft` 和 `agentPlan`。
- **不绕过**：所有写入必须经 `commitAgentDraft` / `commitAgentDraftBatch` / `commitAgentPlan`，不允许在 `App.tsx` 里手写新的 agent 写入逻辑。
- **typed command**：批量意图和 plan confirm/cancel 一律走 `AgentPlanCommand`（`planConfirm` / `planCancel` / `batchConfirm` / `batchCancel` / `batchCancelIndex` / `batchReviseIndex` / `batchReviseAll`），不再使用 `__BATCH_CONFIRM__` 等魔法字符串。

## 第二阶段方向（本期不实现）

- 重命名 / 删除 / 移动 / 常购商品编辑 / 提醒设置
- 多动作组合 plan（如"加一袋猫砂并把猫粮周期改 30 天"）
- LLM 直接输出 AgentPlan JSON（当前 LLM 仍只输出 AgentDraft / queryAnswer / clarification）

第二阶段必须在第一阶段全绿并完成手动验收后启动。
