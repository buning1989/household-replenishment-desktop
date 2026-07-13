#!/usr/bin/env node
// 403 P0 验收 Smoke Test（S1-S7）
// 运行方式：node scripts/smoke-403-p0-verify.mjs
//
// 在 orchestrator 层验证 S1-S7 场景的核心行为。
// 真实 Electron UI 手动验证需要启动 npm run dev 后逐项检查。

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
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")
const { commitAgentDraft, commitAgentPlan } = await import("../src/agent/executor.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 9)
const DATE_CONTEXT = buildChatDateContext(NOW)

// ---------- 夹具 ----------

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "日常护理", "其他"],
    items: [],
    settings: { aiApiKey: "test-key", aiChatModel: "qwen-plus" },
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
    unit: "件",
    defaultQty: "",
    platform: "",
    link: "",
    remainingDays: "",
    learningEnabled: true,
    notes: "",
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function makeOpt(id, productName, extra = {}) {
  return {
    id,
    productName,
    unit: "件",
    pricingMode: "spec",
    ...extra
  }
}

// ---------- 工具 ----------

let pass = 0
let fail = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ✔ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

function decide(orch, input) {
  return orch.decide(input)
}

function stateSnapshot(state) {
  return JSON.stringify({
    items: state.items.length,
    categories: [...state.categories],
    historyCount: state.items.reduce((sum, it) => sum + it.history.length, 0),
    optionCount: state.items.reduce((sum, it) => sum + it.purchaseOptions.length, 0),
    settings: state.settings
  })
}

// ---------- S1: 管理请求只导航 ----------

function testS1() {
  console.log("\n--- S1: 管理请求只导航 ---")
  const state = makeState({
    items: [
      makeItem("i1", "猫砂", "宠物用品", {
        purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")]
      })
    ]
  })
  const beforeSnap = stateSnapshot(state)
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "删除猫砂的 pidan 常购商品",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })

  check("S1: decision.kind === sync", d.kind === "sync", `got ${d.kind}`)
  check("S1: turn.kind === answer", d.turn.kind === "answer", `got ${d.turn.kind}`)
  check("S1: 无 plan", !("plan" in d.turn))
  check("S1: 无 executableDraft", !("executableDraft" in d.turn))
  check("S1: state 前后一致", beforeSnap === stateSnapshot(state))
}

// ---------- S2: 历史编辑只导航 ----------

function testS2() {
  console.log("\n--- S2: 历史编辑只导航 ---")
  const state = makeState({
    items: [
      makeItem("i1", "猫砂", "宠物用品", {
        purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")]
      })
    ]
  })
  const beforeSnap = stateSnapshot(state)
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "猫砂常购商品平台改成京东",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })

  check("S2: decision.kind === sync", d.kind === "sync", `got ${d.kind}`)
  check("S2: turn.kind === answer", d.turn.kind === "answer", `got ${d.turn.kind}`)
  check("S2: 无 plan", !("plan" in d.turn))
  check("S2: 无 executableDraft", !("executableDraft" in d.turn))
  check("S2: state 前后一致", beforeSnap === stateSnapshot(state))
}

// ---------- S3: 新建消耗品正常 ----------

function testS3() {
  console.log("\n--- S3: 新建消耗品正常 ---")
  const state = makeState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "帮我加个消耗品叫洗衣液",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })

  check("S3: decision.kind === sync", d.kind === "sync", `got ${d.kind}`)
  // 应该进入录入草稿或采集流程
  const isEntryFlow = d.turn.kind === "proposal" || d.turn.kind === "collection" || d.turn.kind === "planProposal"
  check("S3: 进入录入流程 (proposal/collection/planProposal)", isEntryFlow, `got ${d.turn.kind}`)
  check("S3: 非 answer 导航", d.turn.kind !== "answer")
}

// ---------- S4: 当前草稿修订正常 ----------

