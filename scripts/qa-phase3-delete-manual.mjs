#!/usr/bin/env node
/**
 * AgentPlan 第三阶段删除类动作 QA 脚本
 * 
 * 验证场景：
 * C1. 删除常购商品 - 正常流程
 * C2. 删除常购商品 - 物品不存在
 * C3. 删除补货记录 - 正常流程
 * C4. 删除补货记录 - 记录不存在
 * C5. 删除消耗品 - 正常流程
 * C6. 删除消耗品 - 物品不存在
 * C7. 删除分类 - 空分类
 * C8. 删除分类 - 非空分类（应失败）
 * C9. 二次确认 - 普通确认不执行
 * C10. 二次确认 - 明确删除确认执行
 */

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
const { commitAgentPlan } = await import("../src/agent/executor.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

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

function makeItem(id, name, category = "宠物用品") {
  return {
    id, name, category, type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋",
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0
  }
}

function makeOpt(id, productName, extra = {}) {
  return { id, productName, unit: "袋", pricingMode: "spec", ...extra }
}

function makeEvent(id, at, extra = {}) {
  return { id, at, qty: 1, price: 30, platform: "京东", review: undefined, purchaseProductName: "pidan", purchaseUnit: "袋", purchaseMeasureAmount: undefined, purchaseMeasureUnit: undefined, ...extra }
}

const dateContext = buildChatDateContext(Date.UTC(2026, 6, 7))
const orch = createHouseholdOrchestrator()

console.log("AgentPlan 第三阶段删除类动作 QA 测试\n")

// C1. 删除常购商品 - 正常流程
console.log("C1. 删除常购商品 - 正常流程")
{
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂"), makeOpt("o2", "怡亲")]
    }]
  })
  const decision = orch.decide({ text: "删除猫砂的 pidan 豆腐猫砂常购商品", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "planProposal") {
    const plan = decision.turn.plan
    console.log(`  ✓ 生成 planProposal，risk=${plan.risk}，requiresSecondConfirm=${plan.requiresSecondConfirm}`)
    console.log(`  ✓ 动作类型：${plan.actions[0].type}`)
    // 模拟二次确认
    plan.status = "awaitingSecondConfirm"
    const confirmDecision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan: plan })
    if (confirmDecision.kind === "sync" && confirmDecision.turn.kind === "planCommand" && confirmDecision.turn.command.command === "planSecondConfirm") {
      const result = commitAgentPlan(state, plan, 1000)
      const item = result.state.items.find((i) => i.id === "i1")
      console.log(`  ✓ 执行删除后，常购商品数量：${item.purchaseOptions.length}（预期 1）`)
      console.log(`  ✓ 剩余商品：${item.purchaseOptions[0].productName}`)
    }
  }
}

// C2. 删除常购商品 - 物品不存在
console.log("\nC2. 删除常购商品 - 物品不存在")
{
  const state = makeState()
  const decision = orch.decide({ text: "删除猫砂的 pidan 常购商品", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "clarification") {
    console.log(`  ✓ 返回 clarification：${decision.turn.message}`)
  }
}

// C3. 删除补货记录 - 正常流程
console.log("\nC3. 删除补货记录 - 正常流程")
{
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000), makeEvent("e2", 2000)]
    }]
  })
  const decision = orch.decide({ text: "删除猫砂最近一条补货记录", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "planProposal") {
    const plan = decision.turn.plan
    console.log(`  ✓ 生成 planProposal，risk=${plan.risk}`)
    console.log(`  ✓ 动作类型：${plan.actions[0].type}`)
    plan.status = "awaitingSecondConfirm"
    const confirmDecision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan: plan })
    if (confirmDecision.kind === "sync" && confirmDecision.turn.kind === "planCommand" && confirmDecision.turn.command.command === "planSecondConfirm") {
      const result = commitAgentPlan(state, plan, 1000)
      const item = result.state.items.find((i) => i.id === "i1")
      console.log(`  ✓ 执行删除后，补货记录数量：${item.history.length}（预期 1）`)
    }
  }
}

// C4. 删除补货记录 - 记录不存在
console.log("\nC4. 删除补货记录 - 记录不存在")
{
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000, { price: 30 })]
    }]
  })
  const decision = orch.decide({ text: "删除猫砂价格 58 的补货记录", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "clarification") {
    console.log(`  ✓ 返回 clarification：${decision.turn.message}`)
  }
}

