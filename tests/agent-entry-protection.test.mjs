// 阶段 0：Agent 决策入口重构保护测试
// 运行方式：node --test tests/agent-entry-protection.test.mjs
//
// 目的：在重构 decideSync 入口（阶段 2 接入 interpretUserTurn + focusResolver）之前，
// 锁定当前必须保持不回退的关键行为。本文件不改任何现有逻辑，只做行为快照。
//
// 覆盖的「不可回退」行为：
//   1. 首轮新补货（已知物品）→ collection，不直接 proposal
//   2. 短句平台续接 → continue collection，platform 更新
//   3. 短句价格续接（平台已补）→ readyToConfirm 转 proposal
//   4. 短句评价续接（不起灰）→ review 保留原文
//   5. 显式修正「不是 X，是 Y」→ 当前 collection itemName 更新为 Y
//   6. 取消信号 → cancelled，不写入
//   7. 强制保存「就这样」→ proposal，带「未补全」标记
//   8. 查询类输入 → 不生成补货 collection / proposal
//   9. 删除请求 → planProposal（高风险，需二次确认）
//   10. 删除二次确认状态机：确认→awaitingSecondConfirm；awaiting+确认→answer（不执行）；
//       awaiting+确认删除→planSecondConfirm
//   11. awaitingSecondConfirm 下输入新补货句 → 不执行删除（无 planSecondConfirm/planConfirm）
//   12. 预算设置 → planProposal
//
// 注意：「串物品」bug 场景（pendingCollection=宠物擦脚湿巾 + 输入「今天买了 3 袋五常大米」
//   被误改成旧物品 3 袋）不属于保护范围——那是阶段 2 要修复的目标，故此处不覆盖。

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
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

// 固定日期上下文，避免「今天/昨天」随运行时间漂移
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

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// ---------- 1. 首轮新补货（已知物品）→ collection ----------

test("1. 首轮「今天买了 5 袋猫砂」→ collection，不直接 proposal", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf(state.items) })
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "collection", "应返回 collection 采集态")
  assert.equal(d.turn.collection.draft.itemName, "猫砂")
  assert.equal(d.turn.collection.draft.qty, 5)
  assert.equal(d.turn.collection.draft.unit, "袋")
})

// ---------- 2. 短句平台续接 ----------

test("2. pendingCollection + 「拼多多」→ continue collection，platform=拼多多", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d1 = decide(orch, { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf(state.items) })
  assert.equal(d1.turn.kind, "collection")
  const pendingCollection = d1.turn.collection

  const d2 = decide(orch, { text: "拼多多", state, itemViews: viewsOf(state.items), pendingCollection })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "collection", "补平台后仍应是 collection（price 仍缺）")
  assert.equal(d2.turn.collection.draft.platform, "拼多多")
})

// ---------- 3. 短句价格续接（平台已补）→ readyToConfirm 转 proposal ----------

test("3. pendingCollection + 平台后 + 「128」→ proposal，price=128", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d1 = decide(orch, { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf(state.items) })
  const c1 = d1.turn.collection
  const d2 = decide(orch, { text: "拼多多", state, itemViews: viewsOf(state.items), pendingCollection: c1 })
  const c2 = d2.turn.kind === "collection" ? d2.turn.collection : c1

  const d3 = decide(orch, { text: "128", state, itemViews: viewsOf(state.items), pendingCollection: c2 })
  assert.equal(d3.kind, "sync")
  assert.equal(d3.turn.kind, "proposal", "补齐 price 后应转 proposal")
  assert.equal(d3.turn.executableDraft.price, 128)
  assert.equal(d3.turn.executableDraft.platform, "拼多多")
})

// ---------- 4. 短句评价续接（不起灰）→ review 保留原文 ----------

