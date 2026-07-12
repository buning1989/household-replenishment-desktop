// 阶段 3C：pendingBatch 接入 turnInterpretation + focusResolver 路由测试
// 运行方式：node --test tests/agent-entry-pending-batch-routing.test.mjs
//
// 覆盖阶段 3C 核心行为要求：
//   1. pendingBatch + 新补货记录（不同物品）→ 新建 collection，不被 batch handler 吞掉
//   2. pendingBatch + 确认类输入 → 仍走 batch handler（planCommand batchConfirm）
//   3. pendingBatch + 取消类输入 → 仍走 batch handler（planCommand batchCancel）
//   4. pendingBatch + 修订类输入 → 仍走 batch handler（planCommand batchReviseAll/batchReviseIndex）
//   5. pendingBatch + 查询 → 不执行 batch，不新建 collection
//   6. 无 pendingBatch + 新补货 → 仍正常新建 collection（回归）
//   7. supersedeOldPendingBatch 把旧 pending batch 标 superseded
//   8. 不影响 pendingCollection / pendingPlan / pendingDraft 已通过行为
//   9. trace 中 llmInterpreter.called 规则不回退（本地高置信 called=false）

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
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")
const { supersedeOldPendingBatch } = await import("../src/agent/conversationContext.ts")
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

/** 构造一个 pending batch（订单导入后的多条草稿） */
function makePendingBatch() {
  return [
    {
      kind: "restock",
      itemId: "i1",
      itemName: "猫砂",
      qty: 2,
      unit: "袋",
      price: 89,
      platform: "京东",
      restockDate: NOW
    },
    {
      kind: "restock",
      itemId: "i2",
      itemName: "猫粮",
      qty: 1,
      unit: "袋",
      price: 120,
      platform: "淘宝",
      restockDate: NOW
    }
  ]
}

/** 从 AgentDraft 统一取出补货字段 */
function restockFields(draft) {
  if (draft.kind === "restock") {
    return { itemName: draft.itemName, qty: draft.qty, platform: draft.platform }
  }
  if (draft.kind === "createItemWithRestock") {
    return { itemName: draft.item.itemName, qty: draft.restock.qty, platform: draft.restock.platform }
  }
  return { itemName: undefined, qty: undefined, platform: undefined }
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// ---------- 1. pendingBatch + 新补货记录 → 新建 collection ----------

test("3C-1: pendingBatch + 「今天买了 3 袋五常大米」→ 新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品"), makeItem("i2", "猫粮", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection", "应新建 collection，不是 planCommand")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "五常大米")
  assert.equal(fields.qty, 3)
})

test("3C-2: pendingBatch + 「刚买了两瓶洗衣液」→ 新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "刚买了两瓶洗衣液",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "洗衣液")
})

test("3C-3: pendingBatch + 「昨天补了 10 卷纸」→ 新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "昨天补了 10 卷纸",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const fields = restockFields(decision.turn.collection.draft)
  assert.equal(fields.itemName, "纸")
  assert.equal(fields.qty, 10)
})

// ---------- 2. pendingBatch + 确认类输入 → 仍走 batch handler ----------

test("3C-4: pendingBatch + 「全部确认」→ 仍走 batch handler（planCommand batchConfirm）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "全部确认",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "batchConfirm")
})

test("3C-5: pendingBatch + 「都确认」→ 仍走 batch handler（planCommand batchConfirm）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "都确认",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "batchConfirm")
})

// ---------- 3. pendingBatch + 取消类输入 → 仍走 batch handler ----------

test("3C-6: pendingBatch + 「全部取消」→ 仍走 batch handler（planCommand batchCancel）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "全部取消",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "batchCancel")
})

// ---------- 4. pendingBatch + 修订类输入 → 仍走 batch handler ----------

test("3C-7: pendingBatch + 「价格都改成 59.9」→ 仍走 batch handler（planCommand batchReviseAll）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "价格都改成 59.9",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "batchReviseAll")
})

test("3C-8: pendingBatch + 「第一个跳过」→ 仍走 batch handler（planCommand batchCancelIndex）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "第一个跳过",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "batchCancelIndex")
  assert.equal(decision.turn.command.index, 0)
})

// ---------- 5. pendingBatch + 查询 → 不执行 batch，不新建 collection ----------

