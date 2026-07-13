# Agent 决策入口重构 — 回归场景矩阵

> 阶段 4A 产出。把 2C / 3A / 3B / 3B.1 / 3C 的关键路径固化成一套可重复执行的回归验收矩阵。
>
> 配套 smoke：`npm run smoke:agent-focus-regression`（mock，不依赖真实 LLM）。
> 配套手工验收：见 [agent-manual-e2e-checklist.md](./agent-manual-e2e-checklist.md)。

## 阶段完成状态

| 阶段 | 内容 | commit |
|------|------|--------|
| 2C | pendingCollection 接入 turnInterpretation + focusResolver + LLM Turn Interpreter fallback | df28dce / 221dbb0 / 11917b1 / 8ef9b57 |
| 3A | pendingPlan 接入统一入口 | 4db87f2 |
| 3B | pendingDraft 接入统一入口 | ad3c971 |
| 3B.1 | trace hardening（llmInterpreter.called / skipReason / schemaValid） | ad3c971 |
| 3C | pendingBatch 接入统一入口 | 91004e8 |

## 通用验收原则

1. **是否调用 LLM 只看 `trace.llmInterpreter.called`**，不再看 `routeDecision.interceptedByRule`。
2. `interceptedByRule=true` 只表示「最终被本地路由规则接住」，可以和 `llmInterpreter.called=true` 同时成立。
3. 本地高置信路径 `llmInterpreter.called=false`，`skipReason=local_high_confidence`。
4. 低置信别名输入走 LLM Turn Interpreter，不应输出「超出家务范围」。
5. 新采购记录（含「买了」「补了」动词）必须识别为 `new_restock_record`，不被旧 pending 状态吞掉。
6. 旧 pending 状态在新 collection 成立后应被 supersede，下一轮不再抢焦点。

---

## 1. pendingCollection 场景

前置：用户输入「今天买了 5 包宠物擦脚巾湿巾」建立 pendingCollection。

| # | 输入 | 预期 focus | 预期 turn | 验收点 |
|---|------|-----------|----------|--------|
| 1.1 | 拼夕夕 | continue_pending_collection | collection（补 platform） | platform=拼多多（LLM mock 或本地别名） |
| 1.2 | PDD | continue_pending_collection | collection | platform=拼多多 |
| 1.3 | p'd'd | continue_pending_collection | collection | platform=拼多多（LLM Turn Interpreter） |
| 1.4 | 128 | continue_pending_collection | collection | price=128 |
| 1.5 | 不起灰 | continue_pending_collection | collection | review 含「不起灰」 |
| 1.6 | asdfasdf | route_to_llm | clarification | 不说「超出家务范围」；`llmInterpreter.called` 视 mock/real而定 |
| 1.7 | 今天买了 3 袋五常大米 | start_new_collection | collection（新建） | 物品名=五常大米；旧 collection 被 supersede |
| 1.8 | 按这个来 | continue_pending_collection（force_proposal） | proposal | 阶段 4B.1：与「就这样」一致；字段缺失也转 proposal（带未补全标记） |
| 1.9 | 按这个来（无 active pending） | route_to_llm | needLlm / answer fallback | 无对象可作用；不创建 collection / proposal / planCommand |

**测试覆盖**：
- `tests/agent-entry-routing.test.mjs`（13 条）
- `tests/agent-entry-llm-fallback.test.mjs`（12 条）
- `tests/turn-interpreter-llm.test.mjs`（14 条）
- `scripts/smoke-agent-llm-fallback.mjs`（8 case）

---

## 2. pendingPlan 场景

前置：用户发起删除物品请求，系统进入 `awaitingSecondConfirm` 状态。

| # | 输入 | 预期 focus | 预期 turn | 验收点 |
|---|------|-----------|----------|--------|
| 2.1 | 确认删除 | continue_pending_plan | planCommand（执行删除） | 二次确认删除不被绕过 |
| 2.2 | 确认 | continue_pending_plan | planCommand | 旧 plan handler 执行 |
| 2.3 | 算了 | continue_pending_plan | cancelled | 旧 plan handler 取消 |
| 2.4 | 今天买了 3 袋五常大米 | start_new_collection | collection（新建） | 旧 pendingPlan 被 supersede；不被「袋」误判为 reviseDraft |
| 2.5 | 按这个来 | continue_pending_plan（force_proposal） | planCommand | 阶段 4B：已纳入确认语义，在 plan 上下文视为确认 |

**测试覆盖**：
- `tests/agent-entry-pending-plan-routing.test.mjs`（11 条）

---

## 3. pendingDraft 场景

前置：存在 pendingDraft（如猫砂补货 proposal）。

| # | 输入 | 预期 focus | 预期 turn | 验收点 |
|---|------|-----------|----------|--------|
| 3.1 | 今天买了 3 袋五常大米 | start_new_collection | collection（新建） | 旧 pendingDraft 被 supersede；不被「袋」误判为 reviseDraft |
| 3.2 | 刚买了两瓶洗衣液 | start_new_collection | collection | 物品名=洗衣液 |
| 3.3 | 确认 | continue_pending_draft | proposal | 旧 draft handler 确认 |
| 3.4 | 取消 | continue_pending_draft | cancelled | 旧 draft handler 取消 |
| 3.5 | 改成 3 袋 | continue_pending_draft（兼容 reviseDraft） | proposal（qty=3） | 旧 revise 能力不破坏 |
| 3.6 | 记了吗 | continue_pending_draft（兼容 pendingStatus） | answer | 旧 status 能力不破坏 |
| 3.7 | 确认吧 | continue_pending_draft（force_proposal） | proposal | force_proposal 在 pendingDraft 上下文视为确认 |
| 3.8 | 按这个来 | continue_pending_draft（force_proposal） | proposal | 阶段 4B：已纳入确认语义，与「确认吧」一致 |

