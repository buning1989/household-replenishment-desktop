// 任务：草稿卡片收据化 + 信息采集策略（基于历史/常识给参考，不再机械追问）
// 运行方式：node --test tests/draft-receipt-revise.test.mjs
//
// 覆盖：
// B3: composeCollectionGuidance 在 restock/createItemWithRestock 缺金额/平台时返回参考文案
// B3: draftToProposal 首次产出时追加参考文案；revise 路径不重复采集
// B4: 纯数字（如「45」）在 pending 草稿上下文命中 reviseDraft
// B4: applyRestockRevision 把纯数字视为价格补充
// B4: 验收点 - 缺金额草稿 → 给参考 → 回「45块」→ 价格补进 → 不再追加参考
// B4: 验收点 - 缺金额草稿 → 给参考 → 回「确认」→ 正常写入 → 不再追加参考

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

const { composeCollectionGuidance, composeProposalMessage, findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")
const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { reviseAgentDraft } = await import("../src/agent/drafts.ts")
const { classifyAgentIntent } = await import("../src/agent/intent.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

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

// ---------- B3: composeCollectionGuidance 基础行为 ----------

test("B3: restock 缺金额（无历史）→ 返回 llmPrior 参考文案，不追问「多少钱」", () => {
  const state = makeState()
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", restockDate: 1000 }
  const guidance = composeCollectionGuidance(draft, state, [])
  assert.ok(guidance, "缺金额时应返回参考文案")
  assert.ok(!guidance.includes("多少钱"), `不应追问「多少钱」, 实际：${guidance}`)
  assert.ok(guidance.includes("常见") || guidance.includes("我先按"), `应给参考, 实际：${guidance}`)
})

test("B3: restock 缺金额+缺平台（无历史）→ 仍只给价格参考（平台无历史不给参考）", () => {
  const state = makeState()
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", restockDate: 1000 }
  const guidance = composeCollectionGuidance(draft, state, [])
  assert.ok(guidance)
  // 无历史平台时不应说「在哪家」
  assert.ok(!guidance.includes("哪家"), `不应追问「哪家」, 实际：${guidance}`)
})

test("B3: restock 只缺金额（有平台）→ 返回价格参考，不含平台参考", () => {
  const state = makeState()
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", platform: "京东", restockDate: 1000 }
  const guidance = composeCollectionGuidance(draft, state, [])
  assert.ok(guidance)
  assert.ok(!guidance.includes("哪家"))
  assert.ok(!guidance.includes("多少钱"))
})

test("B3: restock 只缺平台（有金额）→ 不给平台参考（金额已齐不再追加）", () => {
  // 价格已齐，composeCollectionGuidance 内部 buildRecordSuggestions 只给 platform 建议；
  // 但用户已说金额，文案应只提平台参考
  const item = catItem("i1", "猫砂")
  item.history = [{ id: "e1", at: 1, price: 30, qty: 1, platform: "京东" }]
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = { kind: "restock", itemId: "i1", itemName: "猫砂", qty: 1, unit: "袋", price: 45, restockDate: 1000 }
  const guidance = composeCollectionGuidance(draft, state, itemViews)
  assert.ok(guidance, "缺平台且有历史平台时应给平台参考")
  assert.ok(!guidance.includes("多少钱"))
  assert.ok(guidance.includes("京东"), `应提历史平台「京东」, 实际：${guidance}`)
})

test("B3: restock 金额平台齐全 → 返回 null", () => {
  const state = makeState()
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", price: 45, platform: "京东", restockDate: 1000 }
  assert.equal(composeCollectionGuidance(draft, state, []), null)
})

test("B3: createItemWithRestock 缺金额 → 返回参考文案", () => {
  const state = makeState()
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 2, unit: "袋" },
    restock: { qty: 1, unit: "袋", platform: "京东", restockDate: 1000 }
  }
  const guidance = composeCollectionGuidance(draft, state, [])
  assert.ok(guidance)
  assert.ok(!guidance.includes("多少钱"))
})

test("B3: createItem 不采集金额/平台", () => {
  const state = makeState()
  const draft = { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 2, unit: "袋" }
  assert.equal(composeCollectionGuidance(draft, state, []), null)
})

test("B3: addPurchaseOption 不采集金额/平台", () => {
  const state = makeState()
  const draft = { kind: "addPurchaseOption", itemName: "猫砂", productName: "皇家猫粮", unit: "袋" }
  assert.equal(composeCollectionGuidance(draft, state, []), null)
})

