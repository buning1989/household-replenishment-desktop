import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if ((specifier.startsWith(".") || specifier.startsWith("..")) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const { createHouseholdOrchestrator, isBatchIntentMarker, readTurnCommand } = await import("../src/agent/householdOrchestrator.ts")
const { composeProposalMessage, composeCancelledMessage, composePendingReminder, composeRevisedMessage, findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function catItem(id, name, category = "宠物用品") {
  return {
    id, name, category, type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋"
  }
}

// ---------- 1. orchestrator.decide 统一入口 ----------

test("orchestrator: 无 pending 时「帮我加一袋猫砂」生成 collection turn（补货采集态）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  // restock/createItem 缺金额/平台时先进采集态（collection），不立刻甩确认卡
  assert.equal(decision.turn.kind, "collection")
  assert.equal(decision.turn.collection.draft.kind, "createItemWithRestock")
  assert.equal(decision.turn.collection.draft.item.itemName, "猫砂")
  // message 由 composer 生成，不暴露 AgentDraft 字段表
  assert.ok(!decision.turn.message.includes("待确认草稿"))
  assert.equal(findForbiddenPhrase(decision.turn.message), null, "collection message 不应含禁用词")
})

test("orchestrator: 有猫砂时「帮我加一袋猫砂」生成 restock collection，不重复创建", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  assert.equal(decision.turn.collection.draft.kind, "restock")
  assert.equal(decision.turn.collection.draft.itemId, "i1")
})

// ---------- 1b. AgentPlan 新能力（planProposal）----------

test("orchestrator: 「新建一个宠物用品分类」生成 planProposal turn（createCategory）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "新建一个宠物用品分类",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions.length, 1)
  assert.equal(decision.turn.plan.actions[0].type, "createCategory")
  assert.equal(decision.turn.plan.actions[0].name, "宠物用品")
  assert.ok(decision.turn.message.includes("宠物用品"))
})

test("orchestrator: 403 「这个月预算设成 500」→ 导航回答（不创建 plan）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "这个月预算设成 500",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "navigate")
  assert.ok(!("plan" in decision.turn), "不应创建 planProposal")
})

