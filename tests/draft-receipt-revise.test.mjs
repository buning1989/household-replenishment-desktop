// 任务四 B 部分单元测试：草稿卡片收据化 + 缺失字段追问 + 纯数字修订
// 运行方式：node --test tests/draft-receipt-revise.test.mjs
//
// 覆盖：
// B3: composeMissingFieldPrompt 在 restock/createItemWithRestock 缺金额/平台时返回追问文案
// B3: draftToProposal 首次产出时追加追问；revise 路径不追问第二次
// B4: 纯数字（如「45」）在 pending 草稿上下文命中 reviseDraft
// B4: applyRestockRevision 把纯数字视为价格补充
// B4: 验收点 - 缺金额草稿 → 追问 → 回「45块」→ 价格补进 → 不再追问
// B4: 验收点 - 缺金额草稿 → 追问 → 回「确认」→ 正常写入 → 不再追问

import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier)
    } catch (error) {
      if ((specifier.startsWith(".") || specifier.startsWith("..")) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const { composeMissingFieldPrompt, composeProposalMessage, findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")
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
    onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
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

// ---------- B3: composeMissingFieldPrompt ----------

test("B3: restock 缺金额和平台 → 返回合并追问", () => {
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", restockDate: 1000 }
  const prompt = composeMissingFieldPrompt(draft)
  assert.ok(prompt)
  assert.match(prompt, /多少钱/)
  assert.match(prompt, /哪家/)
})

test("B3: restock 只缺金额 → 返回金额追问", () => {
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", platform: "京东", restockDate: 1000 }
  const prompt = composeMissingFieldPrompt(draft)
  assert.ok(prompt)
  assert.match(prompt, /多少钱/)
  assert.ok(!prompt.includes("哪家"))
})

test("B3: restock 只缺平台 → 返回平台追问", () => {
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", price: 45, restockDate: 1000 }
  const prompt = composeMissingFieldPrompt(draft)
  assert.ok(prompt)
  assert.match(prompt, /哪家/)
  assert.ok(!prompt.includes("多少钱"))
})

test("B3: restock 金额平台齐全 → 返回 null", () => {
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", price: 45, platform: "京东", restockDate: 1000 }
  assert.equal(composeMissingFieldPrompt(draft), null)
})

test("B3: createItemWithRestock 缺金额 → 返回追问", () => {
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 2, unit: "袋" },
    restock: { qty: 1, unit: "袋", platform: "京东", restockDate: 1000 }
  }
  const prompt = composeMissingFieldPrompt(draft)
  assert.ok(prompt)
  assert.match(prompt, /多少钱/)
})

test("B3: createItem 不追问金额/平台", () => {
  const draft = { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 2, unit: "袋" }
  assert.equal(composeMissingFieldPrompt(draft), null)
})

test("B3: addPurchaseOption 不追问金额/平台", () => {
  const draft = { kind: "addPurchaseOption", itemName: "猫砂", productName: "皇家猫粮", unit: "袋" }
  assert.equal(composeMissingFieldPrompt(draft), null)
})

test("B3: 追问文案不含禁用词", () => {
  const draft = { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋", restockDate: 1000 }
  const prompt = composeMissingFieldPrompt(draft)
  assert.equal(findForbiddenPhrase(prompt), null)
})

// ---------- B3: draftToProposal 集成 ----------

test("B3: 首次产出 restock 草稿缺金额时，proposal message 含追问", () => {
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
  assert.ok(decision.turn.message.includes("多少钱"), "缺金额时应追加追问")
})

test("B3: 首次产出 restock 草稿金额平台齐全时，proposal message 不含追问", () => {
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
})

test("B3: revise 路径不重复追问（revise 后仍缺金额也不追加）", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  // 首次产出：缺金额，含追问
  const d1 = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(d1.kind === "sync" && d1.turn.kind === "proposal")
  const pendingDraft = d1.turn.executableDraft
  assert.ok(d1.turn.message.includes("多少钱"))

  // 用户修订数量（不补金额）：应走 composeRevisedMessage，不追问
  const d2 = orch.decide({
    text: "改成两袋",
    state,
    itemViews: [],
    pendingDraft,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.ok(!d2.turn.message.includes("多少钱"), "revise 路径不应重复追问")
  assert.ok(!d2.turn.message.includes("哪家"), "revise 路径不应重复追问")
})

test("B3: confirm 路径不追问", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const d1 = orch.decide({
    text: "帮我加一袋猫砂",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  const pendingDraft = d1.turn.executableDraft

  // 用户确认：orchestrator 返回 proposal(原 draft)，message 是基础话术不含追问
  const d2 = orch.decide({
    text: "确认吧",
    state,
    itemViews: [],
    pendingDraft,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  // confirmDraft 路径 executableDraft === pendingDraft，外层 App.tsx 会执行 commit
  assert.equal(d2.turn.executableDraft, pendingDraft)
  assert.ok(!d2.turn.message.includes("多少钱"), "confirm 路径不应追问")
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

// ---------- B4: 验收点 - 缺金额 → 追问 → 回「45块」→ 补进 → 不再追问 ----------

test("B4 验收: 缺金额草稿 → 追问 → 回「45块」→ 价格补进 → 不再追问", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 1. 首次产出：缺金额，含追问
  const d1 = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  assert.ok(d1.kind === "sync" && d1.turn.kind === "proposal")
  const pendingDraft = d1.turn.executableDraft
  assert.equal(pendingDraft.price, undefined, "初始草稿缺金额")
  assert.ok(d1.turn.message.includes("多少钱"), "首次产出应追问金额")

  // 2. 用户回「45块」：应命中 reviseDraft，价格补进
  const d2 = orch.decide({ text: "45块", state, itemViews: [], pendingDraft, dateContext })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.equal(d2.turn.executableDraft.price, 45, "「45块」应补进 price")
  assert.ok(!d2.turn.message.includes("多少钱"), "revise 后不应重复追问")
})

test("B4 验收: 缺金额草稿 → 追问 → 回纯数字「45」→ 价格补进 → 不再追问", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  const d1 = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  const pendingDraft = d1.turn.executableDraft
  assert.equal(pendingDraft.price, undefined)
  assert.ok(d1.turn.message.includes("多少钱"))

  // 用户回纯数字「45」（无单位）：也应补进 price
  const d2 = orch.decide({ text: "45", state, itemViews: [], pendingDraft, dateContext })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.equal(d2.turn.executableDraft.price, 45, "纯数字「45」应补进 price")
  assert.ok(!d2.turn.message.includes("多少钱"))
})

test("B4 验收: 缺金额草稿 → 追问 → 回「确认」→ 正常写入 → 不再追问", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  const d1 = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  const pendingDraft = d1.turn.executableDraft
  assert.equal(pendingDraft.price, undefined)
  assert.ok(d1.turn.message.includes("多少钱"))

  // 用户回「确认」：应命中 confirmDraft，executableDraft === pendingDraft
  const d2 = orch.decide({ text: "确认吧", state, itemViews: [], pendingDraft, dateContext })
  assert.ok(d2.kind === "sync")
  assert.ok(d2.turn.kind === "proposal")
  assert.equal(d2.turn.executableDraft, pendingDraft, "confirmDraft 应返回原 draft 引用")
  assert.ok(!d2.turn.message.includes("多少钱"), "confirm 路径不应追问")
  // price 仍为 undefined，由 executor 正常写入为空
  assert.equal(d2.turn.executableDraft.price, undefined)
})