test("B3: 参考文案不含禁用词", () => {
  const state = makeState()
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", restockDate: 1000 }
  const guidance = composeCollectionGuidance(draft, state, [])
  assert.ok(guidance)
  assert.equal(findForbiddenPhrase(guidance), null)
})

// ---------- B3: draftToProposal 集成 ----------

test("B3: 首次产出 restock 草稿缺金额时，proposal message 含参考文案（不追问「多少钱」）", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "proposal")
  const message = decision.turn.message
  assert.ok(!message.includes("多少钱"), `缺金额时也不应追问「多少钱」, 实际：${message}`)
  // 应包含参考提示词
  assert.ok(
    message.includes("我先按") || message.includes("常见") || message.includes("实际金额"),
    `应给参考文案, 实际：${message}`
  )
})

test("B3: 首次产出 restock 草稿金额平台齐全时，proposal message 不含参考文案", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "在京东买了两袋猫砂花了90块",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "proposal")
  assert.ok(!decision.turn.message.includes("多少钱"), "金额平台齐全时不追问")
  assert.ok(!decision.turn.message.includes("哪家"), "金额平台齐全时不追问")
  assert.ok(!decision.turn.message.includes("我先按"), "金额平台齐全时不追加参考")
})

test("B3: revise 路径不重复采集（revise 后仍缺金额也不追加）", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))
  // 首次产出：缺金额，含参考文案
  const d1 = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext
  })
  assert.ok(d1.kind === "sync" && d1.turn.kind === "proposal")
  const pendingDraft = d1.turn.executableDraft
  assert.ok(!d1.turn.message.includes("多少钱"), "首次产出不应追问多少钱")
  const firstHasGuidance = d1.turn.message.includes("我先按") || d1.turn.message.includes("常见")

  // 用户修订数量（不补金额）：应走 composeRevisedMessage，不追加参考
  const d2 = orch.decide({
    text: "改成两袋",
    state,
    itemViews: [],
    pendingDraft,
    dateContext
  })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.ok(!d2.turn.message.includes("多少钱"), "revise 路径不应追问")
  assert.ok(!d2.turn.message.includes("我先按"), "revise 路径不应追加参考")
  assert.ok(!d2.turn.message.includes("常见"), "revise 路径不应追加参考")
  void firstHasGuidance
})

test("B3: confirm 路径不追加参考", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))
  const d1 = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext
  })
  const pendingDraft = d1.turn.executableDraft

  // 用户确认：orchestrator 返回 proposal(原 draft)，message 是基础话术不含参考
  const d2 = orch.decide({
    text: "确认吧",
    state,
    itemViews: [],
    pendingDraft,
    dateContext
  })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  // confirmDraft 路径 executableDraft === pendingDraft，外层 App.tsx 会执行 commit
  assert.equal(d2.turn.executableDraft, pendingDraft)
  assert.ok(!d2.turn.message.includes("多少钱"), "confirm 路径不应追问")
  assert.ok(!d2.turn.message.includes("我先按"), "confirm 路径不应追加参考")
})

// ---------- B4: 纯数字命中 reviseDraft ----------

test("B4: 纯数字「45」在 pending 时命中 reviseDraft", () => {
  assert.equal(classifyAgentIntent("45", true), "reviseDraft")
})

test("B4: 纯数字「45.5」在 pending 时命中 reviseDraft", () => {
  assert.equal(classifyAgentIntent("45.5", true), "reviseDraft")
})

test("B4: 纯数字「45」无 pending 时不是 reviseDraft", () => {
  // 无 pending 草稿时，纯数字应透传给 LLM（query 兜底）
  assert.notEqual(classifyAgentIntent("45", false), "reviseDraft")
})

test("B4: 纯数字带疑问信号「45？」不命中 reviseDraft", () => {
  assert.notEqual(classifyAgentIntent("45？", true), "reviseDraft")
  assert.notEqual(classifyAgentIntent("45吗", true), "reviseDraft")
})

test("B4: 纯数字过长（>15字符）不命中 reviseDraft", () => {
  // 16 位数字，超过 REVISE_MAX_LENGTH，透传给 LLM
  assert.notEqual(classifyAgentIntent("1234567890123456", true), "reviseDraft")
})

