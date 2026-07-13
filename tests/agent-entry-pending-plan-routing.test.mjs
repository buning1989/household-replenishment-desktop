// 阶段 3A：pendingPlan 接入 turnInterpretation + focusResolver 路由测试
// 运行方式：node --test tests/agent-entry-pending-plan-routing.test.mjs
//
// 覆盖阶段 3A 核心行为要求：
//   1. 高风险删除 + 确认删除 → continue_pending_plan（二次确认不绕过）
//   2. 高风险删除 + 确认 → continue_pending_plan（弱确认提示需要「确认删除」）
//   3. 高风险删除 + 新补货 → start_new_collection（不执行删除）
//   4. 高风险删除 + 查询 → 不执行删除，不新建 collection
//   5. 高风险删除 + 取消 → 取消 plan，不执行删除
//   6. 普通 pendingPlan + 新补货 → 新建 collection，不继续 plan

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

function viewsOf(items) {
  return items.map((item) => ({ item }))
}

/** 构造一个删除卫生间下消耗品的高风险 plan（deleteItem action → risk=high） */
function makeDeletePlan(status = "pending") {
  const plan = createAgentPlan(
    [{ type: "deleteItem", itemId: "i1", itemName: "卫生纸" }],
    "删除卫生间下的消耗品",
    NOW
  )
  return { ...plan, status }
}

/** 构造一个普通低风险 plan（createCategory action → risk=low） */
function makeNormalPlan(status = "pending") {
  const plan = createAgentPlan(
    [{ type: "createCategory", name: "清洁用品" }],
    "新建分类清洁用品",
    NOW
  )
  return { ...plan, status }
}

/** 从 AgentDraft 统一取出补货字段（兼容 restock / createItemWithRestock） */
function restockFields(draft) {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      qty: draft.qty,
      unit: draft.unit,
      platform: draft.platform,
      price: draft.price
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      qty: draft.restock.qty,
      unit: draft.restock.unit,
      platform: draft.restock.platform,
      price: draft.restock.price
    }
  }
  return { itemName: undefined, qty: undefined, unit: undefined, platform: undefined, price: undefined }
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// ---------- 测试 ----------

test("3A-1: 高风险删除 awaitingSecondConfirm + 确认删除 → planSecondConfirm", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("awaitingSecondConfirm")

  const decision = decide(orch, {
    text: "确认删除",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planSecondConfirm")
})

test("3A-2: 高风险删除 awaitingSecondConfirm + 确认 → 弱确认提示需要「确认删除」", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("awaitingSecondConfirm")

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  // 应该是 answer turn，提示需要说「确认删除」
  assert.equal(decision.turn.kind, "answer")
  assert.ok(
    decision.turn.message.includes("确认删除"),
    `message 应提示需要「确认删除」, 实际: ${decision.turn.message}`
  )
})

test("3A-3: 高风险删除 awaitingSecondConfirm + 新补货 → 新建 collection，不执行删除", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("awaitingSecondConfirm")

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "五常大米")
  assert.equal(fields.qty, 3)
  // 不得出现删除成功文案
  assert.ok(
    !decision.turn.message.includes("删除"),
    `message 不应包含「删除」, 实际: ${decision.turn.message}`
  )
  assert.ok(
    !decision.turn.message.includes("已删除"),
    `message 不应包含「已删除」, 实际: ${decision.turn.message}`
  )
})

test("3A-4: 高风险删除 awaitingSecondConfirm + 查询 → 不执行删除，不新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const catSand = makeItem("i2", "猫砂", "宠物用品")
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间"), catSand] })
  const pendingPlan = makeDeletePlan("awaitingSecondConfirm")

  const decision = decide(orch, {
    text: "猫砂还能用多久",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  // 查询应走 needLm 或 answer，不应执行删除或新建 collection
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "collection")
    assert.notEqual(decision.turn.kind, "planCommand")
    assert.ok(
      !decision.turn.message.includes("删除"),
      `message 不应包含「删除」, 实际: ${decision.turn.message}`
    )
  } else {
    assert.equal(decision.kind, "needLlm")
  }
})

test("3A-5: 高风险删除 awaitingSecondConfirm + 取消 → planCancel", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("awaitingSecondConfirm")

  const decision = decide(orch, {
    text: "算了",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planCancel")
})

test("3A-6: 普通 pendingPlan + 新补货 → 新建 collection，不继续 plan", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })
  const pendingPlan = makeNormalPlan("pending")

  const decision = decide(orch, {
    text: "刚买了 2 瓶洗衣液",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "洗衣液")
  assert.equal(fields.qty, 2)
})

test("3A-7: 高风险删除 pending（非 awaitingSecondConfirm）+ 确认 → planAwaitingSecondConfirm", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("pending")

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planAwaitingSecondConfirm")
})

test("3A-8: 高风险删除 pending + 确认删除 → 直接 planSecondConfirm（跳过 awaitingSecondConfirm）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("pending")

  const decision = decide(orch, {
    text: "确认删除",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planSecondConfirm")
})

test("3A-9: 高风险删除 pending + 取消 → planCancel", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("pending")

  const decision = decide(orch, {
    text: "取消",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planCancel")
})

test("3A-10: 高风险删除 pending + 新补货 → 新建 collection，不执行删除", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "卫生纸", "卫生间")] })
  const pendingPlan = makeDeletePlan("pending")

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "五常大米")
  assert.equal(fields.qty, 3)
})

// ---------- 阶段 4B：「按这个来」确认语义补齐 ----------

test("3A-11: 普通 pendingPlan + 「按这个来」→ 仍走 plan handler（planCommand）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingPlan = makeNormalPlan("pending")

  const decision = decide(orch, {
    text: "按这个来",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  // 阶段 4B：「按这个来」已纳入确认语义，
  // 在 pendingPlan 上下文中视为确认当前 plan → planCommand
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
})
