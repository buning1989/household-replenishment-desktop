// 阶段 4B.7 补口：groundedQuery 不得吞掉删除/修改类动作意图
// 运行方式：node --test tests/agent-grounded-query-action-guard.test.mjs
//
// 覆盖任务规范第五节 5 个场景：
//   1. 「删除猫砂补货记录」不得 handler=groundedQuery，不得返回猫砂最近一次补货记录
//   2. 「删除这条补货记录」不得 handler=item_not_found，不得建议「帮我加 删除这条补货记录」
//   3. 「修改猫砂补货记录」不得进入 groundedQuery
//   4. 「删掉狗粮最近一次补货记录」不得进入 groundedQuery
//   5. 原有只读查询仍正常（回归）：
//      - 「狗粮最近一次补货记录」仍返回真实最新记录
//      - 「狗粮上次多少钱」仍返回真实金额
//      - 「狗粮买了几袋」仍返回真实数量

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

const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { detectItemRecordQuery, hasItemRecordQuerySignal, hasActionIntentSignal } = await import("../src/agent/groundedQuery.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "日常护理", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function makeItem(id, name, category, extra = {}) {
  return {
    id,
    name,
    category,
    type: "learning",
    cycleDays: 14,
    bufferDays: 2,
    lastRestockedAt: 1,
    anchorEstimated: false,
    purchaseOptions: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    unit: "袋",
    ...extra
  }
}

function makeHistoryEntry(id, dateStr, qty, unit, price, platform) {
  const [year, month, day] = dateStr.split("/").map(Number)
  return {
    id,
    at: Date.UTC(year, month - 1, day),
    qty,
    purchaseUnit: unit,
    price,
    platform
  }
}

function viewsOf(items) {
  return items.map((item) => ({
    item,
    computed: {
      status: "normal",
      displayStatus: "normal",
      statusLabel: "充足",
      dueAt: Date.now() + 30 * 86400000,
      depletionAt: Date.now() + 30 * 86400000,
      daysUntilDue: 30,
      remainingText: "约 30 天",
      remainingQty: null
    }
  }))
}

function decide(orch, input) {
  const trace = createTrace(input.text, {})
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], trace, ...input })
}

// 构造猫砂物品：最新补货 2026/7/8, 2袋, 京东, ¥110
function makeCatSandState() {
  const item = makeItem("i1", "猫砂", "宠物用品", {
    unit: "袋",
    history: [
      makeHistoryEntry("h1", "2026/7/8", 2, "袋", 110, "京东")
    ],
    lastRestockedAt: Date.UTC(2026, 6, 8)
  })
  return makeState({ items: [item] })
}

// 构造狗粮物品：最新补货 2026/7/9, 1袋, 淘宝, ¥300
function makeDogFoodState() {
  const item = makeItem("i2", "狗粮", "宠物用品", {
    unit: "袋",
    history: [
      makeHistoryEntry("h1", "2026/7/9", 1, "袋", 300, "淘宝")
    ],
    lastRestockedAt: Date.UTC(2026, 6, 9)
  })
  return makeState({ items: [item] })
}

// ---------- 1. 「删除猫砂补货记录」不得走 groundedQuery ----------