test("4. pendingCollection + 「不起灰」→ review=不起灰（保留原文，不压缩成「好用」）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d1 = decide(orch, { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf(state.items) })
  const pendingCollection = d1.turn.collection

  const d2 = decide(orch, { text: "不起灰", state, itemViews: viewsOf(state.items), pendingCollection })
  assert.equal(d2.kind, "sync")
  assert.ok(
    d2.turn.kind === "collection" || d2.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d2.turn.kind}`
  )
  const draft = d2.turn.kind === "collection" ? d2.turn.collection.draft : d2.turn.executableDraft
  assert.equal(draft.review, "不起灰")
})

// ---------- 5. 显式修正「不是 X，是 Y」→ itemName 更新为 Y ----------

test("5. pendingCollection=宠物擦脚湿巾 + 「不是宠物擦脚湿巾，是五常大米」→ itemName=五常大米", () => {
  // state 中没有「宠物擦脚湿巾」物品 → 首轮会创建 createItemWithRestock 采集态
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const d1 = decide(orch, { text: "今天买了 5 包宠物擦脚湿巾", state, itemViews: [] })
  assert.equal(d1.turn.kind, "collection")
  const pendingCollection = d1.turn.collection
  const prevItemName =
    pendingCollection.draft.kind === "createItemWithRestock"
      ? pendingCollection.draft.item.itemName
      : pendingCollection.draft.itemName
  assert.equal(prevItemName, "宠物擦脚湿巾")

  const d2 = decide(orch, {
    text: "不是宠物擦脚湿巾，是五常大米",
    state,
    itemViews: [],
    pendingCollection
  })
  assert.equal(d2.kind, "sync")
  assert.ok(
    d2.turn.kind === "collection" || d2.turn.kind === "proposal",
    `修正后应仍在采集态或转 proposal, 实际: ${d2.turn.kind}`
  )
  const draft = d2.turn.kind === "collection" ? d2.turn.collection.draft : d2.turn.executableDraft
  const nextItemName = draft.kind === "createItemWithRestock" ? draft.item.itemName : draft.itemName
  assert.equal(nextItemName, "五常大米", "显式修正应把 itemName 更新为五常大米")
  assert.notEqual(nextItemName, "宠物擦脚湿巾", "修正后不应仍是宠物擦脚湿巾")
})

// ---------- 6. 取消信号 → cancelled ----------

test("6. pendingCollection + 「算了」→ cancelled，无 executableDraft", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d1 = decide(orch, { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf(state.items) })
  const pendingCollection = d1.turn.collection

  const d2 = decide(orch, { text: "算了", state, itemViews: viewsOf(state.items), pendingCollection })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "cancelled")
  assert.ok(!d2.turn.executableDraft, "cancelled 不应有 executableDraft")
})

// ---------- 7. 强制保存「就这样」→ proposal 带「未补全」 ----------

test("7. pendingCollection（缺 price）+ 「就这样」→ proposal，message 含「未补全」", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d1 = decide(orch, { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf(state.items) })
  const pendingCollection = d1.turn.collection

  const d2 = decide(orch, { text: "就这样", state, itemViews: viewsOf(state.items), pendingCollection })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "proposal", "「就这样」应触发 forceProposal 转 proposal")
  assert.ok(d2.turn.message.includes("未补全"), `应含「未补全」, 实际：${d2.turn.message}`)
})

// ---------- 8. 查询类输入 → 不生成补货 collection / proposal ----------

test("8. 「猫砂还能用多久」→ 不生成 collection / proposal / clarification", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂还能用多久", state, itemViews: viewsOf(state.items) })
  // 当前行为：boundary 命中 adjacentHomeLife → needLlm（LLM 负责回答）
  // 关键保护：不产生任何写入类 turn
  if (d.kind === "sync") {
    assert.ok(
      d.turn.kind === "answer",
      `查询不应生成写入类 turn, 实际: ${d.turn.kind}`
    )
  } else {
    assert.equal(d.kind, "needLlm", `期望 needLlm 或 sync answer, 实际: ${d.kind}`)
  }
})

// ---------- 9. 删除请求 → planProposal（高风险） ----------

test("9. 「删除卫生间下的消耗品」→ planProposal，risk=high，requiresSecondConfirm=true", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸", "卫生间"),
      makeItem("i2", "洁厕液", "卫生间")
    ]
  })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "删除卫生间下的消耗品", state, itemViews: viewsOf(state.items) })
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planProposal", "删除请求应生成 planProposal，不能直接执行")
  assert.equal(d.turn.plan.risk, "high")
  assert.equal(d.turn.plan.requiresSecondConfirm, true)
  assert.equal(d.turn.plan.status, "pending")
  // 应包含 deleteItem 动作
  assert.ok(
    d.turn.plan.actions.some((a) => a.type === "deleteItem"),
    "应包含 deleteItem 动作"
  )
})

// ---------- 10. 删除二次确认状态机 ----------

test("10. 删除二次确认：确认→awaitingSecondConfirm；awaiting+确认→answer；awaiting+确认删除→planSecondConfirm", () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸", "卫生间")]
  })
  const orch = createHouseholdOrchestrator()
  const itemViews = viewsOf(state.items)

  // 10a. 首轮生成 high-risk plan
  const d1 = decide(orch, { text: "删除卫生间下的消耗品", state, itemViews })
  assert.equal(d1.turn.kind, "planProposal")
  const pendingPlan = d1.turn.plan

  // 10b. pending 状态 + 「确认」→ planAwaitingSecondConfirm（不执行写入）
  const d2 = decide(orch, { text: "确认", state, itemViews, pendingPlan })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "planCommand")
  assert.equal(d2.turn.command.command, "planAwaitingSecondConfirm")

  // 10c. awaitingSecondConfirm + 「确认」→ answer（提示需说「确认删除」），不执行
  const awaitingPlan = { ...pendingPlan, status: "awaitingSecondConfirm" }
  const d3 = decide(orch, { text: "确认", state, itemViews, pendingPlan: awaitingPlan })
  assert.equal(d3.kind, "sync")
  assert.equal(d3.turn.kind, "answer", "普通「确认」不应执行高风险删除")
  assert.ok(
    !/planSecondConfirm|planConfirm/.test(JSON.stringify(d3.turn)),
    "不应产出 planSecondConfirm / planConfirm"
  )

  // 10d. awaitingSecondConfirm + 「确认删除」→ planSecondConfirm（执行）
  const d4 = decide(orch, { text: "确认删除", state, itemViews, pendingPlan: awaitingPlan })
  assert.equal(d4.kind, "sync")
  assert.equal(d4.turn.kind, "planCommand")
  assert.equal(d4.turn.command.command, "planSecondConfirm")
})

// ---------- 11. awaitingSecondConfirm 下新补货句不执行删除 ----------

test("11. awaitingSecondConfirm + 「今天买了 3 袋五常大米」→ 不执行删除（无 planSecondConfirm/planConfirm）", () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸", "卫生间")]
  })
  const orch = createHouseholdOrchestrator()
  const itemViews = viewsOf(state.items)

  const d1 = decide(orch, { text: "删除卫生间下的消耗品", state, itemViews })
  const awaitingPlan = { ...d1.turn.plan, status: "awaitingSecondConfirm" }

  const d2 = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews,
    pendingPlan: awaitingPlan
  })
  assert.equal(d2.kind, "sync")
  // 关键保护：不产出 planSecondConfirm / planConfirm（删除未被误执行）
  if (d2.turn.kind === "planCommand") {
    assert.ok(
      d2.turn.command.command !== "planSecondConfirm" && d2.turn.command.command !== "planConfirm",
      `awaitingSecondConfirm 下新补货句不应执行删除, 实际 command: ${d2.turn.command.command}`
    )
  }
})

// ---------- 12. 预算设置 → planProposal ----------

test("12. 「把月预算设成 800」→ planProposal，含 setMonthlyBudget 动作", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "把月预算设成 800", state, itemViews: [] })
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planProposal")
  const budgetAction = d.turn.plan.actions.find((a) => a.type === "setMonthlyBudget")
  assert.ok(budgetAction, "应包含 setMonthlyBudget 动作")
  assert.equal(budgetAction.amount, 800)
})