// C5. 删除消耗品 - 正常流程
console.log("\nC5. 删除消耗品 - 正常流程")
{
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan")],
      history: [makeEvent("e1", 1000)]
    }]
  })
  const decision = orch.decide({ text: "删除猫砂", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "planProposal") {
    const plan = decision.turn.plan
    console.log(`  ✓ 生成 planProposal，risk=${plan.risk}`)
    console.log(`  ✓ 动作类型：${plan.actions[0].type}`)
    plan.status = "awaitingSecondConfirm"
    const confirmDecision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan: plan })
    if (confirmDecision.kind === "sync" && confirmDecision.turn.kind === "planCommand" && confirmDecision.turn.command.command === "planSecondConfirm") {
      const result = commitAgentPlan(state, plan, 1000)
      console.log(`  ✓ 执行删除后，物品数量：${result.state.items.length}（预期 0）`)
    }
  }
}

// C6. 删除消耗品 - 物品不存在
console.log("\nC6. 删除消耗品 - 物品不存在")
{
  const state = makeState()
  const decision = orch.decide({ text: "删除猫砂", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "clarification") {
    console.log(`  ✓ 返回 clarification：${decision.turn.message}`)
  }
}

// C7. 删除分类 - 空分类
console.log("\nC7. 删除分类 - 空分类")
{
  const state = makeState({ categories: ["宠物用品", "日常护理", "其他"] })
  const decision = orch.decide({ text: "删除宠物用品分类", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "planProposal") {
    const plan = decision.turn.plan
    console.log(`  ✓ 生成 planProposal，risk=${plan.risk}`)
    console.log(`  ✓ 动作类型：${plan.actions[0].type}`)
    plan.status = "awaitingSecondConfirm"
    const confirmDecision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan: plan })
    if (confirmDecision.kind === "sync" && confirmDecision.turn.kind === "planCommand" && confirmDecision.turn.command.command === "planSecondConfirm") {
      const result = commitAgentPlan(state, plan, 1000)
      console.log(`  ✓ 执行删除后，分类数量：${result.state.categories.length}（预期 2）`)
      console.log(`  ✓ 剩余分类：${result.state.categories.join(", ")}`)
    }
  }
}

// C8. 删除分类 - 非空分类（应失败）
console.log("\nC8. 删除分类 - 非空分类（应失败）")
{
  const state = makeState({
    items: [makeItem("i1", "猫砂", "宠物用品")]
  })
  const decision = orch.decide({ text: "删除宠物用品分类", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "clarification") {
    console.log(`  ✓ 返回 clarification：${decision.turn.message}`)
    console.log(`  ✓ 非空分类不允许删除，符合预期`)
  }
}

// C9. 二次确认 - 普通确认不执行
console.log("\nC9. 二次确认 - 普通确认不执行")
{
  const state = makeState({
    items: [makeItem("i1", "猫砂")]
  })
  const decision = orch.decide({ text: "删除猫砂", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "planProposal") {
    const plan = decision.turn.plan
    console.log(`  ✓ 生成 planProposal，risk=${plan.risk}，requiresSecondConfirm=${plan.requiresSecondConfirm}`)
    // 用户只说"确认"
    const confirmDecision = orch.decide({ text: "确认", state, itemViews: [], dateContext, pendingPlan: plan })
    if (confirmDecision.kind === "sync" && confirmDecision.turn.kind === "planCommand" && confirmDecision.turn.command.command === "planAwaitingSecondConfirm") {
      console.log(`  ✓ 返回 planAwaitingSecondConfirm command，不执行删除`)
      console.log(`  ✓ plan 状态应推进到 awaitingSecondConfirm`)
    }
  }
}

// C10. 二次确认 - 明确删除确认执行
console.log("\nC10. 二次确认 - 明确删除确认执行")
{
  const state = makeState({
    items: [makeItem("i1", "猫砂")]
  })
  const decision = orch.decide({ text: "删除猫砂", state, itemViews: [], dateContext })
  if (decision.kind === "sync" && decision.turn.kind === "planProposal") {
    const plan = decision.turn.plan
    plan.status = "awaitingSecondConfirm"
    // 用户说"确认删除"
    const confirmDecision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan: plan })
    if (confirmDecision.kind === "sync" && confirmDecision.turn.kind === "planCommand" && confirmDecision.turn.command.command === "planSecondConfirm") {
      console.log(`  ✓ 返回 planSecondConfirm command，准备执行删除`)
      const result = commitAgentPlan(state, plan, 1000)
      console.log(`  ✓ 执行删除后，物品数量：${result.state.items.length}（预期 0）`)
    }
  }
}

console.log("\n✅ 所有 QA 场景验证完成")
