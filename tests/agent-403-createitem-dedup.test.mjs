// 403：创建消耗品去重与意图优先级测试
// 运行方式：node --test tests/agent-403-createitem-dedup.test.mjs
//
// 覆盖任务文档第七节 A-F：
//   A. 已存在消耗品不得重复创建
//   B. 已存在消耗品不得误判为补货
//   C. 不存在消耗品才生成 createItem 草稿
//   D. createItem 优先级高于 restock 的"加个"
//   E. 明确补货仍走 restock
//   F. 猫砂补货主流程不能回退

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
const { buildLocalDraftFromText, isExplicitCreateItemSignal, extractCreateItemName } = await import("../src/agent/drafts.ts")
const { commitAgentDraft } = await import("../src/agent/executor.ts")
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
    categories: ["宠物用品", "卫生间", "日常护理", "洗衣清洁", "其他"],
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
// A. 已存在消耗品不得重复创建
// =====================================================================

test("A.1. 已存在「洗衣液」+「帮我加个消耗品叫洗衣液」→ navigate turn，不生成 draft", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  const before = JSON.stringify(state)

  const d = decide(orch, {
    text: "帮我加个消耗品叫洗衣液",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  // 必须返回 navigate turn（已存在 → 打开详情）
  assert.equal(d.turn.kind, "navigate", "应返回 navigate turn（已存在提示+打开详情）")
  // message 包含"已经有"/"已存在"/"不需要重复"
  assert.ok(
    d.turn.message.includes("已经有") || d.turn.message.includes("已存在") || d.turn.message.includes("不需要重复"),
    `message 应包含已存在提示，实际: ${d.turn.message}`
  )
  // 不生成 executableDraft / collection / plan
  assert.ok(!("executableDraft" in d.turn), "不应有 executableDraft")
  assert.ok(!("collection" in d.turn), "不应有 collection")
  assert.ok(!("plan" in d.turn), "不应有 plan")
  // state 不变
  assert.equal(JSON.stringify(state), before, "state 不应变")
  assert.equal(state.items.length, 1, "不新增第二个洗衣液")
})

test("A.2. navigate target 指向已有物品", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "帮我加个消耗品叫洗衣液",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.turn.kind, "navigate")
  assert.ok(d.turn.target, "应携带 target")
  assert.equal(d.turn.target.kind, "item")
  assert.equal(d.turn.target.itemId, "i1")
})

test("A.3. 多种显式 createItem 表达 + 已存在 → 都返回 navigate", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  const phrases = [
    "帮我加个消耗品叫洗衣液",
    "添加一个消耗品叫洗衣液",
    "新建一个消耗品叫洗衣液",
    "创建一个消耗品：洗衣液",
    "帮我管理洗衣液",
    "以后提醒洗衣液"
  ]

  for (const phrase of phrases) {
    const d = decide(orch, { text: phrase, state, itemViews: viewsOf(state.items) })
    assert.equal(d.kind, "sync", `「${phrase}」应返回 sync`)
    assert.equal(d.turn.kind, "navigate", `「${phrase}」应返回 navigate turn`)
    assert.ok(!("executableDraft" in d.turn), `「${phrase}」不应有 executableDraft`)
    assert.equal(state.items.length, 1, `「${phrase}」后 state.items 仍为 1`)
  }
})

// =====================================================================
// B. 已存在消耗品不得误判为补货
// =====================================================================

test("B.1. 已存在「洗衣液」+「帮我加个消耗品叫洗衣液」→ buildLocalDraftFromText 返回 null", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const draft = buildLocalDraftFromText("帮我加个消耗品叫洗衣液", state)
  assert.equal(draft, null, "buildLocalDraftFromText 应返回 null（不生成任何 draft）")
})

test("B.2. 不得生成 restock draft", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "帮我加个消耗品叫洗衣液",
    state,
    itemViews: viewsOf(state.items)
  })

  // 不得是 collection / proposal turn（这些会携带 draft）
  assert.ok(d.turn.kind !== "collection", "不得返回 collection turn")
  assert.ok(d.turn.kind !== "proposal", "不得返回 proposal turn")
  // message 不得包含补货追问
  assert.ok(!d.turn.message.includes("实际金额"), "message 不得包含「实际金额」")
  assert.ok(!d.turn.message.includes("日期按"), "message 不得包含「日期按」")
  assert.ok(!d.turn.message.includes("1 件") && !d.turn.message.includes("1件"), "message 不得包含「1 件」")
})

// =====================================================================
// C. 不存在消耗品才生成 createItem 草稿
// =====================================================================

test("C.1. 不存在「洗衣液」+「帮我加个消耗品叫洗衣液」→ proposal turn + createItem draft", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "帮我加个消耗品叫洗衣液",
    state,
    itemViews: []
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "proposal", "应返回 proposal turn")
  assert.ok(d.turn.executableDraft, "应有 executableDraft")
  assert.equal(d.turn.executableDraft.kind, "createItem")
  assert.equal(d.turn.executableDraft.itemName, "洗衣液")
  // state 不变（确认前不写入）
  assert.equal(state.items.length, 0, "state.items 不应立即增加")
})