test("orchestrator: 403 「猫粮周期改成 30 天」→ 导航回答（不创建 updateItem plan）", () => {
  const state = makeState({ items: [catItem("i1", "猫粮")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "猫粮周期改成 30 天",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "navigate")
  assert.ok(!("plan" in decision.turn), "不应创建 planProposal")
})

test("orchestrator: 有猫砂时「帮我加一个猫砂」生成 clarification turn，不生成 draft", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "帮我加一个猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "clarification")
  assert.ok(decision.turn.message.includes("猫砂已经在管了"))
  assert.ok(decision.turn.options.length >= 2)
})

test("orchestrator: 多个猫相关 item 时「加一个猫」生成 clarification turn", () => {
  const state = makeState({ items: [catItem("i1", "猫砂"), catItem("i2", "猫粮"), catItem("i3", "猫罐头")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "加一个猫",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "clarification")
  assert.ok(decision.turn.message.includes("猫砂") && decision.turn.message.includes("猫粮"))
})

// ---------- 2. pending proposal 状态机 ----------

test("orchestrator: pending + 「确认吧」→ proposal(原 draft)，调用方执行 commit", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  const decision = orch.decide({
    text: "确认吧",
    state,
    itemViews: [],
    pendingDraft,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  // draftCommit typed command，调用方据此执行 commit
  assert.equal(decision.turn.command.command, "draftCommit")
})

test("orchestrator: pending + 「算了别记」→ cancelled turn", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  const decision = orch.decide({
    text: "算了别记",
    state,
    itemViews: [],
    pendingDraft,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "cancelled")
  assert.ok(decision.turn.message.includes("先不记"))
  assert.equal(findForbiddenPhrase(decision.turn.message), null)
})

test("orchestrator: pending + 「记了吗」→ answer turn (pending reminder)", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  const decision = orch.decide({
    text: "记了吗",
    state,
    itemViews: [],
    pendingDraft,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")
  assert.ok(decision.turn.message.includes("还没真正写入"))
  assert.equal(findForbiddenPhrase(decision.turn.message), null)
})

test("orchestrator: pending + 「不是一袋，是两袋」→ proposal(修订后)", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  const decision = orch.decide({
    text: "不是一袋，是两袋",
    state,
    itemViews: [],
    pendingDraft,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "proposal")
  // executableDraft !== pendingDraft（是修订后的新 draft）
  assert.notEqual(decision.turn.executableDraft, pendingDraft)
  assert.ok(decision.turn.message.includes("我按你说的改了一下"))
})

// ---------- 3. 查询意图走 needLlm（任务四 A：查询链路 LLM 化） ----------

test("orchestrator: 「你是谁」→ sync answer（identityOrMeta 边界直接回答，不调 LLM）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "你是谁",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  // 非管家问题对话策略：身份/元对话直接返回 sync answer，不再走 LLM
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")
  assert.match(decision.turn.message, /403\s*管家/)
})

test("orchestrator: 「这周可能要补什么」→ needLlm，事实由 buildQueryFacts 注入", () => {
  const now = Date.UTC(2026, 6, 4)
  const state = makeState()
  const makeView = (item, dueAt, daysUntilDue) => ({
    item,
    computed: {
      status: daysUntilDue < 0 ? "urgent" : "warning",
      displayStatus: daysUntilDue < 0 ? "urgent" : "warning",
      statusLabel: daysUntilDue < 0 ? "急需补货" : "快用完",
      dueAt, depletionAt: dueAt, daysUntilDue, daysUntilDepletion: daysUntilDue,
      isDue: daysUntilDue <= 0, isSnoozed: false,
      remainingText: daysUntilDue < 0 ? `已用完 ${-daysUntilDue} 天` : `还剩约 ${daysUntilDue} 天`,
      statusText: daysUntilDue < 0 ? "急需补货" : "快用完"
    }
  })
  const views = [
    makeView({ id: "i1", name: "洗衣液", category: "洗衣清洁", type: "learning", cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: false, purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋" }, Date.UTC(2026, 5, 28), -6),
    makeView({ id: "i2", name: "抽纸", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: false, purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "包" }, Date.UTC(2026, 6, 8), 4)
  ]
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "这周可能要补什么",
    state,
    itemViews: views,
    dateContext: buildChatDateContext(now)
  })
  // 任务四 A：查询意图走 LLM，buildQueryFacts 在 askHouseholdAssistant 里注入系统提示
  assert.equal(decision.kind, "needLlm")
})

// ---------- 4. needLlm 场景 ----------

test("orchestrator: 实时外部信息（天气）→ sync answer（边界直接回答，不调 LLM）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "最近天气怎么样",  // 实时外部信息：边界直接回答，不调 LLM
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  // 非管家问题对话策略：实时外部信息直接返回 sync answer，不编造
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")
  assert.match(decision.turn.message, /实时/)
})

// ---------- 5. normalizeLlmResponse 收敛 LLM 文案 ----------

test("orchestrator: normalizeLlmResponse 不直接采用 LLM message，由 composer 重新生成", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  // LLM 返回的 message 含禁用词「我理解为」，但 draft 本身有效
  const llmContent = JSON.stringify({
    kind: "draft",
    message: "我理解为你要加猫砂，待确认草稿已生成，确认创建吗？",
    draft: {
      kind: "createItem",
      itemName: "猫砂",
      category: "宠物用品",
      cycleDays: 14,
      bufferDays: 2,
      unit: "袋"
    }
  })
  const turn = orch.normalizeLlmResponse(llmContent, {
    text: "帮我加一个猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(turn, "应解析出 turn")
  assert.equal(turn.kind, "proposal")
  assert.equal(turn.executableDraft.kind, "createItem")
  // message 不应包含禁用词，应由 composer 重新生成
  assert.ok(!turn.message.includes("我理解为"))
  assert.ok(!turn.message.includes("待确认草稿"))
  assert.ok(!turn.message.includes("确认创建"))
  assert.ok(turn.message.includes("我先把「猫砂」加进来"))
  assert.equal(findForbiddenPhrase(turn.message), null)
})

test("orchestrator: normalizeLlmResponse 解析 queryAnswer", () => {
  const orch = createHouseholdOrchestrator()
  const llmContent = JSON.stringify({
    kind: "queryAnswer",
    answer: "洗衣液还剩约 3 天，建议今天补上。"
  })
  const turn = orch.normalizeLlmResponse(llmContent, {
    text: "洗衣液还能用多久",
    state: makeState(),
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(turn)
  assert.equal(turn.kind, "answer")
  assert.ok(turn.message.includes("洗衣液"))
})

test("orchestrator: normalizeLlmResponse 解析 clarification", () => {
  const orch = createHouseholdOrchestrator()
  const llmContent = JSON.stringify({
    kind: "clarification",
    clarification: {
      question: "你说的是哪个？",
      options: ["A", "B"]
    }
  })
  const turn = orch.normalizeLlmResponse(llmContent, {
    text: "加一个",
    state: makeState(),
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(turn)
  assert.equal(turn.kind, "clarification")
  assert.equal(turn.options.length, 2)
})

test("orchestrator: normalizeLlmResponse JSON-like 无 answer/message → 中性兜底 answer", () => {
  const orch = createHouseholdOrchestrator()
  // 阶段 4B.4：含 JSON 结构但无 answer/message 字段时，不再返回 null 走 unsupported。
  // 改为返回中性兜底 answer，不把原始 JSON 吐给用户。
  const turn = orch.normalizeLlmResponse('{ "kind": "invalid", "data": ... }', {
    text: "xxx",
    state: makeState(),
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(!turn.message.includes("{"), "不应把原始 JSON 吐给用户")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含旧 unsupported 文案")
})

// ---------- 6. responseComposer 禁用词校验 ----------

test("composer: composeProposalMessage 各 kind 都不含禁用词", () => {
  const drafts = [
    { kind: "createItem", itemName: "洗发水", category: "日常护理", cycleDays: 30, bufferDays: 2, unit: "瓶" },
    { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋" },
    { kind: "createItemWithRestock", item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 2, unit: "袋" }, restock: { qty: 1, unit: "袋" } },
    { kind: "addPurchaseOption", itemName: "卷纸", productName: "维达超韧", unit: "卷" }
  ]
  for (const draft of drafts) {
    const msg = composeProposalMessage(draft)
    assert.equal(findForbiddenPhrase(msg), null, `${draft.kind} message 含禁用词：${msg}`)
  }
})

test("composer: composeCancelledMessage / composePendingReminder / composeRevisedMessage 不含禁用词", () => {
  const draft = { kind: "createItem", itemName: "X", category: "其他", cycleDays: 30, bufferDays: 2, unit: "件" }
  assert.equal(findForbiddenPhrase(composeCancelledMessage()), null)
  assert.equal(findForbiddenPhrase(composePendingReminder(draft)), null)
  assert.equal(findForbiddenPhrase(composeRevisedMessage()), null)
})

// ---------- 7. isBatchIntentMarker / readTurnCommand ----------

test("orchestrator: isBatchIntentMarker 识别 typed command 批量意图", () => {
  // typed command 替代旧的 __BATCH_CONFIRM__ 魔法字符串
  assert.deepEqual(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "batchConfirm" } }), { intent: "batchConfirm" })
  assert.deepEqual(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "batchCancel" } }), { intent: "batchCancel" })
  assert.deepEqual(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "batchCancelIndex", index: 2 } }), { intent: "batchCancelIndex", index: 2 })
  assert.deepEqual(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "batchReviseIndex", index: 1 } }), { intent: "batchReviseIndex", index: 1 })
  assert.deepEqual(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "batchReviseAll" } }), { intent: "batchReviseAll" })
  // 非 planCommand turn 返回 null
  assert.equal(isBatchIntentMarker({ kind: "answer", message: "普通回答" }), null)
  assert.equal(isBatchIntentMarker({ kind: "proposal", message: "x", executableDraft: {}, status: "pending" }), null)
  // planConfirm/planCancel 不属于 batch 意图
  assert.equal(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "planConfirm" } }), null)
  assert.equal(isBatchIntentMarker({ kind: "planCommand", message: "", command: { command: "planCancel" } }), null)
})