test("1. 「删除猫砂补货记录」不得 handler=groundedQuery，不得返回猫砂最近一次补货记录", () => {
  const state = makeCatSandState()
  const orch = createHouseholdOrchestrator()

  // 前置验证：hasActionIntentSignal 命中
  assert.ok(hasActionIntentSignal("删除猫砂补货记录"), "应命中删除动作信号")

  // 前置验证：detectItemRecordQuery 返回 null
  const query = detectItemRecordQuery("删除猫砂补货记录", state)
  assert.equal(query, null, "detectItemRecordQuery 应返回 null（动作意图不走 grounded query）")

  // 前置验证：hasItemRecordQuerySignal 返回 false
  assert.equal(hasItemRecordQuerySignal("删除猫砂补货记录"), false, "hasItemRecordQuerySignal 应返回 false")

  // 端到端：decide 不得 handler=groundedQuery
  const d = decide(orch, {
    text: "删除猫砂补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  // 不应是 sync answer 返回查询记录
  if (d.kind === "sync" && d.turn.kind === "answer") {
    const msg = d.turn.message
    // 不得返回猫砂最近一次补货记录的查询回答
    assert.ok(
      !msg.includes("2026/7/8") || msg.includes("删除"),
      `不得把删除请求当成查询回答, 实际 message: ${msg}`
    )
    // 不应出现 grounded query 风格的回答（「最近一次补货是」）
    assert.ok(!msg.includes("最近一次补货是"), `不应返回查询风格回答, 实际: ${msg}`)
  }

  // 应进入 writeDraft → planner → 生成删除 plan（planProposal）
  // 或 clarification（找不到物品时）
  // 或 navigate（403 收缩后走导航）
  assert.ok(
    d.kind === "sync" && (d.turn.kind === "planProposal" || d.turn.kind === "clarification" || d.turn.kind === "answer" || d.turn.kind === "navigate"),
    `删除请求应生成 planProposal/clarification/answer/navigate, 实际: ${d.kind}/${d.turn?.kind}`
  )
})

// ---------- 2. 「删除这条补货记录」不得走 item_not_found ----------

test("2. 「删除这条补货记录」不得 handler=item_not_found，不得建议「帮我加 删除这条补货记录」", () => {
  const state = makeCatSandState()
  const orch = createHouseholdOrchestrator()

  // 前置验证
  assert.ok(hasActionIntentSignal("删除这条补货记录"), "应命中删除动作信号")
  assert.equal(hasItemRecordQuerySignal("删除这条补货记录"), false, "hasItemRecordQuerySignal 应返回 false")

  const d = decide(orch, {
    text: "删除这条补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  // 不得是 item_not_found 风格的回答
  if (d.kind === "sync" && d.turn.kind === "answer") {
    const msg = d.turn.message
    // 不得建议「帮我加 删除这条补货记录」
    assert.ok(!msg.includes("帮我加 删除这条补货记录"), `不得建议帮我加整句, 实际: ${msg}`)
    // 不得出现 item_not_found 风格的「没有查到」
    assert.ok(!msg.includes("没有查到「删除这条补货记录」"), `不得把整句当物品名查询, 实际: ${msg}`)
  }

  // 应返回 clarification 或 planProposal 或 answer 或 navigate（追问物品名/导航）
  assert.ok(
    d.kind === "sync" && (d.turn.kind === "clarification" || d.turn.kind === "planProposal" || d.turn.kind === "answer" || d.turn.kind === "navigate"),
    `应追问物品名或导航, 实际: ${d.kind}/${d.turn?.kind}`
  )

  // 如果是 clarification 或 answer，message 应引导用户指定物品名
  const msg = d.turn?.message ?? ""
  if (d.turn?.kind === "clarification" || d.turn?.kind === "answer") {
    assert.ok(
      msg.includes("哪一条") || msg.includes("物品名") || msg.includes("消耗品") || msg.includes("找不到"),
      `应追问物品名, 实际: ${msg}`
    )
  }
})

// ---------- 3. 「修改猫砂补货记录」不得进入 groundedQuery ----------

test("3. 「修改猫砂补货记录」不得进入 groundedQuery", () => {
  const state = makeCatSandState()
  const orch = createHouseholdOrchestrator()

  // 前置验证
  assert.ok(hasActionIntentSignal("修改猫砂补货记录"), "应命中修改动作信号")
  assert.equal(detectItemRecordQuery("修改猫砂补货记录", state), null, "detectItemRecordQuery 应返回 null")
  assert.equal(hasItemRecordQuerySignal("修改猫砂补货记录"), false, "hasItemRecordQuerySignal 应返回 false")

  const d = decide(orch, {
    text: "修改猫砂补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  // 不得返回查询风格回答
  if (d.kind === "sync" && d.turn.kind === "answer") {
    const msg = d.turn.message
    assert.ok(!msg.includes("最近一次补货是"), `不应返回查询风格回答, 实际: ${msg}`)
  }
})

// ---------- 4. 「删掉狗粮最近一次补货记录」不得进入 groundedQuery ----------

test("4. 「删掉狗粮最近一次补货记录」不得进入 groundedQuery", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  // 前置验证
  assert.ok(hasActionIntentSignal("删掉狗粮最近一次补货记录"), "应命中删除动作信号")
  assert.equal(detectItemRecordQuery("删掉狗粮最近一次补货记录", state), null, "detectItemRecordQuery 应返回 null")
  assert.equal(hasItemRecordQuerySignal("删掉狗粮最近一次补货记录"), false, "hasItemRecordQuerySignal 应返回 false")

  const d = decide(orch, {
    text: "删掉狗粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  // 不得返回查询风格回答
  if (d.kind === "sync" && d.turn.kind === "answer") {
    const msg = d.turn.message
    assert.ok(!msg.includes("最近一次补货是"), `不应返回查询风格回答, 实际: ${msg}`)
  }

  // 应生成 planProposal（planner 的 tryParseDeleteRestockRecord 会命中）
  // 或 clarification 或 navigate（403 收缩后走导航）
  assert.ok(
    d.kind === "sync" && (d.turn.kind === "planProposal" || d.turn.kind === "clarification" || d.turn.kind === "answer" || d.turn.kind === "navigate"),
    `应生成删除 plan 或 clarification 或 navigate, 实际: ${d.kind}/${d.turn?.kind}`
  )

  // 如果是 planProposal，应包含 deleteRestockRecord 动作
  if (d.kind === "sync" && d.turn.kind === "planProposal" && d.turn.plan) {
    const hasDelete = d.turn.plan.actions.some((a) => a.type === "deleteRestockRecord")
    assert.ok(hasDelete, "plan 应包含 deleteRestockRecord 动作")
  }
})

// ---------- 5. 原有只读查询仍正常（回归） ----------

test("5a. 「狗粮最近一次补货记录」仍返回真实最新记录（不回退）", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  // 前置验证：不含动作信号
  assert.equal(hasActionIntentSignal("狗粮最近一次补货记录"), false, "不应命中动作信号")

  const d = decide(orch, {
    text: "狗粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("2026/7/9"), `应回答 2026/7/9, 实际: ${msg}`)
  assert.ok(msg.includes("1袋") || msg.includes("1 袋"), `应回答 1袋, 实际: ${msg}`)
  assert.ok(msg.includes("淘宝"), `应回答 淘宝, 实际: ${msg}`)
  assert.ok(msg.includes("300"), `应回答 ¥300, 实际: ${msg}`)
})

test("5b. 「狗粮上次多少钱」仍返回真实金额（不回退）", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  assert.equal(hasActionIntentSignal("狗粮上次多少钱"), false, "不应命中动作信号")

  const d = decide(orch, {
    text: "狗粮上次多少钱",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("300"), `应回答 ¥300, 实际: ${msg}`)
})

test("5c. 「狗粮买了几袋」仍返回真实数量（不回退）", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  assert.equal(hasActionIntentSignal("狗粮买了几袋"), false, "不应命中动作信号")

  const d = decide(orch, {
    text: "狗粮买了几袋",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("1袋") || msg.includes("1 袋"), `应回答 1袋, 实际: ${msg}`)
})

// ---------- 6. 附加：动作信号单元测试 ----------

test("6. hasActionIntentSignal 覆盖所有动作信号词", () => {
  // 删除类
  assert.ok(hasActionIntentSignal("删除猫砂"))
  assert.ok(hasActionIntentSignal("删掉猫砂"))
  assert.ok(hasActionIntentSignal("猫砂删了"))
  assert.ok(hasActionIntentSignal("移除猫砂"))
  assert.ok(hasActionIntentSignal("去掉猫砂"))
  assert.ok(hasActionIntentSignal("撤销猫砂"))
  assert.ok(hasActionIntentSignal("取消这条"))
  assert.ok(hasActionIntentSignal("不要这条"))
  // 修改类
  assert.ok(hasActionIntentSignal("修改猫砂"))
  assert.ok(hasActionIntentSignal("改一下猫砂"))
  assert.ok(hasActionIntentSignal("猫砂改成"))
  assert.ok(hasActionIntentSignal("修正猫砂"))
  assert.ok(hasActionIntentSignal("纠正猫砂"))
  assert.ok(hasActionIntentSignal("猫砂改掉"))

  // 只读查询不应命中
  assert.ok(!hasActionIntentSignal("狗粮最近一次补货记录"))
  assert.ok(!hasActionIntentSignal("狗粮上次多少钱"))
  assert.ok(!hasActionIntentSignal("狗粮在哪买的"))
  assert.ok(!hasActionIntentSignal("狗粮买了几袋"))
})
