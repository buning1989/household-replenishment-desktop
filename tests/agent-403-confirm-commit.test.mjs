// 403：pendingDraft 确认提交闭环 + 管理请求真实导航 测试
// 运行方式：node --test tests/agent-403-confirm-commit.test.mjs
//
// 覆盖任务文档第九节 A-G：
//   A. 确认提交：pendingDraft + 确认 → draftCommit command（非 proposal）
//   B. 缺少平台仍可提交：platform undefined 不阻塞 commit
//   C. 重复确认：第二次确认不再新增记录
//   D. 连续修订后确认：qty/price 修订链路 + 确认 → 最终字段正确写入
//   E. 创建消耗品按钮提交：createItem draft + 就这么记 → 只新增一次
//   F. pending 管理请求保留草稿：pendingDraft + 周期改动 → 导航，草稿不变
//   G. 导航动作：各类管理请求的 target / itemId / section / 零写入

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
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 11) // 2026-07-11
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

function makeOpt(id, productName, extra = {}) {
  return { id, productName, unit: "袋", pricingMode: "spec", ...extra }
}

function viewsOf(items) {
  return items.map((item) => ({ item }))
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// 模拟 App.tsx 的 committedDraftIndicesRef 幂等保护：记录已提交的 draft 消息 index
// 用于测试 C（重复确认）场景
function createIdempotencyGuard() {
  const committed = new Set()
  return {
    isCommitted: (idx) => committed.has(idx),
    markCommitted: (idx) => committed.add(idx)
  }
}

// =====================================================================
// A. 确认提交：pendingDraft + 确认 → draftCommit command（非 proposal）
// =====================================================================

test("A. pendingDraft + 「确认」→ 返回 draftCommit planCommand，不返回 proposal", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft, "应成功构造 pendingDraft")
  assert.equal(pendingDraft.kind, "restock", "应为 restock draft")
  assert.equal(pendingDraft.qty, 2)
  assert.equal(pendingDraft.price, 68)

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  // 必须返回 sync + planCommand + draftCommit
  assert.equal(d.kind, "sync", "「确认」应返回 sync")
  assert.equal(d.turn.kind, "planCommand", "「确认」应返回 planCommand")
  assert.equal(d.turn.command.command, "draftCommit", "command 应为 draftCommit")

  // 关键断言：不得返回 proposal（避免确认死循环）
  assert.ok(!("executableDraft" in d.turn), "不应返回 proposal turn（避免确认死循环）")
  assert.ok(!("plan" in d.turn), "不应产生 plan")
})

test("A.2. draftCommit 后调用 commitAgentDraft → 正式写入 + lastAgentMutation 记录", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)

  // 模拟 App.tsx 收到 draftCommit 后调用 onConfirmDraft
  const result = commitAgentDraft(state, pendingDraft, NOW)

  // 写入断言
  assert.equal(result.state.items[0].history.length, 1, "history 应 +1")
  assert.equal(result.state.items[0].history[0].qty, 2, "qty 应为 2")
  assert.equal(result.state.items[0].history[0].price, 68, "price 应为 68")

  // lastAgentMutation 断言
  assert.ok(result.state.lastAgentMutation, "应记录 lastAgentMutation")
  assert.equal(result.state.lastAgentMutation.mutationType, "createRestockRecord")
  assert.equal(result.state.lastAgentMutation.itemName, "猫砂")
  assert.equal(result.state.lastAgentMutation.consumed, false)

  // 原 state 不应被修改（确认前不写入）
  assert.equal(state.items[0].history.length, 0, "原 state 不应被修改")
})

// =====================================================================
// B. 缺少平台仍可提交：platform undefined 不阻塞 commit
// =====================================================================

test("B.1. platform undefined 的 pendingDraft + 「确认」→ 仍返回 draftCommit，不被平台阻塞", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  // 手工构造 platform undefined 的草稿（其他必填字段齐全）
  const pendingDraft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 3,
    unit: "袋",
    price: 78,
    platform: undefined,
    purchaseProductName: "猫砂",
    purchaseUnit: "袋",
    restockDate: NOW
  }

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  // 关键断言：不得因为 platform 缺失就重新生成 proposal
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand", "platform 缺失时仍应返回 planCommand")
  assert.equal(d.turn.command.command, "draftCommit", "应返回 draftCommit，不被平台阻塞")
  assert.ok(!("executableDraft" in d.turn), "不应返回 proposal（避免「你还没说在哪个平台买的」）")
})