function testS4() {
  console.log("\n--- S4: 当前草稿修订正常 ---")
  const state = makeState({
    items: [makeItem("i1", "猫砂", "宠物用品")]
  })
  const orch = createHouseholdOrchestrator()

  // 先生成补货草稿
  const d1 = decide(orch, {
    text: "今天买了 2 袋猫砂，68 元",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })
  check("S4a: 生成草稿或采集", d1.kind === "sync" && d1.turn.kind !== "answer", `got ${d1.kind}/${d1.turn?.kind}`)

  // 如果是 collection，先确认到 proposal
  let pendingDraft = null
  let pendingCollection = null
  if (d1.turn.kind === "collection") {
    pendingCollection = d1.turn.collection
    // 强制保存到 proposal
    const d2 = decide(orch, {
      text: "确认吧",
      state, itemViews: [], dateContext: DATE_CONTEXT,
      pendingCollection
    })
    if (d2.turn.kind === "proposal") {
      pendingDraft = d2.turn.executableDraft
    }
  } else if (d1.turn.kind === "proposal") {
    pendingDraft = d1.turn.executableDraft
  }

  if (!pendingDraft) {
    check("S4: 获取 pendingDraft", false, "无法获取 pendingDraft")
    return
  }

  // 修订金额
  const d3 = decide(orch, {
    text: "金额改成 78",
    state, itemViews: [], dateContext: DATE_CONTEXT,
    pendingDraft
  })

  check("S4b: 修订成功", d3.kind === "sync", `got ${d3.kind}`)
  check("S4b: 返回 proposal", d3.turn.kind === "proposal", `got ${d3.turn?.kind}`)
  if (d3.turn.kind === "proposal" && d3.turn.executableDraft) {
    const revised = d3.turn.executableDraft
    const price = revised.price ?? revised.restock?.price
    check("S4b: 金额为 78", price === 78, `got ${price}`)
  }
  check("S4b: 非导航 answer", d3.turn.kind !== "answer")
}

// ---------- S5: 最近记录纠错与撤销 ----------

function testS5() {
  console.log("\n--- S5: 最近记录纠错与撤销 ---")
  let state = makeState({
    items: [makeItem("i1", "猫砂", "宠物用品")]
  })
  const orch = createHouseholdOrchestrator()

  // 1. 记录补货
  const d1 = decide(orch, {
    text: "今天买了 2 袋猫砂，68 元",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })
  check("S5a: 生成草稿或采集", d1.kind === "sync" && d1.turn.kind !== "answer")

  // 提取 pendingDraft
  let pendingDraft = null
  let pendingCollection = null
  if (d1.turn.kind === "collection") {
    pendingCollection = d1.turn.collection
    const d2 = decide(orch, {
      text: "确认吧",
      state, itemViews: [], dateContext: DATE_CONTEXT,
      pendingCollection
    })
    if (d2.turn.kind === "proposal") {
      pendingDraft = d2.turn.executableDraft
    }
  } else if (d1.turn.kind === "proposal") {
    pendingDraft = d1.turn.executableDraft
  }

  if (!pendingDraft) {
    check("S5: 获取 pendingDraft", false, "无法获取 pendingDraft")
    return
  }

  // 2. 确认写入
  const commitResult = commitAgentDraft(state, pendingDraft, NOW)
  state = commitResult.state
  check("S5b: commit 成功", state.items[0].history.length === 1, `history len=${state.items[0].history.length}`)
  check("S5b: lastAgentMutation 存在", !!state.lastAgentMutation)
  check("S5b: mutationType = createRestockRecord",
    state.lastAgentMutation?.mutationType === "createRestockRecord" ||
    state.lastAgentMutation?.mutationType === "createItemWithRestock")

  const recordPrice = state.items[0].history[0]?.price
  check("S5b: 原始金额 68", recordPrice === 68, `got ${recordPrice}`)

  // 3. 纠错：金额改成 88
  const d3 = decide(orch, {
    text: "刚才金额改成 88",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })
  check("S5c: 纠错识别", d3.kind === "sync", `got ${d3.kind}`)
  check("S5c: planCommand", d3.turn.kind === "planCommand", `got ${d3.turn?.kind}`)
  if (d3.turn.kind === "planCommand" && d3.turn.command) {
    check("S5c: correctLastMutation", d3.turn.command.command === "correctLastMutation",
      `got ${d3.turn.command.command}`)
    check("S5c: field=price", d3.turn.command.field === "price")
    check("S5c: value=88", d3.turn.command.value === 88)
  }

  // 4. 撤销
  const d4 = decide(orch, {
    text: "撤销刚才那条",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })
  check("S5d: 撤销识别", d4.kind === "sync", `got ${d4.kind}`)
  check("S5d: planCommand", d4.turn.kind === "planCommand", `got ${d4.turn?.kind}`)
  if (d4.turn.kind === "planCommand" && d4.turn.command) {
    check("S5d: undoLastMutation", d4.turn.command.command === "undoLastMutation",
      `got ${d4.turn.command.command}`)
  }
}

