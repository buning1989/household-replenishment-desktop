// 阶段 3B：pendingDraft 接入 turnInterpretation + focusResolver 路由测试
// 运行方式：node --test tests/agent-entry-pending-draft-routing.test.mjs
//
// 覆盖阶段 3B 核心行为要求：
//   1. pendingDraft + 新补货记录（不同物品）→ 新建 collection，不被 reviseDraft 吞掉
//   2. pendingDraft + 确认 → 仍走 draft handler（proposal）
//   3. pendingDraft + 取消 → 仍走 draft handler（cancelled）
//   4. pendingDraft + force_proposal（「确认吧」）→ 仍走 draft handler（proposal）
//   5. pendingDraft + pendingStatus（「现在什么情况」）→ 仍走 draft handler（answer）
//   6. pendingDraft + 查询 → 不执行 draft，不新建 collection
//   7. 无 pendingDraft + 新补货 → 仍正常新建 collection（回归）
//   8. supersedeOldPendingDraft 把旧 pending draft 标 superseded
//   9. pendingDraft + 「袋」类新补货 → 新建 collection（关键修复：不再被 REVISE_KEYWORDS 误判）

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
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { supersedeOldPendingDraft } = await import("../src/agent/conversationContext.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

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

/** 构造一个 pending RestockDraft（猫砂补货，字段已齐，待确认） */
function makePendingDraft(overrides = {}) {
  return {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 89,
    platform: "京东",
    restockDate: NOW,
    ...overrides
  }
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

test("3B-1: pendingDraft + 新补货记录（不同物品）→ 新建 collection，不被 reviseDraft 吞掉", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection", "应新建 collection，不是 proposal/answer")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "五常大米")
  assert.equal(fields.qty, 3)
  // 不应沿用旧 draft 的猫砂字段
  assert.notEqual(fields.itemName, "猫砂")
})

test("3B-2: pendingDraft + 确认 → 仍走 draft handler（proposal）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "proposal")
  assert.equal(decision.turn.executableDraft, pendingDraft, "应返回原 pendingDraft 作为 executableDraft")
})

test("3B-3: pendingDraft + 取消 → 仍走 draft handler（cancelled）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "取消",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "cancelled")
})

test("3B-4: pendingDraft + force_proposal（「确认吧」）→ 仍走 draft handler（proposal）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "确认吧",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  // force_proposal 在 pendingDraft 上下文中视为确认 → proposal（不是 collection）
  assert.equal(decision.turn.kind, "proposal")
  assert.equal(decision.turn.executableDraft, pendingDraft)
})

test("3B-5: pendingDraft + pendingStatus（「保存了吗」）→ 仍走 draft handler（answer）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "保存了吗",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")
  // 应提示当前待确认草稿
  assert.ok(
    decision.turn.message.length > 0,
    "pendingStatus 应返回非空 message"
  )
})

test("3B-6: pendingDraft + 查询 → 不执行 draft，不新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const catSand = makeItem("i1", "猫砂", "宠物用品")
  const tissue = makeItem("i2", "纸巾", "卫生间")
  const state = makeState({ items: [catSand, tissue] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "纸巾还能用多久",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  // 查询应走 needLm 或 answer，不应执行 draft 或新建 collection
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "collection", "查询不应新建 collection")
    assert.notEqual(decision.turn.kind, "proposal", "查询不应执行 draft 确认")
  } else {
    assert.equal(decision.kind, "needLlm")
  }
})

test("3B-7: 无 pendingDraft + 新补货 → 仍正常新建 collection（回归）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  const decision = decide(orch, {
    text: "刚买了 2 瓶洗衣液",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "洗衣液")
  assert.equal(fields.qty, 2)
})

test("3B-8: pendingDraft + 「刚买了两瓶洗衣液」→ 新建 collection（不同物品）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "刚买了两瓶洗衣液",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "洗衣液")
  assert.notEqual(fields.itemName, "猫砂")
})

test("3B-9: pendingDraft + 「昨天补了 10 卷纸」→ 新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "昨天补了 10 卷纸",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "纸")
  assert.equal(fields.qty, 10)
})

test("3B-10: supersedeOldPendingDraft 把旧 pending draft 标 superseded", () => {
  const messages = [
    { role: "user", content: "买猫砂", createdAt: 1 },
    { role: "assistant", content: "草稿", agentDraft: makePendingDraft(), draftStatus: "pending", createdAt: 2 }
  ]

  const result = supersedeOldPendingDraft(messages)

  assert.equal(result[1].draftStatus, "superseded")
  assert.equal(result[0].role, "user", "非 assistant 消息不变")
})

test("3B-11: supersedeOldPendingDraft 不影响已 confirmed/cancelled 的 draft", () => {
  const messages = [
    { role: "assistant", content: "草稿1", agentDraft: makePendingDraft(), draftStatus: "confirmed", createdAt: 1 },
    { role: "assistant", content: "草稿2", agentDraft: makePendingDraft(), draftStatus: "cancelled", createdAt: 2 },
    { role: "assistant", content: "草稿3", agentDraft: makePendingDraft(), draftStatus: "pending", createdAt: 3 }
  ]

  const result = supersedeOldPendingDraft(messages)

  assert.equal(result[0].draftStatus, "confirmed", "confirmed 不变")
  assert.equal(result[1].draftStatus, "cancelled", "cancelled 不变")
  assert.equal(result[2].draftStatus, "superseded", "只有 pending 被标 superseded")
})

test("3B-12: pendingDraft + 边界闲聊（「你是谁」）→ 本地回答，不走 draft", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft()

  const decision = decide(orch, {
    text: "你是谁",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  // 边界闲聊应本地回答，不执行 draft
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "proposal", "闲聊不应执行 draft 确认")
    assert.notEqual(decision.turn.kind, "collection", "闲聊不应新建 collection")
  }
})

test("3B-13: pendingDraft + reviseDraft（「改成 3 袋」）→ 仍走 draft handler 修订", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = makePendingDraft({ qty: 2 })

  const decision = decide(orch, {
    text: "改成 3 袋",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  // 「改成 3 袋」是对当前 draft 的修订，应走 draft handler 的 reviseDraft
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "proposal")
  const fields = restockFields(decision.turn.executableDraft)
  assert.equal(fields.qty, 3, "应修订为 3 袋")
})

test("3B-14: 不影响 pendingCollection 行为 — pendingCollection + 新补货仍走 start_new_collection", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  // 构造一个 pending collection（猫砂采集态）
  const pendingCollection = {
    draft: makePendingDraft(),
    missingSlots: [],
    qualityMissingSlots: [],
    createdAt: NOW
  }

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "五常大米")
})

test("3B-15: 不影响 pendingPlan 行为 — pendingPlan + 确认仍走 plan handler", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = createAgentPlan(
    [{ type: "createCategory", name: "清洁用品" }],
    "新建分类清洁用品",
    NOW
  )
  const pendingPlan = { ...plan, status: "pending" }

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
})
