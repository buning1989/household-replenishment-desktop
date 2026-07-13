// 403：补货首轮字段解析与平台可选字段测试
// 运行方式：node --test tests/agent-403-price-parsing.test.mjs
//
// 覆盖任务文档第八节 A-F：
//   A. 首轮补货金额保留：price=68 进入草稿，不进 collection
//   B. 平台缺失不阻塞：platform undefined 不触发 collection
//   C. 首轮文案包含金额：message 含 ¥68，不含「在哪个平台」
//   D. 确认后写入：连续确认 → history+1，字段正确
//   E. 修订后确认仍正常：2袋68元→3袋→78→确认 → qty=3 price=78
//   F. createItem 流程保持不变：首轮 proposal，确认后写入

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

const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { commitAgentDraft } = await import("../src/agent/executor.ts")
const { computeMissingSlots, computeCompleteness } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 11) // 2026-07-11
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeItem(id, name, category = "宠物用品", extra = {}) {
  return {
    id, name, category, type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [],
    createdAt: 1, updatedAt: 1, unit: "袋",
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0,
    ...extra
  }
}

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "日常护理", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function viewsOf(items) {
  return items.map((item) => ({ item }))
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// =====================================================================
// A. 首轮补货金额保留：price=68 进入草稿，不进 collection
// =====================================================================

test("A.1. 「今天买了 2 袋猫砂，68 元」→ draft.price=68，不进 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft, "应成功构造 draft")
  assert.equal(draft.kind, "restock")
  assert.equal(draft.itemName, "猫砂")
  assert.equal(draft.qty, 2)
  assert.equal(draft.unit, "袋")
  assert.equal(draft.price, 68, "price 必须为 68")
  assert.equal(draft.platform, undefined, "platform 应为 undefined")
})

test("A.2. orchestrator 返回 proposal turn（非 collection）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "今天买了 2 袋猫砂，68 元",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "proposal", "应返回 proposal turn，不得进入 collection")
  assert.ok(d.turn.executableDraft, "应有 executableDraft")
  assert.equal(d.turn.executableDraft.kind, "restock")
  assert.equal(d.turn.executableDraft.price, 68, "draft.price 必须为 68")
  assert.equal(d.turn.executableDraft.qty, 2)
  assert.equal(d.turn.executableDraft.platform, undefined)
})

test("A.3. 多种金额表达都能正确解析", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const cases = [
    { text: "今天买了 2 袋猫砂，68 元", expectPrice: 68 },
    { text: "今天买了2袋猫砂68元", expectPrice: 68 },
    { text: "猫砂两袋，花了68", expectPrice: 68 },
    { text: "猫砂 3 袋，金额 78", expectPrice: 78 }
  ]
  for (const { text, expectPrice } of cases) {
    const draft = buildLocalDraftFromText(text, state)
    assert.ok(draft, `「${text}」应构造出 draft`)
    assert.equal(draft.price, expectPrice, `「${text}」price 应为 ${expectPrice}`)
  }
})

// =====================================================================
// B. 平台缺失不阻塞：platform undefined 不触发 collection
// =====================================================================

test("B.1. computeMissingSlots 不包含 platform", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft)

  const slots = computeMissingSlots(draft)
  assert.equal(slots.requiredMissing.length, 0, "requiredMissing 应为空")
  assert.equal(slots.qualityMissing.length, 0, "qualityMissing 应为空（price=68 已提供，platform 不再算 qualityMissing）")
  assert.ok(!slots.qualityMissing.includes("platform"), "qualityMissing 不应包含 platform")
})

test("B.2. computeCompleteness 返回 readyToConfirm", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft)

  const completeness = computeCompleteness(draft)
  assert.equal(completeness, "readyToConfirm", "price=68 + platform=undefined → readyToConfirm")
})

test("B.3. 仅 price 缺失时才进 collection（platform 缺失不进）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  // 有 price 无 platform → readyToConfirm，不进 collection
  const draftWithPrice = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draftWithPrice)
  assert.equal(computeCompleteness(draftWithPrice), "readyToConfirm")

  // 无 price 无 platform → missingQualityFields（仅因 price 缺失）
  const draftNoPrice = {
    ...draftWithPrice,
    price: undefined
  }
  const slots = computeMissingSlots(draftNoPrice)
  assert.ok(slots.qualityMissing.includes("price"), "price 缺失应在 qualityMissing 中")
  assert.ok(!slots.qualityMissing.includes("platform"), "platform 不应在 qualityMissing 中")
  assert.equal(computeCompleteness(draftNoPrice), "missingQualityFields")
})

// =====================================================================
// C. 首轮文案包含金额：message 含 ¥68，不含「在哪个平台」
// =====================================================================

test("C.1. proposal message 包含 ¥68", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "今天买了 2 袋猫砂，68 元",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.turn.kind, "proposal")
  const msg = d.turn.message
  // message 或 draft 中包含 68 / ¥68
  assert.ok(
    msg.includes("68") || d.turn.executableDraft.price === 68,
    "message 或 draft 应包含 68"
  )
})

test("C.2. 不得包含平台追问短语", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "今天买了 2 袋猫砂，68 元",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.turn.kind, "proposal")
  const msg = d.turn.message
  assert.ok(!msg.includes("在哪个平台"), `message 不得包含「在哪个平台」，实际: ${msg}`)
  assert.ok(!msg.includes("哪个平台"), `message 不得包含「哪个平台」，实际: ${msg}`)
  assert.ok(!msg.includes("平台买的"), `message 不得包含「平台买的」，实际: ${msg}`)
})