test("B4: 「45块」仍命中 reviseDraft（不退化）", () => {
  assert.equal(classifyAgentIntent("45块", true), "reviseDraft")
})

test("B4: 「京东」仍命中 reviseDraft（平台名在 REVISE_KEYWORDS）", () => {
  assert.equal(classifyAgentIntent("京东", true), "reviseDraft")
})

// ---------- B4: applyRestockRevision 纯数字价格补充 ----------

test("B4: reviseAgentDraft 把纯数字「45」补进 price", () => {
  const pending = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    restockDate: 1000
  }
  const revised = reviseAgentDraft(pending, "45")
  assert.ok(revised)
  assert.equal(revised.kind, "restock")
  assert.equal(revised.price, 45)
})

test("B4: reviseAgentDraft 把「45.5」补进 price", () => {
  const pending = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    restockDate: 1000
  }
  const revised = reviseAgentDraft(pending, "45.5")
  assert.ok(revised)
  assert.equal(revised.price, 45.5)
})

test("B4: reviseAgentDraft 把「45块」补进 price（原有路径不退化）", () => {
  const pending = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    restockDate: 1000
  }
  const revised = reviseAgentDraft(pending, "45块")
  assert.ok(revised)
  assert.equal(revised.price, 45)
})

test("B4: reviseAgentDraft 把「京东」补进 platform", () => {
  const pending = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    restockDate: 1000
  }
  const revised = reviseAgentDraft(pending, "京东")
  assert.ok(revised)
  assert.equal(revised.platform, "京东")
})

// ---------- B4: 验收点 - 缺金额 → 给参考 → 回「45块」→ 补进 → 不再追加参考 ----------

test("B4 验收: 缺金额草稿 → 给参考 → 回「45块」→ 价格补进 → 不再追加参考", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 1. 首次产出：缺金额，给参考（不再追问「多少钱」）
  const d1 = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  assert.ok(d1.kind === "sync" && d1.turn.kind === "proposal")
  const pendingDraft = d1.turn.executableDraft
  assert.equal(pendingDraft.price, undefined, "初始草稿缺金额")
  assert.ok(!d1.turn.message.includes("多少钱"), "首次产出不应追问金额")
  assert.ok(
    d1.turn.message.includes("我先按") || d1.turn.message.includes("常见"),
    `首次产出应给参考, 实际：${d1.turn.message}`
  )

  // 2. 用户回「45块」：应命中 reviseDraft，价格补进
  const d2 = orch.decide({ text: "45块", state, itemViews: [], pendingDraft, dateContext })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.equal(d2.turn.executableDraft.price, 45, "「45块」应补进 price")
  assert.ok(!d2.turn.message.includes("多少钱"), "revise 后不应追问")
  assert.ok(!d2.turn.message.includes("我先按"), "revise 后不应再追加参考")
})

test("B4 验收: 缺金额草稿 → 给参考 → 回纯数字「45」→ 价格补进 → 不再追加参考", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  const d1 = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  const pendingDraft = d1.turn.executableDraft
  assert.equal(pendingDraft.price, undefined)
  assert.ok(!d1.turn.message.includes("多少钱"))

  // 用户回纯数字「45」（无单位）：也应补进 price
  const d2 = orch.decide({ text: "45", state, itemViews: [], pendingDraft, dateContext })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.equal(d2.turn.executableDraft.price, 45, "纯数字「45」应补进 price")
  assert.ok(!d2.turn.message.includes("多少钱"))
})

test("B4 验收: 缺金额草稿 → 给参考 → 回「确认」→ 正常写入 → 不再追加参考", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  const d1 = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  const pendingDraft = d1.turn.executableDraft
  assert.equal(pendingDraft.price, undefined)
  assert.ok(!d1.turn.message.includes("多少钱"))

  // 用户回「确认」：应命中 confirmDraft，executableDraft === pendingDraft
  const d2 = orch.decide({ text: "确认吧", state, itemViews: [], pendingDraft, dateContext })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.equal(d2.turn.executableDraft, pendingDraft, "confirmDraft 应返回原 draft 引用")
  assert.ok(!d2.turn.message.includes("多少钱"), "confirm 路径不应追问")
  assert.ok(!d2.turn.message.includes("我先按"), "confirm 路径不应追加参考")
  // price 仍为 undefined，由 executor 正常写入为空
  assert.equal(d2.turn.executableDraft.price, undefined)
})
