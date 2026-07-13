// 调试脚本：模拟从用户输入到 state 变更的完整删除流程

import { buildAgentPlan } from "../src/agent/planner"
import { commitAgentPlan } from "../src/agent/executor"
import { createHouseholdOrchestrator } from "../src/agent/householdOrchestrator"
import { classifyAgentIntent, isSecondConfirmMatch } from "../src/agent/intent"
import { buildChatDateContext } from "../src/llm/householdChat"
import type { AppState, ReplenishmentItem } from "../src/types"

// 构造测试 state
const catSand: ReplenishmentItem = {
  id: "item-catsand-001",
  name: "猫砂",
  category: "猫咪用品",
  unit: "袋",
  cycleDays: 14,
  bufferDays: 3,
  defaultQty: 1,
  history: [
    {
      id: "restock-001",
      at: Date.now() - 2 * 24 * 60 * 60 * 1000,
      qty: 2,
      purchaseUnit: "袋",
      price: 58,
      platform: "京东",
      purchaseProductName: "pidan 豆腐猫砂",
      review: "",
      rating: 0
    }
  ],
  purchaseOptions: [
    {
      id: "opt-001",
      productName: "pidan 豆腐猫砂",
      unit: "袋",
      platform: "京东",
      price: 29,
      isDefault: true
    },
    {
      id: "opt-002",
      productName: "N1 混合猫砂",
      unit: "袋",
      platform: "淘宝",
      price: 35,
      isDefault: false
    }
  ],
  createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
  updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
  lastRestockedAt: Date.now() - 2 * 24 * 60 * 60 * 1000
}

const initialState: AppState = {
  categories: ["猫咪用品", "临时分类"],
  items: [catSand],
  settings: {
    monthlyBudget: 500,
    reminderIntervalHours: 24,
    aiApiKey: "",
    orderImageApiKey: "",
    orderImageModel: "",
    orderRecognitionMode: "auto"
  } as any,
  householdProfile: null,
  updatedAt: Date.now(),
  version: 3
}

const dateContext = buildChatDateContext()
const orchestrator = createHouseholdOrchestrator()

console.log("========== 测试 1：删除常购商品 ==========")
console.log("用户输入：删除猫砂的 pidan 豆腐猫砂常购商品")

const planResult = buildAgentPlan({
  text: "删除猫砂的 pidan 豆腐猫砂常购商品",
  state: initialState,
  dateContext,
  pendingPlan: undefined
})

console.log("planner 结果:", JSON.stringify(planResult, null, 2))

if (planResult.kind !== "plan") {
  console.log("planner 没有生成 plan")
  process.exit(1)
}

const plan = planResult.plan
console.log("plan.risk:", plan.risk)
console.log("plan.requiresSecondConfirm:", plan.requiresSecondConfirm)
console.log("plan.actions:", JSON.stringify(plan.actions, null, 2))

console.log("\n--- 第一次确认 ---")
const decision1 = orchestrator.decide({
  text: "确认",
  state: initialState,
  itemViews: [],
  pendingPlan: { ...plan, status: "pending" },
  dateContext
})
console.log("orchestrator 决策:", JSON.stringify(decision1, null, 2))

const awaitingPlan = { ...plan, status: "awaitingSecondConfirm" as const }

console.log("\n--- 第二次确认（确认删除）---")
console.log("isSecondConfirmMatch('确认删除'):", isSecondConfirmMatch("确认删除"))
console.log("classifyAgentIntent('确认删除', true):", classifyAgentIntent("确认删除", true))

const decision2 = orchestrator.decide({
  text: "确认删除",
  state: initialState,
  itemViews: [],
  pendingPlan: awaitingPlan,
  dateContext
})
console.log("orchestrator 决策:", JSON.stringify(decision2, null, 2))

if (decision2.kind === "sync" && decision2.turn.kind === "planCommand") {
  console.log("command:", decision2.turn.command.command)

  if (decision2.turn.command.command === "planSecondConfirm") {
    console.log("\n--- 执行 commitAgentPlan ---")
    const commitResult = commitAgentPlan(initialState, plan, Date.now(), dateContext)
    console.log("commit 结果 summary:", commitResult.summary)
    console.log("state 是否改变:", commitResult.state !== initialState)

    if (commitResult.state !== initialState) {
      const updatedItem = commitResult.state.items.find((i) => i.id === "item-catsand-001")
      console.log("更新后的猫砂 purchaseOptions 数量:", updatedItem?.purchaseOptions.length)
    }
  }
}

console.log("\n========== 测试 2：删除消耗品 ==========")
const planResult2 = buildAgentPlan({
  text: "删除猫砂",
  state: initialState,
  dateContext,
  pendingPlan: undefined
})
console.log("planner 结果:", JSON.stringify(planResult2, null, 2))

if (planResult2.kind === "plan") {
  const commitResult2 = commitAgentPlan(initialState, planResult2.plan, Date.now(), dateContext)
  console.log("commit 结果:", commitResult2.summary)
  console.log("猫砂是否被删除:", !commitResult2.state.items.some((i) => i.name === "猫砂"))
}

console.log("\n========== 测试 3：删除空分类 ==========")
const planResult3 = buildAgentPlan({
  text: "删除临时分类",
  state: initialState,
  dateContext,
  pendingPlan: undefined
})
console.log("planner 结果:", JSON.stringify(planResult3, null, 2))

if (planResult3.kind === "plan") {
  const commitResult3 = commitAgentPlan(initialState, planResult3.plan, Date.now(), dateContext)
  console.log("commit 结果:", commitResult3.summary)
  console.log("categories:", commitResult3.state.categories)
}

console.log("\n========== 测试 4：删除补货记录 ==========")
const planResult4 = buildAgentPlan({
  text: "删除猫砂最近一条补货记录",
  state: initialState,
  dateContext,
  pendingPlan: undefined
})
console.log("planner 结果:", JSON.stringify(planResult4, null, 2))

if (planResult4.kind === "plan") {
  const commitResult4 = commitAgentPlan(initialState, planResult4.plan, Date.now(), dateContext)
  console.log("commit 结果:", commitResult4.summary)
}

console.log("\n========== 测试 5：旧 Draft 流程 ==========")
const planResult5 = buildAgentPlan({
  text: "帮我加一袋猫砂",
  state: initialState,
  dateContext,
  pendingPlan: undefined
})
console.log("planner 结果 kind:", planResult5.kind)
if (planResult5.kind === "plan") {
  console.log("actions:", planResult5.plan.actions.map((a) => a.type))
  const isPlanOnly = planResult5.plan.actions.some(
    (a) => a.type === "createCategory" || a.type === "setMonthlyBudget" || a.type === "updateItem"
      || a.type === "renameCategory" || a.type === "moveItem" || a.type === "updateItemUnit"
      || a.type === "updateItemReminder" || a.type === "updatePurchaseOption" || a.type === "setDefaultPurchaseOption"
      || a.type === "deletePurchaseOption" || a.type === "deleteRestockRecord" || a.type === "deleteItem" || a.type === "deleteCategory"
  )
  console.log("isPlanOnly:", isPlanOnly)
}

console.log("\n========== 测试 6：有 pendingPlan 时输入新操作 ==========")
const decision6 = orchestrator.decide({
  text: "帮我加一袋猫砂",
  state: initialState,
  itemViews: [],
  pendingPlan: { ...plan, status: "awaitingSecondConfirm" },
  dateContext
})
console.log("orchestrator 决策:", JSON.stringify(decision6, null, 2))