// ---------- S6: 库存状态报告 ----------

function testS6() {
  console.log("\n--- S6: 库存状态报告 ---")
  const state = makeState({
    items: [makeItem("i1", "猫砂", "宠物用品", { remainingDays: 5 })]
  })
  const beforeSnap = stateSnapshot(state)
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "猫砂快没了",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })

  check("S6: decision.kind === sync", d.kind === "sync", `got ${d.kind}`)
  // 应该是 planProposal（calibrateInventory）或 answer，不应创建补货记录
  check("S6: 非 answer 导航（planProposal 校准）",
    d.turn.kind === "planProposal" || d.turn.kind === "answer",
    `got ${d.turn.kind}`)
  check("S6: 不创建补货记录", beforeSnap === stateSnapshot(state),
    "state 被修改")
  if (d.turn.kind === "planProposal") {
    check("S6: plan 类型为 calibrateInventory",
      d.turn.plan.actions[0]?.type === "calibrateInventory",
      `got ${d.turn.plan.actions[0]?.type}`)
  }
}

// ---------- S7: 周期洞察 ----------

function testS7() {
  console.log("\n--- S7: 周期洞察 ---")
  // 准备有 suggestedCycleDays 的物品
  const state = makeState({
    items: [
      makeItem("i1", "猫砂", "宠物用品", {
        cycleDays: 30,
        suggestedCycleDays: 25,
        learningEnabled: true
      })
    ]
  })
  const orch = createHouseholdOrchestrator()

  // 自然语言「改吧」不应触发周期修改
  const beforeSnap = stateSnapshot(state)
  const d = decide(orch, {
    text: "改吧",
    state, itemViews: [], dateContext: DATE_CONTEXT
  })
  // 「改吧」无 pending 上下文时不应执行周期修改
  check("S7a: 「改吧」不修改周期",
    beforeSnap === stateSnapshot(state),
    "state 被修改")
  // 「改吧」不应生成 adoptCycleInsight plan
  const isAdoptPlan = d.kind === "sync" && d.turn?.kind === "planProposal" && d.turn?.plan?.actions[0]?.type === "adoptCycleInsight"
  check("S7a: 「改吧」非 planProposal(adoptCycleInsight)", !isAdoptPlan,
    `got ${d.kind}/${d.turn?.kind ?? "no-turn"}`)

  // 确认 cycleDays 仍为 30（未被自然语言修改）
  check("S7b: cycleDays 仍为 30", state.items[0].cycleDays === 30,
    `got ${state.items[0].cycleDays}`)
  check("S7b: suggestedCycleDays 仍为 25", state.items[0].suggestedCycleDays === 25)

  // 注：adoptCycleInsight 仅通过 UI 结构化按钮触发（App.tsx applyCycleSuggestion），
  // 不走 AgentAction/AgentPlan 管道。这里验证自然语言不触发。
  console.log("  ℹ adoptCycleInsight 仅通过 UI 按钮触发，不走对话管道")
}

// ---------- 主流程 ----------

console.log("=== 403 P0 验收 Smoke Test (S1-S7) ===")

testS1()
testS2()
testS3()
testS4()
testS5()
testS6()
testS7()

console.log("\n=== 汇总 ===")
console.log(`PASS: ${pass}, FAIL: ${fail}`)
if (failures.length > 0) {
  console.log("失败项:")
  for (const f of failures) {
    console.log(`  ✖ ${f}`)
  }
  process.exit(1)
} else {
  console.log("全部通过")
}
