// 阶段 2A：focusResolver 单测
// 运行方式：node --test tests/focus-resolver.test.mjs
//
// 覆盖《Agent 决策入口重构方案》阶段 2A 重点用例：
//   1. pendingCollection + 「拼多多」→ continue_pending_collection
//   2. pendingCollection + 「128」→ continue_pending_collection
//   3. pendingCollection + 「不起灰」→ continue_pending_collection
//   4. pendingCollection + 「不是宠物擦脚湿巾，是五常大米」→ correct_pending_collection
//   5. pendingCollection + 「今天买了 3 袋五常大米」→ start_new_collection（串物品修复前置判断）
//   6. pendingPlan 高风险删除 + 「确认删除」→ continue_pending_plan
//   7. pendingPlan 高风险删除 + 「确认」→ continue_pending_plan（不直接执行，仍走原二次确认）
//   8. pendingPlan 高风险删除 + 「今天买了 3 袋五常大米」→ 不得继续删除执行（start_new_collection）
//   9. 无 pending + new_restock_record → route_to_write_draft
//  10. query_inventory → route_to_query
//
// focusResolver 是纯函数：不调用 executor、不生成 UI message、不接入 decideSync。
// 本文件通过真实 interpretUserTurn 生成 interpretation，再交给 resolveConversationFocus 决策。

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

const { interpretUserTurn } = await import("../src/agent/turnInterpretation.ts")
const { resolveConversationFocus } = await import("../src/agent/focusResolver.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)

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

function interpret(text, state = makeState()) {
  return interpretUserTurn({ text, state, itemViews: [], dateContext: DATE_CONTEXT })
}

function resolve(input) {
  return resolveConversationFocus(input)
}

// 用真实 buildLocalDraftFromText + createDraftCollection 构造采集态
function buildCollection(text, state) {
  const draft = buildLocalDraftFromText(text, state)
  assert.ok(draft, `预期「${text}」能解析出草稿`)
  return createDraftCollection(draft, [], NOW)
}

// 构造一个高风险删除 plan（pending 状态）
function buildHighRiskDeletePlan(itemName) {
  const plan = createAgentPlan(
    [{ type: "deleteItem", itemName }],
    `删除消耗品${itemName}`,
    NOW
  )
  assert.equal(plan.risk, "high")
  assert.equal(plan.requiresSecondConfirm, true)
  return plan
}

// ---------- 1. pendingCollection + 「拼多多」→ continue_pending_collection ----------

test("1. pendingCollection=猫砂 + 「拼多多」→ continue_pending_collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("拼多多", state)
  assert.equal(interp.intent, "supplement_current_collection")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "continue_pending_collection")
})

// ---------- 2. pendingCollection + 「128」→ continue_pending_collection ----------

test("2. pendingCollection=猫砂 + 「128」→ continue_pending_collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("128", state)
  assert.equal(interp.intent, "supplement_current_collection")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "continue_pending_collection")
})

// ---------- 3. pendingCollection + 「不起灰」→ continue_pending_collection ----------

test("3. pendingCollection=猫砂 + 「不起灰」→ continue_pending_collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("不起灰", state)
  assert.equal(interp.intent, "supplement_current_collection")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "continue_pending_collection")
})

// ---------- 4. pendingCollection + 显式修正 → correct_pending_collection ----------

test("4. pendingCollection=宠物擦脚湿巾 + 「不是宠物擦脚湿巾，是五常大米」→ correct_pending_collection", () => {
  // state 无「宠物擦脚湿巾」→ 首轮生成 createItemWithRestock 采集态
  const state = makeState({ items: [] })
  const collection = buildCollection("今天买了 5 包宠物擦脚湿巾", state)
  const interp = interpret("不是宠物擦脚湿巾，是五常大米", state)
  assert.equal(interp.intent, "correct_current_collection")
  assert.equal(interp.fields.itemName, "五常大米")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "correct_pending_collection")
})

// ---------- 5. pendingCollection + 新补货记录（不同物品）→ start_new_collection ----------