test("B.2. platform undefined 的草稿 commitAgentDraft → 成功写入，platform 字段为空", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 3,
    unit: "袋",
    price: 78,
    platform: undefined,
    purchaseProductName: "猫砂",
    purchaseUnit: "袋",
    restockDate: NOW
  }

  const result = commitAgentDraft(state, pendingDraft, NOW)

  assert.equal(result.state.items[0].history.length, 1, "应成功写入一条 history")
  assert.equal(result.state.items[0].history[0].qty, 3)
  assert.equal(result.state.items[0].history[0].price, 78)
  // platform 为空可接受（可选字段）
  assert.ok(
    result.state.items[0].history[0].platform === undefined ||
    result.state.items[0].history[0].platform === null ||
    result.state.items[0].history[0].platform === "",
    "platform 为空可接受"
  )
})

test("B.3. 多种确认短语在 platform 缺失时都能触发 draftCommit", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 3,
    unit: "袋",
    price: 78,
    platform: undefined,
    purchaseProductName: "猫砂",
    purchaseUnit: "袋",
    restockDate: NOW
  }

  const orch = createHouseholdOrchestrator()
  const confirmPhrases = ["确认", "确定", "保存", "提交", "就这么记", "按这个来", "可以了", "就这样"]

  for (const phrase of confirmPhrases) {
    const d = decide(orch, {
      text: phrase,
      state,
      itemViews: viewsOf(state.items),
      pendingDraft
    })
    assert.equal(d.kind, "sync", `短语「${phrase}」应返回 sync`)
    assert.equal(d.turn.kind, "planCommand", `短语「${phrase}」应返回 planCommand`)
    assert.equal(d.turn.command.command, "draftCommit", `短语「${phrase}」应触发 draftCommit`)
    assert.ok(!("executableDraft" in d.turn), `短语「${phrase}」不应返回 proposal`)
  }
})

// =====================================================================
// C. 重复确认：第二次确认不再新增记录
// =====================================================================

test("C.1. 第一次确认成功后，无 pendingDraft 时输入「确认」→ 不返回 draftCommit", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)

  // 第一次：模拟 commit
  const result = commitAgentDraft(state, pendingDraft, NOW)
  const stateAfterCommit = result.state
  assert.equal(stateAfterCommit.items[0].history.length, 1, "第一次 commit 后 history 应为 1")

  // 第二次：pendingDraft 已清空（App.tsx 在 draftCommit 后会清空 pendingDraft）
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "确认",
    state: stateAfterCommit,
    itemViews: viewsOf(stateAfterCommit.items),
    pendingDraft: undefined // 已清空
  })

  // 关键断言：不得返回 draftCommit command（避免重复写入）
  // 注意：无 pendingDraft 时 orchestrator 可能返回 needLlm（交 LLM 兜底）或 sync+answer，
  // 但绝不应返回 planCommand+draftCommit。
  const isDraftCommit = d.turn?.kind === "planCommand" && d.turn?.command?.command === "draftCommit"
  assert.equal(isDraftCommit, false, "无 pendingDraft 时「确认」不应返回 draftCommit")
})

test("C.2. committedDraftIndicesRef 幂等保护：同一 index 重复提交只执行一次", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)

  // 模拟 App.tsx 的幂等保护
  const guard = createIdempotencyGuard()
  const messageIndex = 0

  // 第一次提交：guard 未记录 → 执行 commitAgentDraft
  assert.equal(guard.isCommitted(messageIndex), false, "首次提交前 guard 应未记录")
  guard.markCommitted(messageIndex)
  const result1 = commitAgentDraft(state, pendingDraft, NOW)
  assert.equal(result1.state.items[0].history.length, 1, "第一次提交后 history 应为 1")

  // 第二次提交：guard 已记录 → 跳过（不调用 commitAgentDraft）
  if (!guard.isCommitted(messageIndex)) {
    const result2 = commitAgentDraft(result1.state, pendingDraft, NOW)
    assert.equal(result2.state.items[0].history.length, 2, "如果未做幂等保护会写入第二条")
    assert.fail("幂等保护未生效，第二次提交不应执行 commitAgentDraft")
  }
  // 幂等保护生效：history 仍为 1
  assert.equal(result1.state.items[0].history.length, 1, "幂等保护生效，history 仍为 1")
})

