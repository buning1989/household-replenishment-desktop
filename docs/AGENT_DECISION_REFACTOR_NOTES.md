# Agent 决策入口重构 · 阶段记录

本文件记录 Agent 决策入口重构（turnInterpretation + focusResolver + LLM Turn Interpreter）各阶段的完成状态、真实链路验收结果、保留的技术债与后续阶段建议。仅作为内部技术记录，不作为运行逻辑的一部分。

## 阶段 0+1：turnInterpretation 解释层

- 新增 `src/agent/turnInterpretation.ts`：纯函数 `interpretUserTurn`，把用户每一轮输入解释为结构化 `TurnInterpretation`（intent / fields / signals / confidence）。
- 新增 `tests/agent-entry-protection.test.mjs`：12 条行为快照保护测试，确保后续重构不改变现有 decideSync 行为。
- 不接入 decideSync，不替代任何现有 handler。
- commit：`bfa0bb7`

## 阶段 2A：focusResolver 路由层

- 新增 `src/agent/focusResolver.ts`：纯函数 `resolveConversationFocus`，结合 `TurnInterpretation` + 当前 pending 状态（collection / plan / draft / batch）输出 `FocusDecision`。
- 新增 `tests/focus-resolver.test.mjs`：22 条单元测试。
- 不接入 decideSync。
- commit：`8ccca14`

## 阶段 2B：接入 pendingCollection 分支

- 把 `interpretUserTurn + resolveConversationFocus` 接入 `householdOrchestrator.ts` 的 `pendingCollection` 分支（`handleCollectionFocusDecision`）。
- 修复 active collection 串物品问题：当用户在旧物品采集态中输入「今天买了 3 袋五常大米」时，`focusResolver` 返回 `start_new_collection`，旧 collection 由 App.tsx 的 collection turn 处理逻辑自动标 superseded。
- 保留 `handlePendingCollectionIntent` 作为 route_to_query / route_to_smalltalk / route_to_llm 分支的字段抽取兜底（focusResolver 的短句识别覆盖面窄于 `reviseDraftCollection`）。
- `focusResolver` pendingCollection section step 6 拆分：manage_item / manage_budget / delete_request → start_new_collection；unknown / batch_revision → route_to_llm（避免过度激进新建 collection）。
- 不改 pendingPlan / pendingDraft / batch / executor / 删除二次确认 / UI。
- 新增 `tests/agent-entry-routing.test.mjs`：11 条端到端路由测试。
- commit：`f390d20`

## 阶段 2C：LLM Turn Interpreter 兜底

### 已完成能力