test("5. pendingCollection=宠物擦脚湿巾 + 「今天买了 3 袋五常大米」→ start_new_collection", () => {
  const state = makeState({ items: [] })
  const collection = buildCollection("今天买了 5 包宠物擦脚湿巾", state)
  const interp = interpret("今天买了 3 袋五常大米", state)
  assert.equal(interp.intent, "new_restock_record")
  assert.equal(interp.fields.itemName, "五常大米")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "start_new_collection", "不同物品名应开启新采集，而非把旧物品改成 3 袋")
  assert.equal(d.mentionedDifferentItem, true)
})

test("5b. pendingCollection=猫砂 + 「今天买了 2 袋猫砂」（同物品）→ continue_pending_collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("今天买了 2 袋猫砂", state)
  assert.equal(interp.intent, "new_restock_record")
  assert.equal(interp.fields.itemName, "猫砂")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "continue_pending_collection", "同物品名应继续当前采集态叠加字段")
  assert.equal(d.mentionedDifferentItem, false)
})

// ---------- 6. pendingPlan 高风险删除 + 「确认删除」→ continue_pending_plan ----------

test("6. pendingPlan=高风险删除 + 「确认删除」→ continue_pending_plan", () => {
  const plan = buildHighRiskDeletePlan("猫砂")
  const interp = interpret("确认删除")
  assert.equal(interp.intent, "confirm_current_task")
  assert.equal(interp.signals.hasDeleteSignal, true)

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.equal(d.focus, "continue_pending_plan")
})

// ---------- 7. pendingPlan 高风险删除 + 「确认」→ continue_pending_plan（不直接执行） ----------

test("7. pendingPlan=高风险删除 + 「确认」→ continue_pending_plan（reason 提示不直接执行）", () => {
  const plan = buildHighRiskDeletePlan("猫砂")
  const interp = interpret("确认")
  assert.equal(interp.intent, "confirm_current_task")
  // 普通「确认」不应带 hasDeleteSignal（不是二次确认删除短语）
  assert.equal(interp.signals.hasDeleteSignal, false)

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.equal(d.focus, "continue_pending_plan")
  // reason 必须提示「高风险」「不直接执行」语义，避免调用方误以为可以直接 commit
  assert.match(d.reason, /高风险/)
  assert.match(d.reason, /不直接执行|二次确认/)
})

// ---------- 8. pendingPlan 高风险删除 + 新补货记录 → 不得继续删除执行 ----------

test("8. pendingPlan=高风险删除 + 「今天买了 3 袋五常大米」→ 不得继续删除（应为 start_new_collection）", () => {
  const plan = buildHighRiskDeletePlan("猫砂")
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const interp = interpret("今天买了 3 袋五常大米", state)
  assert.equal(interp.intent, "new_restock_record")
  assert.equal(interp.fields.itemName, "五常大米")

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.notEqual(d.focus, "continue_pending_plan", "新补货记录绝不能触发删除执行")
  assert.equal(d.focus, "start_new_collection", "应视为开启新补货采集，旧删除 plan 由调用方标 superseded")
})

test("8b. pendingPlan=高风险删除 awaitingSecondConfirm + 新补货记录 → 不得继续删除", () => {
  const plan = buildHighRiskDeletePlan("猫砂")
  plan.status = "awaitingSecondConfirm"
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const interp = interpret("今天买了 3 袋五常大米", state)

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.notEqual(d.focus, "continue_pending_plan")
  assert.equal(d.focus, "start_new_collection")
})

test("8c. pendingPlan=高风险删除 + 查询「猫砂还能用多久」→ route_to_query（不打断也不执行删除）", () => {
  const plan = buildHighRiskDeletePlan("猫砂")
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const interp = interpret("猫砂还能用多久", state)
  assert.equal(interp.intent, "query_inventory")

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.notEqual(d.focus, "continue_pending_plan")
  assert.equal(d.focus, "route_to_query")
})

// ---------- 9. 无 pending + new_restock_record → route_to_write_draft ----------

test("9. 无 pending + 「今天买了 3 袋五常大米」→ route_to_write_draft", () => {
  const state = makeState({ items: [] })
  const interp = interpret("今天买了 3 袋五常大米", state)
  assert.equal(interp.intent, "new_restock_record")

  const d = resolve({ interpretation: interp })
  assert.equal(d.focus, "route_to_write_draft")
})