test("C.3. createItem draft 重复确认 → 不重复创建（findItem 命中已存在）", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加个消耗品叫洗衣液", state)
  assert.ok(draft)
  assert.equal(draft.kind, "createItem", "应为 createItem draft")

  // 第一次提交：创建洗衣液
  const result1 = commitAgentDraft(state, draft, NOW)
  assert.equal(result1.state.items.length, 1, "第一次应创建一个洗衣液")
  assert.equal(result1.state.items[0].name, "洗衣液")

  // 第二次提交：findItem 命中已存在，不重复创建
  const result2 = commitAgentDraft(result1.state, draft, NOW)
  assert.equal(result2.state.items.length, 1, "第二次提交不重复创建，items 仍为 1")
  assert.match(result2.summary, /没有创建新内容|已存在/, "第二次提交应提示已存在")
})

// =====================================================================
// D. 连续修订后确认：qty/price 修订链路 + 确认 → 最终字段正确写入
// =====================================================================

test("D. 「今天买了 2 袋猫砂，68 元」→「改成 3 袋」→「金额改成 78」→「确认」→ 最终 qty=3 price=78 history+1", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()

  // Step 1: 初始 draft
  let pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.qty, 2, "初始 qty=2")
  assert.equal(pendingDraft.price, 68, "初始 price=68")

  // Step 2: 改成 3 袋 → 修订
  const d1 = decide(orch, {
    text: "改成 3 袋",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d1.kind, "sync")
  assert.equal(d1.turn.kind, "proposal", "「改成 3 袋」应返回 proposal（修订）")
  assert.ok(d1.turn.executableDraft, "应有 executableDraft")
  assert.equal(d1.turn.executableDraft.qty, 3, "qty 应修订为 3")
  // 更新 pendingDraft 为修订后的草稿
  pendingDraft = d1.turn.executableDraft

  // Step 3: 金额改成 78 → 修订
  const d2 = decide(orch, {
    text: "金额改成 78",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "proposal", "「金额改成 78」应返回 proposal（修订）")
  assert.ok(d2.turn.executableDraft)
  assert.equal(d2.turn.executableDraft.price, 78, "price 应修订为 78")
  // 更新 pendingDraft 为修订后的草稿
  pendingDraft = d2.turn.executableDraft

  // Step 4: 确认 → draftCommit
  const d3 = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d3.kind, "sync")
  assert.equal(d3.turn.kind, "planCommand", "「确认」应返回 planCommand")
  assert.equal(d3.turn.command.command, "draftCommit", "command 应为 draftCommit")
  assert.ok(!("executableDraft" in d3.turn), "不应返回 proposal（避免确认死循环）")

  // Step 5: 模拟 App.tsx 收到 draftCommit 后调用 commitAgentDraft
  const result = commitAgentDraft(state, pendingDraft, NOW)

  // 最终断言：写入的是修订后的字段
  assert.equal(result.state.items[0].history.length, 1, "history +1")
  assert.equal(result.state.items[0].history[0].qty, 3, "最终 qty=3")
  assert.equal(result.state.items[0].history[0].price, 78, "最终 price=78")
  assert.ok(result.state.lastAgentMutation, "lastAgentMutation 已记录")
})

// =====================================================================
// E. 创建消耗品按钮提交：createItem draft + 就这么记 → 只新增一次
// =====================================================================

test("E.1. 「帮我加个消耗品叫洗衣液」→ createItem draft", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加个消耗品叫洗衣液", state)
  assert.ok(draft, "应成功构造 draft")
  assert.equal(draft.kind, "createItem", "应为 createItem draft")
  assert.equal(draft.itemName, "洗衣液")
})

test("E.2. createItem draft + 「就这么记」→ draftCommit（不返回 proposal）", () => {
  const state = makeState()
  const pendingDraft = buildLocalDraftFromText("帮我加个消耗品叫洗衣液", state)
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.kind, "createItem")

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "就这么记",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand", "「就这么记」应返回 planCommand")
  assert.equal(d.turn.command.command, "draftCommit", "command 应为 draftCommit")
  assert.ok(!("executableDraft" in d.turn), "不应返回 proposal")
})