test("3C-9: pendingBatch + 查询 → 不执行 batch，不新建 collection", () => {
  const orch = createHouseholdOrchestrator()
  const catSand = makeItem("i1", "猫砂", "宠物用品")
  const tissue = makeItem("i2", "纸巾", "卫生间")
  const state = makeState({ items: [catSand, tissue] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "纸巾还能用多久",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  // 查询应走 needLm 或 answer，不应执行 batch 或新建 collection
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "collection", "查询不应新建 collection")
    assert.notEqual(decision.turn.kind, "planCommand", "查询不应执行 batch 命令")
  } else {
    assert.equal(decision.kind, "needLlm")
  }
})

// ---------- 6. 无 pendingBatch + 新补货 → 仍正常新建 collection（回归） ----------

test("3C-10: 无 pendingBatch + 新补货 → 仍正常新建 collection（回归）", () => {
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

// ---------- 7. supersedeOldPendingBatch ----------

test("3C-11: supersedeOldPendingBatch 把旧 pending batch 标 superseded", () => {
  const messages = [
    { role: "user", content: "导入订单", createdAt: 1 },
    {
      role: "assistant",
      content: "批量草稿",
      agentDraftBatch: makePendingBatch(),
      batchDraftStatuses: ["pending", "pending"],
      createdAt: 2
    }
  ]

  const result = supersedeOldPendingBatch(messages)

  assert.deepEqual(result[1].batchDraftStatuses, ["superseded", "superseded"])
  assert.equal(result[0].role, "user", "非 assistant 消息不变")
})

test("3C-12: supersedeOldPendingBatch 不影响已 confirmed/cancelled 的 batch", () => {
  const messages = [
    {
      role: "assistant",
      content: "草稿1",
      agentDraftBatch: makePendingBatch(),
      batchDraftStatuses: ["confirmed", "cancelled"],
      createdAt: 1
    },
    {
      role: "assistant",
      content: "草稿2",
      agentDraftBatch: makePendingBatch(),
      batchDraftStatuses: ["pending", "pending"],
      createdAt: 2
    }
  ]

  const result = supersedeOldPendingBatch(messages)

  assert.deepEqual(result[0].batchDraftStatuses, ["confirmed", "cancelled"], "已确认/取消的不变")
  assert.deepEqual(result[1].batchDraftStatuses, ["superseded", "superseded"], "只有 pending 被标 superseded")
})

test("3C-13: supersedeOldPendingBatch 部分已确认的 batch 只标 pending 项", () => {
  const messages = [
    {
      role: "assistant",
      content: "草稿",
      agentDraftBatch: makePendingBatch(),
      batchDraftStatuses: ["confirmed", "pending"],
      createdAt: 1
    }
  ]

  const result = supersedeOldPendingBatch(messages)

  assert.deepEqual(result[0].batchDraftStatuses, ["confirmed", "superseded"], "只标 pending 项，不影响 confirmed")
})

// ---------- 8. 不影响 pendingCollection / pendingPlan / pendingDraft ----------

test("3C-14: pendingCollection + 新补货仍走 start_new_collection（回归）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingCollection = {
    draft: {
      kind: "restock",
      itemId: "i1",
      itemName: "猫砂",
      qty: 2,
      unit: "袋",
      price: 89,
      platform: "京东",
      restockDate: NOW
    },
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

test("3C-15: pendingDraft + 确认仍走 draft handler（回归）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 89,
    platform: "京东",
    restockDate: NOW
  }

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "draftCommit")
})

test("3C-16: pendingPlan + 确认仍走 plan handler（回归）", async () => {
  const { createAgentPlan } = await import("../src/agent/actions.ts")
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

// ---------- 9. trace llmInterpreter.called 规则不回退 ----------

test("3C-17: pendingBatch + 新补货记录 → llmInterpreter.called=false（本地高置信）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })
  const pendingBatch = makePendingBatch()
  const trace = createTrace("今天买了 3 袋五常大米", {})

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  assert.equal(decision.kind, "sync")
  assert.ok(trace.llmInterpreter, "llmInterpreter 应存在")
  assert.equal(trace.llmInterpreter.called, false, "本地高置信 called=false")
  assert.equal(trace.llmInterpreter.skipReason, "local_high_confidence")
})

test("3C-18: pendingBatch + 确认 → llmInterpreter.called=false, interceptedByRule=true（不冲突）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()
  const trace = createTrace("全部确认", {})

  const decision = decide(orch, {
    text: "全部确认",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  assert.equal(decision.kind, "sync")
  assert.equal(trace.llmInterpreter.called, false, "本地高置信 called=false")
  assert.equal(trace.routeDecision.interceptedByRule, true, "interceptedByRule=true")
  // 二者不冲突
  assert.ok(
    !trace.llmInterpreter.called && trace.routeDecision.interceptedByRule,
    "called=false 和 interceptedByRule=true 可同时成立"
  )
})

// ---------- 10. 边界闲聊 ----------

test("3C-19: pendingBatch + 「你是谁」→ 本地回答，不走 batch", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()

  const decision = decide(orch, {
    text: "你是谁",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch
  })

  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "planCommand", "闲聊不应执行 batch 命令")
    assert.notEqual(decision.turn.kind, "collection", "闲聊不应新建 collection")
  }
})