test("C.2. 确认后才正式创建", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()

  // 首轮 → proposal
  const d1 = decide(orch, { text: "帮我加个消耗品叫洗衣液", state, itemViews: [] })
  const pendingDraft = d1.turn.executableDraft
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.kind, "createItem")

  // 确认 → draftCommit
  const d2 = decide(orch, { text: "就这么记", state, itemViews: [], pendingDraft })
  assert.equal(d2.turn.kind, "planCommand")
  assert.equal(d2.turn.command.command, "draftCommit")

  // commit → 新增
  const result = commitAgentDraft(state, pendingDraft, NOW)
  assert.equal(result.state.items.length, 1, "确认后新增一个洗衣液")
  assert.equal(result.state.items[0].name, "洗衣液")
})

// =====================================================================
// D. createItem 优先级高于 restock 的"加个"
// =====================================================================

test("D.1. isExplicitCreateItemSignal 识别显式 createItem 信号", () => {
  const signals = [
    "帮我加个消耗品叫洗衣液",
    "添加一个消耗品叫洗衣液",
    "新建一个消耗品叫洗衣液",
    "创建一个消耗品：洗衣液",
    "帮我管理洗衣液",
    "以后提醒洗衣液"
  ]
  for (const s of signals) {
    assert.ok(isExplicitCreateItemSignal(s), `「${s}」应被识别为显式 createItem 信号`)
  }

  // 非显式 createItem 信号
  const nonSignals = [
    "今天买了 2 袋猫砂，68 元",
    "改成 3 袋",
    "确认",
    "猫砂周期改成 30 天"
  ]
  for (const s of nonSignals) {
    assert.ok(!isExplicitCreateItemSignal(s), `「${s}」不应被识别为显式 createItem 信号`)
  }
})

test("D.2. extractCreateItemName 正确提取物品名", () => {
  const cases = [
    { text: "帮我加个消耗品叫洗衣液", expect: "洗衣液" },
    { text: "创建一个消耗品：洗衣液", expect: "洗衣液" },
    { text: "帮我管理洗衣液", expect: "洗衣液" },
    { text: "以后提醒洗衣液", expect: "洗衣液" }
  ]
  for (const { text, expect } of cases) {
    const name = extractCreateItemName(text)
    assert.equal(name, expect, `「${text}」应提取出「${expect}」，实际: ${name}`)
  }
})

test("D.3. 不存在时 buildLocalDraftFromText 返回 createItem（非 restock）", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加个消耗品叫洗衣液", state)
  assert.ok(draft, "应构造出 draft")
  assert.equal(draft.kind, "createItem", "kind 应为 createItem，不得为 restock")
  assert.equal(draft.itemName, "洗衣液")
  // 不得有 qty=1
  if (draft.kind === "restock") {
    assert.fail("不得生成 restock draft")
  }
})

// =====================================================================
// E. 明确补货仍走 restock
// =====================================================================

test("E.1. 已存在「洗衣液」+「今天买了 1 瓶洗衣液，28 元」→ restock proposal", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理", { unit: "瓶" })] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "今天买了 1 瓶洗衣液，28 元",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "proposal", "明确补货应返回 proposal turn")
  assert.ok(d.turn.executableDraft)
  assert.equal(d.turn.executableDraft.kind, "restock", "kind 应为 restock")
  assert.equal(d.turn.executableDraft.itemName, "洗衣液")
  assert.equal(d.turn.executableDraft.qty, 1)
  assert.equal(d.turn.executableDraft.unit, "瓶")
  assert.equal(d.turn.executableDraft.price, 28)
  // 不得返回 navigate（不说"洗衣液已经存在所以不创建"）
  assert.ok(d.turn.kind !== "navigate", "明确补货不得返回 navigate")
})

// =====================================================================
// F. 猫砂补货主流程不能回退
// =====================================================================

test("F. 「2袋68元」→「改成3袋」→「金额改成78」→「确认」→ qty=3 price=78", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()

  // Step 1: 首轮 → proposal
  let pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.kind, "restock")
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
// G. 名称匹配与去重规则
// =====================================================================

test("G.1. 精确匹配去重", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "帮我加个消耗品叫洗衣液", state, itemViews: viewsOf(state.items) })
  assert.equal(d.turn.kind, "navigate")
  assert.equal(state.items.length, 1)
})

test("G.2. 清洗后匹配去重（消耗品叫前缀）", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "添加一个消耗品叫洗衣液", state, itemViews: viewsOf(state.items) })
  assert.equal(d.turn.kind, "navigate")
  assert.equal(state.items.length, 1)
})

test("G.3. 不做过度模糊匹配（洗衣凝珠 vs 洗衣液）", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const orch = createHouseholdOrchestrator()
  // 洗衣凝珠 ≠ 洗衣液 → 应生成 createItem proposal
  const d = decide(orch, { text: "帮我加个消耗品叫洗衣凝珠", state, itemViews: viewsOf(state.items) })
  assert.equal(d.turn.kind, "proposal", "洗衣凝珠 ≠ 洗衣液，应生成 createItem proposal")
  assert.equal(d.turn.executableDraft.kind, "createItem")
  assert.equal(d.turn.executableDraft.itemName, "洗衣凝珠")
})

test("G.4. 猫粮 vs 猫砂 不过度模糊匹配", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "帮我加个消耗品叫猫粮", state, itemViews: viewsOf(state.items) })
  assert.equal(d.turn.kind, "proposal", "猫粮 ≠ 猫砂，应生成 createItem proposal")
  assert.equal(d.turn.executableDraft.kind, "createItem")
  assert.equal(d.turn.executableDraft.itemName, "猫粮")
})