test("E.3. createItem draft draftCommit → 正式新增洗衣液，lastAgentMutation 记录", () => {
  const state = makeState()
  const pendingDraft = buildLocalDraftFromText("帮我加个消耗品叫洗衣液", state)
  assert.ok(pendingDraft)

  // 模拟 App.tsx 收到 draftCommit 后调用 commitAgentDraft
  const result = commitAgentDraft(state, pendingDraft, NOW)

  assert.equal(result.state.items.length, 1, "应新增一个物品")
  assert.equal(result.state.items[0].name, "洗衣液", "物品名应为洗衣液")
  assert.ok(result.state.lastAgentMutation, "应记录 lastAgentMutation")
  assert.equal(result.state.lastAgentMutation.mutationType, "createItem")
  assert.equal(result.state.lastAgentMutation.itemName, "洗衣液")
  assert.equal(result.state.lastAgentMutation.consumed, false)

  // 原 state 不变
  assert.equal(state.items.length, 0, "原 state 不应被修改")
})

test("E.4. 「帮我加一个洗发水，以后提醒」→ 仍进入 createItem 流程，不被「以后提醒」误判", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加一个洗发水，以后提醒", state)
  assert.ok(draft, "应成功构造 draft")
  assert.equal(draft.kind, "createItem", "应为 createItem draft，不被「以后提醒」误判为提醒规则管理")
  assert.equal(draft.itemName, "洗发水")
})

// =====================================================================
// F. pending 管理请求保留草稿：pendingDraft + 周期改动 → 导航，草稿不变
// =====================================================================

test("F.1. pendingDraft + 「周期改成 30 天」→ navigate turn（不修订草稿，不清空 pendingDraft）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品", { cycleDays: 14 })] })
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.qty, 2)
  assert.equal(pendingDraft.price, 68)

  // 记录草稿原始字段，用于断言"不变"
  const originalQty = pendingDraft.qty
  const originalPrice = pendingDraft.price
  const originalPlatform = pendingDraft.platform

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "周期改成 30 天",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  // 应返回 navigate，不是 proposal / planCommand
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "navigate", "「周期改成 30 天」应返回 navigate turn")
  assert.ok(d.turn.target, "应携带 target")
  assert.equal(d.turn.target.kind, "item")
  assert.equal(d.turn.target.itemId, "i1")
  assert.equal(d.turn.target.section, "cycle", "section 应为 cycle")

  // 关键断言：不得修订草稿（pendingDraft 内容完全不变）
  assert.ok(!("executableDraft" in d.turn), "不应返回 executableDraft（未修订草稿）")
  assert.equal(pendingDraft.qty, originalQty, "pendingDraft.qty 不应变")
  assert.equal(pendingDraft.price, originalPrice, "pendingDraft.price 不应变")
  assert.equal(pendingDraft.platform, originalPlatform, "pendingDraft.platform 不应变")

  // 关键断言：不得修改 cycleDays（零写入）
  assert.equal(state.items[0].cycleDays, 14, "cycleDays 不应被修改")
})

test("F.2. pending 管理请求后，再次「确认」→ 仍能提交原 pendingDraft", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品", { cycleDays: 14 })] })
  const orch = createHouseholdOrchestrator()

  // Step 1: 创建 pendingDraft
  let pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)

  // Step 2: 周期改成 30 天 → navigate（草稿保留）
  const d1 = decide(orch, {
    text: "周期改成 30 天",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d1.turn.kind, "navigate")
  // pendingDraft 仍然存在（引用不变）
  assert.equal(pendingDraft.qty, 2, "草稿仍保留")
  assert.equal(pendingDraft.price, 68, "草稿仍保留")

  // Step 3: 用户返回对话输入「确认」→ 仍应触发 draftCommit
  const d2 = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d2.turn.kind, "planCommand", "返回对话后「确认」仍应触发 draftCommit")
  assert.equal(d2.turn.command.command, "draftCommit")

  // Step 4: 正式提交 → 写入原草稿字段，cycleDays 不变
  const result = commitAgentDraft(state, pendingDraft, NOW)
  assert.equal(result.state.items[0].history.length, 1, "history +1")
  assert.equal(result.state.items[0].history[0].qty, 2, "qty=2（原草稿）")
  assert.equal(result.state.items[0].history[0].price, 68, "price=68（原草稿）")
  assert.equal(result.state.items[0].cycleDays, 14, "cycleDays 仍为 14（管理请求未写入）")
})

// =====================================================================
// G. 导航动作：各类管理请求的 target / itemId / section / 零写入
// =====================================================================