// ---------- 11. force_proposal 回归测试（阶段 3C checkpoint） ----------
// 重点确认：focusResolver 返回 continue_pending_batch 后，不应出现 handler 空转
// 导致用户无响应或错误落入其他路径。
//
// 当前行为梳理（基于 intent.ts + draftCollection.ts 的实际规则）：
//   - 「就这样」：isForceProposalSignal 命中 /就这样/ → force_proposal
//     → focusResolver 返回 continue_pending_batch
//     → handleBatchIntent → classifyBatchIntent → isBatchConfirmMatch 命中 "就这样" → batchConfirm
//   - 「可以了」：isForceProposalSignal 命中 /可以了$/ → force_proposal
//     → focusResolver 返回 continue_pending_batch
//     → handleBatchIntent → classifyBatchIntent → isBatchConfirmMatch 命中 "可以了" → batchConfirm
//   - 「按这个来」：不在 FORCE_PROPOSAL_PATTERNS，不在 CONFIRM_EXPLICIT_PHRASES，
//     也不在 CONFIRM_CASUAL_PHRASES → interpretUserTurn 不判为 force_proposal 也不判为 confirm_current_task
//     → focusResolver 不会返回 continue_pending_batch
//     → 落到 route_to_llm 或其他路径（当前行为，不强行改业务逻辑）

test("3C-20: pendingBatch + 「就这样」→ 走 batch handler，不空转", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()
  const trace = createTrace("就这样", {})

  const decision = decide(orch, {
    text: "就这样",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  // 「就这样」命中 force_proposal → continue_pending_batch → batchConfirm
  assert.equal(decision.kind, "sync", "应返回 sync，不应空转或 needLlm")
  assert.equal(decision.turn.kind, "planCommand", "应走 batch handler")
  assert.equal(decision.turn.command.command, "batchConfirm")
  // focusResolver 路径可追溯
  assert.equal(trace.firstFocusDecision?.focus, "continue_pending_batch")
  assert.equal(trace.routeDecision?.handler, "pendingBatch")
})

test("3C-21: pendingBatch + 「可以了」→ 走 batch handler，不空转", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()
  const trace = createTrace("可以了", {})

  const decision = decide(orch, {
    text: "可以了",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  // 「可以了」命中 force_proposal → continue_pending_batch → batchConfirm
  assert.equal(decision.kind, "sync", "应返回 sync，不应空转或 needLlm")
  assert.equal(decision.turn.kind, "planCommand", "应走 batch handler")
  assert.equal(decision.turn.command.command, "batchConfirm")
  assert.equal(trace.firstFocusDecision?.focus, "continue_pending_batch")
})

test("3C-22: pendingBatch + 「按这个来」→ 走 batch handler（batchConfirm）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()
  const trace = createTrace("按这个来", {})

  const decision = decide(orch, {
    text: "按这个来",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  // 阶段 4B：「按这个来」已纳入确认语义（与「就这样」「可以了」一致），
  //   - isForceProposalSignal 命中 /按这个来/ → force_proposal
  //   - focusResolver 返回 continue_pending_batch
  //   - classifyBatchIntent → isBatchConfirmMatch 命中 "按这个来" → batchConfirm
  assert.equal(decision.kind, "sync", "应返回 sync，不应空转或 needLlm")
  assert.equal(decision.turn.kind, "planCommand", "应走 batch handler")
  assert.equal(decision.turn.command.command, "batchConfirm")
  assert.equal(trace.firstFocusDecision?.focus, "continue_pending_batch")
})

test("3C-23: pendingBatch + 「就按这个来」→ 走 batch handler（batchConfirm）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingBatch = makePendingBatch()
  const trace = createTrace("就按这个来", {})

  const decision = decide(orch, {
    text: "就按这个来",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  // 「就按这个来」包含「按这个来」→ 命中 /按这个来/ 和 "按这个来"
  assert.equal(decision.kind, "sync", "应返回 sync")
  assert.equal(decision.turn.kind, "planCommand", "应走 batch handler")
  assert.equal(decision.turn.command.command, "batchConfirm")
  assert.equal(trace.firstFocusDecision?.focus, "continue_pending_batch")
})