**测试覆盖**：
- `tests/agent-entry-pending-draft-routing.test.mjs`（16 条）

---

## 4. pendingBatch 场景

前置：订单导入后存在 pendingBatch（多条草稿待确认）。

| # | 输入 | 预期 focus | 预期 turn | 验收点 |
|---|------|-----------|----------|--------|
| 4.1 | 今天买了 3 袋五常大米 | start_new_collection | collection（新建） | 旧 pendingBatch 被 supersede |
| 4.2 | 刚买了两瓶洗衣液 | start_new_collection | collection | 物品名=洗衣液 |
| 4.3 | 昨天补了 10 卷纸 | start_new_collection | collection | 物品名=纸，qty=10 |
| 4.4 | 全部确认 | continue_pending_batch | planCommand(batchConfirm) | 旧 batch handler 确认 |
| 4.5 | 都确认 | continue_pending_batch | planCommand(batchConfirm) | 同义短语 |
| 4.6 | 全部取消 | continue_pending_batch | planCommand(batchCancel) | 旧 batch handler 取消 |
| 4.7 | 价格都改成 59.9 | continue_pending_batch | planCommand(batchReviseAll) | 旧 batch handler 修订 |
| 4.8 | 第一个跳过 | continue_pending_batch | planCommand(batchCancelIndex, index=0) | 旧 batch handler 索引取消 |
| 4.9 | 就这样 | continue_pending_batch（force_proposal） | planCommand(batchConfirm) | force_proposal 在 batch 上下文视为确认 |
| 4.10 | 可以了 | continue_pending_batch（force_proposal） | planCommand(batchConfirm) | 同上 |
| 4.11 | 按这个来 | continue_pending_batch（force_proposal） | planCommand(batchConfirm) | 阶段 4B：已纳入 FORCE_PROPOSAL_PATTERNS + CONFIRM_EXPLICIT_PHRASES，与「就这样」一致 |
| 4.12 | 就按这个来 | continue_pending_batch（force_proposal） | planCommand(batchConfirm) | 包含「按这个来」，命中同上 |

**测试覆盖**：
- `tests/agent-entry-pending-batch-routing.test.mjs`（23 条，含 3C-20/21/22/23 force_proposal 回归）

---

## 5. trace 场景

| # | 场景 | llmInterpreter.called | skipReason | schemaValid | interceptedByRule | 验收点 |
|---|------|----------------------|------------|-------------|-------------------|--------|
| 5.1 | 本地高置信输入 | false | local_high_confidence | — | true | 二者可同时为 false / true，不互相覆盖 |
| 5.2 | LLM mock 成功解释 | true | — | true | true | called=true 且 interceptedByRule=true 同时成立 |
| 5.3 | LLM mock 非法 JSON | true | — | false | — | rejectReason 存在；最终进入 clarification 或安全 fallback |
| 5.4 | 无 API key / 无 bridge | false | no_api_key / no_desktop_bridge | — | — | 不抛异常；trace 说明原因 |
| 5.5 | LLM client 抛异常 | true | — | — | — | error 存在；rejectReason 含 client_exception |
| 5.6 | pendingPlan / pendingDraft / pendingBatch 本地确认 | false | local_high_confidence | — | true | 与 5.1 一致 |

**测试覆盖**：
- `tests/agent-decision-trace.test.mjs`（28 条）
- `tests/agent-decision-trace-llm-called.test.mjs`（11 条）

---

## 6. supersede 机制验收

| 旧 pending | 新 collection 成立时 | 下一轮旧 pending | 验收点 |
|-----------|---------------------|-----------------|--------|
| pendingCollection | supersedeOldPendingCollection | 不再 active | 旧 collection 标 superseded |
| pendingPlan | supersedeOldPendingPlan | 不再 active | 旧 plan 标 superseded |
| pendingDraft | supersedeOldPendingDraft | 不再 active | 旧 draft 标 superseded |
| pendingBatch | supersedeOldPendingBatch | 不再 active | 旧 batch 所有 pending 项标 superseded |

**测试覆盖**：各 pending 状态的 routing 测试文件中均含 supersede 断言。

---

## 7. 决策路径优先级

`decideSync` 中的 handler 顺序（阶段 3C 后）：

```
1. pendingPlan   → handlePendingPlanFocusDecision（3A）
2. pendingCollection → handleCollectionFocusDecision（2B）
3. pendingBatch   → handlePendingBatchFocusDecision（3C）
4. pendingDraft   → handlePendingDraftFocusDecision（3B）
5. writeDraft     → handleWriteDraftIntent
6. boundary / LLM → handleBoundaryOrLlmFallback
```

每个 handler 内部：先用 `interpretUserTurn` + `resolveConversationFocus` 判断，只有 `continue_pending_*` 才走旧 handler；其他意图（新采购记录 / 查询 / 闲聊 / 低置信）不执行旧 handler，落到后续流程。

---

## 8. 回归验收命令

```bash
# 单元测试
npm test

# mock smoke（不依赖真实 LLM）
npm run smoke:agent-llm
npm run smoke:agent-focus-regression

# 真实 LLM smoke（需要 DASHSCOPE_API_KEY）
DASHSCOPE_API_KEY=<key> npm run smoke:agent-llm:real
```

验收标准：
- `npm test` 全部通过
- mock smoke 全部 PASS
- real smoke 有 key 则真实执行；无 key 则 skipped，exit code 0，**不能写成 passed**