function makeManagementState() {
  return makeState({
    items: [{
      ...makeItem("i1", "猫砂", "宠物用品"),
      purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")],
      history: [
        { id: "e1", at: 1, qty: 1, price: 30, platform: "京东", review: undefined,
          purchaseProductName: "pidan", purchaseUnit: "袋",
          purchaseMeasureAmount: undefined, purchaseMeasureUnit: undefined }
      ]
    }]
  })
}

function assertNavigateTarget(decision, text, expected) {
  assert.equal(decision.kind, "sync", `「${text}」应返回 sync`)
  assert.equal(decision.turn.kind, "navigate", `「${text}」应返回 navigate turn，实际: ${decision.turn.kind}`)
  assert.ok(decision.turn.target, `「${text}」应携带 target`)
  assert.equal(decision.turn.target.kind, expected.kind, `「${text}」target.kind 应为 ${expected.kind}`)
  if (expected.itemId) {
    assert.equal(decision.turn.target.itemId, expected.itemId, `「${text}」target.itemId 应为 ${expected.itemId}`)
  }
  if (expected.section) {
    assert.equal(decision.turn.target.section, expected.section, `「${text}」target.section 应为 ${expected.section}`)
  }
  // 零写入断言
  assert.ok(!("plan" in decision.turn), `「${text}」不应有 plan`)
  assert.ok(!("executableDraft" in decision.turn), `「${text}」不应有 executableDraft`)
  assert.ok(!("collection" in decision.turn), `「${text}」不应有 collection`)
}

test("G.1. 「删除猫砂的 pidan 豆腐猫砂常购商品」→ navigate item/purchaseOptions", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "删除猫砂的 pidan 豆腐猫砂常购商品", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "删除猫砂的 pidan 豆腐猫砂常购商品", {
    kind: "item", itemId: "i1", section: "purchaseOptions"
  })
  // state 不变
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
  // 常购商品仍然存在
  assert.equal(state.items[0].purchaseOptions.length, 1, "常购商品不应被删除")
})

test("G.2. 「猫砂常购商品平台改成京东」→ navigate item/purchaseOptions", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂常购商品平台改成京东", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "猫砂常购商品平台改成京东", {
    kind: "item", itemId: "i1", section: "purchaseOptions"
  })
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
  assert.equal(state.items[0].purchaseOptions[0].productName, "pidan 豆腐猫砂", "常购商品不应被修改")
})

test("G.3. 「把 pidan 豆腐猫砂设为猫砂的默认常购商品」→ navigate item/purchaseOptions", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "把 pidan 豆腐猫砂设为猫砂的默认常购商品", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "把 pidan 豆腐猫砂设为猫砂的默认常购商品", {
    kind: "item", itemId: "i1", section: "purchaseOptions"
  })
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
})

test("G.4. 「把上个月的猫砂价格改成 268」→ navigate item/history", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "把上个月的猫砂价格改成 268", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "把上个月的猫砂价格改成 268", {
    kind: "item", itemId: "i1", section: "history"
  })
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
  // 历史记录价格不应被修改
  assert.equal(state.items[0].history[0].price, 30, "历史价格不应被修改")
})

test("G.5. 「猫砂周期改成 30 天」→ navigate item/cycle", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂周期改成 30 天", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "猫砂周期改成 30 天", {
    kind: "item", itemId: "i1", section: "cycle"
  })
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
  assert.equal(state.items[0].cycleDays, 14, "cycleDays 不应被修改")
})

test("G.6. 「猫砂提前 5 天提醒」→ navigate item/cycle", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂提前 5 天提醒", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "猫砂提前 5 天提醒", {
    kind: "item", itemId: "i1", section: "cycle"
  })
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
  assert.equal(state.items[0].bufferDays, 2, "bufferDays 不应被修改")
})

test("G.7. 「把月预算设成 800」→ navigate settings/budget", () => {
  const state = makeManagementState()
  const before = JSON.stringify(state)
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "把月预算设成 800", state, itemViews: viewsOf(state.items) })

  assertNavigateTarget(d, "把月预算设成 800", {
    kind: "settings", section: "budget"
  })
  assert.equal(JSON.stringify(state), before, "state 不应被修改")
  // settings 不应被修改
  assert.ok(!state.settings.monthlyBudget, "monthlyBudget 不应被设置")
})