test("orchestrator: readTurnCommand 读取 planConfirm/planCancel typed command", () => {
  assert.deepEqual(readTurnCommand({ kind: "planCommand", message: "", command: { command: "planConfirm" } }), { command: "planConfirm" })
  assert.deepEqual(readTurnCommand({ kind: "planCommand", message: "", command: { command: "planCancel" } }), { command: "planCancel" })
  assert.deepEqual(readTurnCommand({ kind: "planCommand", message: "", command: { command: "batchConfirm" } }), { command: "batchConfirm" })
  assert.equal(readTurnCommand({ kind: "answer", message: "普通回答" }), null)
})

// ---------- 8. pendingPlan 状态机（新 AgentPlan 流程） ----------

test("orchestrator: pendingPlan + 「确认吧」→ planCommand(planConfirm)，调用方执行 commitAgentPlan", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const plan = createAgentPlan([{ type: "createCategory", name: "园艺" }], "建一个园艺分类")
  const decision = orch.decide({
    text: "确认吧",
    state,
    itemViews: [],
    pendingPlan: plan,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.deepEqual(decision.turn.command, { command: "planConfirm" })
})

test("orchestrator: pendingPlan + 「算了」→ planCommand(planCancel)", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const plan = createAgentPlan([{ type: "createCategory", name: "园艺" }], "建一个园艺分类")
  const decision = orch.decide({
    text: "算了",
    state,
    itemViews: [],
    pendingPlan: plan,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.deepEqual(decision.turn.command, { command: "planCancel" })
})

test("orchestrator: pendingPlan + 「记了吗」→ answer（提示还没写入）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const plan = createAgentPlan([{ type: "setMonthlyBudget", amount: 500 }], "把预算设成 500")
  const decision = orch.decide({
    text: "记了吗",
    state,
    itemViews: [],
    pendingPlan: plan,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")
  assert.ok(decision.turn.message.includes("还没真正写入"))
})

test("orchestrator: pendingPlan + 「价格改成 68」→ planProposal(修订后)", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const plan = createAgentPlan([{
    type: "recordRestock", itemName: "猫砂", itemId: "i1", qty: 1, price: 58
  }], "刚买了猫砂花了 58")
  const decision = orch.decide({
    text: "价格改成 68",
    state,
    itemViews: [],
    pendingPlan: plan,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.notEqual(decision.turn.plan.actions[0].price, 58)
  assert.equal(decision.turn.plan.actions[0].price, 68)
})

test("orchestrator: pendingPlan + 新建分类请求 → 生成新 planProposal（旧 plan 由 App.tsx 标 superseded）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  // 旧的 pending plan：建园艺分类
  const oldPlan = createAgentPlan([{ type: "createCategory", name: "园艺" }], "新建一个园艺分类")
  // 用户改主意，发新请求：新建一个宠物用品分类（plan-only 能力，走 planProposal）
  const decision = orch.decide({
    text: "新建一个宠物用品分类",
    state,
    itemViews: [],
    pendingPlan: oldPlan,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.notEqual(decision.turn.plan, oldPlan)
  assert.equal(decision.turn.plan.actions[0].type, "createCategory")
  assert.equal(decision.turn.plan.actions[0].name, "宠物用品")
})