// ---------- 10. query_inventory → route_to_query ----------

test("10. 无 pending + 「猫砂还能用多久」→ route_to_query", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const interp = interpret("猫砂还能用多久", state)
  assert.equal(interp.intent, "query_inventory")

  const d = resolve({ interpretation: interp })
  assert.equal(d.focus, "route_to_query")
})

// ---------- 补充：删除请求 / 预算 / 物品管理 → route_to_navigate（403 收缩）----------

test("11. 无 pending + 「删除卫生间下的消耗品」→ route_to_navigate（403 收缩，删除走导航）", () => {
  const state = makeState({ items: [] })
  const interp = interpret("删除卫生间下的消耗品", state)
  assert.equal(interp.intent, "delete_request")

  const d = resolve({ interpretation: interp })
  assert.equal(d.focus, "route_to_navigate")
})

test("12. 无 pending + 「把月预算设成 800」→ route_to_navigate（403 收缩，预算走导航）", () => {
  const interp = interpret("把月预算设成 800")
  assert.equal(interp.intent, "manage_budget")

  const d = resolve({ interpretation: interp })
  assert.equal(d.focus, "route_to_navigate")
})

// ---------- 补充：闲聊 / 兜底 ----------

test("13. 无 pending + 「你好」→ route_to_smalltalk", () => {
  const interp = interpret("你好")
  assert.equal(interp.intent, "smalltalk")

  const d = resolve({ interpretation: interp })
  assert.equal(d.focus, "route_to_smalltalk")
})

test("14. 无 pending + 无法归类「xyzqw」→ route_to_llm", () => {
  const interp = interpret("xyzqw")
  assert.equal(interp.intent, "unknown")

  const d = resolve({ interpretation: interp })
  assert.equal(d.focus, "route_to_llm")
})

// ---------- 补充：pendingCollection + 查询 → route_to_query（不打断采集态） ----------

test("15. pendingCollection=猫砂 + 「猫砂还能用多久」→ route_to_query", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("猫砂还能用多久", state)
  assert.equal(interp.intent, "query_inventory")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "route_to_query")
})

// ---------- 补充：pendingCollection + 取消 → continue_pending_collection ----------

test("16. pendingCollection=猫砂 + 「算了，不记了」→ continue_pending_collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("算了，不记了", state)
  assert.equal(interp.intent, "cancel_current_task")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "continue_pending_collection")
})

// ---------- 补充：pendingCollection + 强制保存 → continue_pending_collection ----------

test("17. pendingCollection=猫砂 + 「就这样」→ continue_pending_collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const collection = buildCollection("今天买了 5 袋猫砂", state)
  const interp = interpret("就这样", state)
  assert.equal(interp.intent, "force_proposal")

  const d = resolve({ interpretation: interp, pendingCollection: collection })
  assert.equal(d.focus, "continue_pending_collection")
})

// ---------- 补充：pendingPlan 普通风险 + 确认 → continue_pending_plan ----------

test("18. pendingPlan=普通风险 + 「确认」→ continue_pending_plan", () => {
  const plan = createAgentPlan(
    [{ type: "setMonthlyBudget", amount: 800 }],
    "把月预算设成 800",
    NOW
  )
  assert.equal(plan.risk, "low")
  const interp = interpret("确认")
  assert.equal(interp.intent, "confirm_current_task")

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.equal(d.focus, "continue_pending_plan")
})

// ---------- 补充：已完成/取消的 plan 不视为活跃 pending ----------

test("19. pendingPlan.status=confirmed + 新补货记录 → route_to_write_draft（非活跃 plan 不拦截）", () => {
  const plan = buildHighRiskDeletePlan("猫砂")
  plan.status = "confirmed"
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const interp = interpret("今天买了 3 袋五常大米", state)
  assert.equal(interp.intent, "new_restock_record")

  const d = resolve({ interpretation: interp, pendingPlan: plan })
  assert.equal(d.focus, "route_to_write_draft", "已 confirmed 的 plan 不应拦截新任务")
})