- **turnInterpreterLlm**：`src/agent/turnInterpreterLlm.ts`
  - `askTurnInterpreterLlm(input, clientOverride?)`：当本地低置信时调用 LLM 重新做结构化理解。
  - LLM 只输出结构化 `TurnInterpretation` JSON（intent / fields / confidence / reason），不直接写 state、不生成 proposal、不执行 action。
  - Prompt 含平台别名归一规则（拼夕夕 / pdd / p'd'd / 多多 → 拼多多；狗东 / 东哥 → 京东；淘系 / 某宝 → 淘宝）与 JSON schema 约束。
  - `parseLlmTurnInterpretation`：JSON 解析 + 校验，兼容 ```json fenced block 与前后说明文字。
  - 低置信 fallback：confidence=low / intent=unknown / supplement_with_empty_fields / parse 失败 / client 异常 → 返回 null → clarification。
  - 可注入 `TurnInterpreterLlmClient`（mock for tests / desktop bridge for production）。

- **agentDecisionTrace**：`src/agent/agentDecisionTrace.ts`
  - `createTrace` / `commitTrace` / `peekLastTrace` / `buildTraceCurrentState` / `setFinalDecision`。
  - trace 字段覆盖完整链路：localInterpretation / firstFocusDecision / collectionFallback / decisionBeforeAppDispatch / llmInterpreter（shouldCall / called / hasApiKey / model / promptPreview / rawResponse / parsed / normalizedInterpretation / rejected / rejectReason）/ secondFocusDecision / synthesizedInput / finalDecision。
  - dev 环境输出到 `console.info` + `window.__agentLastTrace` + `window.__copyAgentTrace` + `window.__agentTraceHistory`。
  - 不改正式 UI 渲染。

- **orchestrator 扩展**：`src/agent/orchestrator.ts`
  - `OrchestrateDecision` 新增 `needTurnInterpreterLlm`。
  - `AgentOrchestrator` 新增 `interpretAndRoute(input, clientOverride?)`。

- **householdOrchestrator 接线**：`src/agent/householdOrchestrator.ts`
  - `handleCollectionFocusDecision` 的 `route_to_llm` 分支返回 `needTurnInterpreterLlm`（不再直接回 needLlm → 「超出家务范围」）。
  - `interpretAndRouteSync`：调用 `askTurnInterpreterLlm` → `resolveConversationFocus` 二次路由 → 根据新 focus 决定 continue / correct / start_new_collection / route_to_query / route_to_smalltalk / clarification。
  - `synthesizeInputFromInterpretation`：把 LLM interpretation fields 转为等价用户输入，复用 `handlePendingCollectionIntent`。
  - `composeCollectionClarificationTurn`：低置信时询问「你是想把这个补到刚才那条 X 里吗？」，禁止「超出家务范围」。

- **App.tsx 最小 dispatch**：`decision.kind === "needTurnInterpreterLlm"` 时调用 `orchestrator.interpretAndRoute(input)`，trace 全路径接线（不改 UI 渲染）。

- **本地解释器补齐**：`turnInterpretation.ts` 的 `detectShortField` 新增价格+币种识别（45块 / 36元 / 128块钱 / 45.5元），用 raw 匹配避免 compact 吃小数点。本地高置信路径不调用 LLM。

- **mock 测试**：
  - `tests/turn-interpreter-llm.test.mjs`：14 条 mock client 单元测试。
  - `tests/agent-entry-llm-fallback.test.mjs`：12 条端到端 fallback 路由测试。
  - `tests/turn-interpretation.test.mjs`：新增 4 条价格短句测试。

- **smoke 脚本**：
  - `scripts/smoke-agent-llm-fallback.mjs`（mock client，8 case，`npm run smoke:agent-llm`）。
  - `scripts/smoke-agent-llm-real.mjs`（真实 desktop bridge / DashScope，6 case，`npm run smoke:agent-llm:real`）。
  - `npm run smoke:agent-llm:real` 在 CLI 环境无 desktop bridge / api key 时报告 `REAL_LLM_SMOKE_SKIPPED`，不阻塞，不把 skipped 写成 passed。

- **judge advisory 标准**：疑问句（「你知道 X 么」）标为 `PASS_NEED_LLM`，不算核心失败。可接受结果：needLm / clarification，不允许「超出家务范围」或低置信下写入错误字段。

### 当前确认通过的真实链路（qwen-plus）

| 输入 | 期望 | 实际结果 | 状态 |
|------|------|----------|------|
| 拼夕夕 | platform=拼多多 | LLM 归一为拼多多，synthesizedInput=拼多多，finalTurn=collection | PASS |
| PDD | platform=拼多多 | 同上 | PASS |
| p'd'd | platform=拼多多 | 同上 | PASS |
| asdfasdf | clarification，不写字段 | rejectReason=confidence_low，finalTurn=clarification，message 不含「超出家务范围」 | PASS |
| 你知道 p'd'd | needLm / clarification | LLM 判 smalltalk → secondFocus=route_to_smalltalk → finalDecision=needLm | PASS_NEED_LLM |
| 你知道拼夕夕么 | needLm / clarification | 同上 | PASS_NEED_LLM |

核心验收标准全部通过：
- 拼夕夕 / PDD / p'd'd 必须补 platform=拼多多 ✓
- asdfasdf 必须 clarification，不写字段 ✓
- 五常大米不被旧 collection 吞掉 ✓（mock smoke case 6）
- 45块本地识别 price，不走 LLM ✓（mock smoke case 7）

### 相关 commit

- 阶段 2C 主体：`221dbb0`
- trace 全路径接线 follow-up：`11917b1`
- mock smoke 脚本：`45ddf8d`
- 提交完整性检查 follow-up：`11917b1`
- 真实 LLM smoke judge advisory 调整：`8ef9b57`

## 保留的技术债

1. **route_to_llm 分支里旧 handlePendingCollectionIntent 仍有早退兜底**
   - 位置：`householdOrchestrator.ts` `handleCollectionFocusDecision` 的 route_to_query / route_to_smalltalk / route_to_llm 分支。
   - 原因：focusResolver 的短句识别覆盖面窄于 `reviseDraftCollection`，长句评价/价格字段抽取仍依赖旧 handler。
   - 风险：route_to_llm 分支先走旧 handler，若旧 handler 抽出字段则直接返回 sync turn，不进入 LLM interpreter。当前对「拼夕夕 / pdd」类平台别名无效（旧 handler 抽不出），所以不会阻塞 2C，但长期看是双出口。

2. **pendingPlan / pendingDraft / batch 尚未接入统一入口**
   - 当前 `decideSync` 仍按旧状态机顺序处理：pendingPlan → pendingCollection → pendingBatch → pendingDraft → writeDraft → boundary → needLlm。
   - 只有 pendingCollection 分支接入了 turnInterpretation + focusResolver。
   - pendingPlan / pendingDraft / batch 的 confirm / cancel / revise 仍走旧 `classifyAgentIntent` + 旧 handler。

3. **旧 handler 的字段解释能力后续应逐步迁移到 turnInterpretation**
   - `drafts.ts` 的 `buildLocalDraftFromText` / `reviseAgentDraft` / `parsePlatform` / `parseQty` / `parseNaturalDate` / `extractReviewText` / `parseItemNameRevision` 仍是字段抽取主源。
   - `draftCollection.ts` 的 `reviseDraftCollection` 仍是采集态字段写入主源。
   - `turnInterpretation.ts` 目前复用上述函数，但覆盖面不完整（短句识别窄于 reviseDraftCollection）。
   - 长期目标：turnInterpretation 成为唯一解释层，reviseDraftCollection 只负责写入，不再做字段抽取。

4. **smoke 脚本 mock client 的平台别名集合是硬编码**
   - `scripts/smoke-agent-llm-fallback.mjs` 的 `PDD_ALIASES` 列表是 mock 行为，不进入运行逻辑。
   - 真实运行时由 LLM 根据 prompt 规则归一，不依赖此列表。
   - 风险：mock 测试通过 ≠ 真实 LLM 通过，需用 `smoke:agent-llm:real` 互补验证。

5. **trace 仅 dev 环境暴露**
   - `window.__agentLastTrace` 等仅用于人工验收与 smoke 脚本，正式生产 UI 不展示。
   - 长期看需评估是否在正式环境保留 trace 用于线上诊断。

## 后续阶段建议

### 阶段 3A：迁移 pendingPlan 接入 focusResolver

- 把 pendingPlan 分支接入 `interpretUserTurn + resolveConversationFocus`。
- focusResolver 已定义 `continue_pending_plan` / `confirm_current_task` / `cancel_current_task` 等 focus，但 pendingPlan 分支尚未消费。
- 目标：pendingPlan 的 confirm / cancel / revise / status 统一走 focusResolver，不再走旧 `classifyAgentIntent(text, true)` + `handlePendingPlanIntent`。
- 风险：高风险 plan 的二次确认删除流程不能被绕过，需保留 `requiresSecondConfirm` 语义。

### 阶段 3B：迁移 pendingDraft

- 把 pendingDraft 分支接入 focusResolver。
- 目标：pendingDraft 的 confirm / cancel / revise / pendingStatus 统一走 focusResolver。
- 风险：旧 AgentDraft 的 confirm/cancel/revise 流程是历史稳定路径，迁移需保留行为快照保护测试。

### 阶段 3C：逐步拆除旧 handler 解释职责

- 把 `handlePendingCollectionIntent` 的字段抽取能力迁移到 `turnInterpretation`。
- 把 `reviseDraftCollection` 的字段抽取职责剥离，只保留写入。
- 把 `classifyAgentIntent` 的 confirm / cancel / revise / pendingStatus 判定迁移到 `turnInterpretation`。
- 最终目标：`turnInterpretation` 成为唯一解释层，`focusResolver` 成为唯一路由层，旧 handler 只负责执行。
- 风险：覆盖面迁移需逐步进行，每步保留行为快照保护测试，避免回归。

## 回归基线

截至阶段 2C 收口：

- `npm run typecheck`：PASS
- `npm test`：815/815 PASS
- `npm run build`：PASS
- `npm run smoke:agent-llm`（mock）：8/8 PASS
- `npm run smoke:agent-llm:real`（qwen-plus）：核心 4/6 PASS，advisory 2/6，FAIL 0/6