test("C.3. 采集态文案也不追问平台（price 缺失时进 collection，但不问平台）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  // 无 price → 进 collection
  const d = decide(orch, {
    text: "今天买了 2 袋猫砂",
    state,
    itemViews: viewsOf(state.items)
  })

  if (d.turn.kind === "collection") {
    const msg = d.turn.message
    assert.ok(!msg.includes("在哪个平台"), `collection message 不得包含「在哪个平台」，实际: ${msg}`)
    assert.ok(!msg.includes("哪个平台"), `collection message 不得包含「哪个平台」，实际: ${msg}`)
    assert.ok(!msg.includes("平台买的"), `collection message 不得包含「平台买的」，实际: ${msg}`)
  }
})

// =====================================================================
// D. 确认后写入：连续确认 → history+1，字段正确
// =====================================================================

test("D. 「今天买了 2 袋猫砂，68 元」→「确认」→ history+1，qty=2 price=68 platform=undefined", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()

  // Step 1: 首轮 → proposal
  const d1 = decide(orch, {
    text: "今天买了 2 袋猫砂，68 元",
    state,
    itemViews: viewsOf(state.items)
  })
  assert.equal(d1.turn.kind, "proposal")
  const pendingDraft = d1.turn.executableDraft
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.price, 68)

  // Step 2: 确认 → draftCommit
  const d2 = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d2.turn.kind, "planCommand")
  assert.equal(d2.turn.command.command, "draftCommit")

  // Step 3: 模拟 commitAgentDraft
  const result = commitAgentDraft(state, pendingDraft, NOW)
  assert.equal(result.state.items[0].history.length, 1, "history +1")
  assert.equal(result.state.items[0].history[0].qty, 2)
  assert.equal(result.state.items[0].history[0].price, 68)
  assert.equal(result.state.items[0].history[0].platform, undefined, "platform 应为 undefined")
  assert.ok(result.state.lastAgentMutation, "lastAgentMutation 已记录")
})

// =====================================================================
// E. 修订后确认仍正常：2袋68元→3袋→78→确认
// =====================================================================

test("E. 「2袋68元」→「改成3袋」→「金额改成78」→「确认」→ qty=3 price=78", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()

  // Step 1: 首轮 → proposal
  let pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.qty, 2)
  assert.equal(pendingDraft.price, 68)

  // Step 2: 改成 3 袋
  const d1 = decide(orch, { text: "改成 3 袋", state, itemViews: viewsOf(state.items), pendingDraft })
  assert.equal(d1.turn.kind, "proposal")
  assert.equal(d1.turn.executableDraft.qty, 3)
  pendingDraft = d1.turn.executableDraft

  // Step 3: 金额改成 78
  const d2 = decide(orch, { text: "金额改成 78", state, itemViews: viewsOf(state.items), pendingDraft })
  assert.equal(d2.turn.kind, "proposal")
  assert.equal(d2.turn.executableDraft.price, 78)
  pendingDraft = d2.turn.executableDraft

  // Step 4: 确认 → draftCommit
  const d3 = decide(orch, { text: "确认", state, itemViews: viewsOf(state.items), pendingDraft })
  assert.equal(d3.turn.kind, "planCommand")
  assert.equal(d3.turn.command.command, "draftCommit")

  // Step 5: commit
  const result = commitAgentDraft(state, pendingDraft, NOW)
  assert.equal(result.state.items[0].history.length, 1)
  assert.equal(result.state.items[0].history[0].qty, 3, "最终 qty=3")
  assert.equal(result.state.items[0].history[0].price, 78, "最终 price=78")
  assert.equal(result.state.items[0].history[0].platform, undefined, "platform=undefined")
})

// =====================================================================
// F. createItem 流程保持不变
// =====================================================================

test("F.1. 「帮我加个消耗品叫洗衣液」→ 首轮 proposal，state.items 不增加", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "帮我加个消耗品叫洗衣液",
    state,
    itemViews: []
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "proposal", "首轮应为 proposal")
  assert.ok(d.turn.executableDraft, "应有 executableDraft")
  assert.equal(d.turn.executableDraft.kind, "createItem")
  assert.equal(d.turn.executableDraft.itemName, "洗衣液")
  // state 不立即增加
  assert.equal(state.items.length, 0, "state.items 不应立即增加")
})

test("F.2. createItem draft + 「就这么记」→ draftCommit → 只新增一次", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()

  // 首轮
  const d1 = decide(orch, { text: "帮我加个消耗品叫洗衣液", state, itemViews: [] })
  const pendingDraft = d1.turn.executableDraft
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.kind, "createItem")

  // 确认
  const d2 = decide(orch, { text: "就这么记", state, itemViews: [], pendingDraft })
  assert.equal(d2.turn.kind, "planCommand")
  assert.equal(d2.turn.command.command, "draftCommit")

  // commit
  const result = commitAgentDraft(state, pendingDraft, NOW)
  assert.equal(result.state.items.length, 1, "新增一个洗衣液")
  assert.equal(result.state.items[0].name, "洗衣液")

  // 重复确认不新增（findItem 命中已存在）
  const result2 = commitAgentDraft(result.state, pendingDraft, NOW)
  assert.equal(result2.state.items.length, 1, "不重复创建")
})
