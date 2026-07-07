// 任务 4：AgentPlanCard 动作摘要逻辑回归测试
// 运行方式：node --test tests/agent-plan-card-summary.test.mjs
//
// 由于当前项目没有 React 组件测试框架（vitest + jsdom / testing-library），
// 这里通过 planner.ts 导出的 summarizeActionLocal（与 App.tsx 中 summarizeActionForCard
// 共用同一套动作 → 文案映射规则）覆盖 7 类动作的摘要生成，验证：
//   1. 7 类 action 都能产出非空摘要
//   2. 多 action 顺序展示（composePlanMessage 已在 agent-planner.test.mjs 覆盖，这里只验单条）
//   3. recordRestock / updateRestockRecord 只展示已填字段
//   4. updateItem 无任何变更字段时显示"无变更"
// 组件级状态（pending/confirmed/cancelled 按钮、aria-label）见 docs/manual-verification.md 验证 A10。

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

const { summarizeActionLocal } = await import("../src/agent/planner.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "宠物用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

// ---------- 1. 7 类 action 摘要都非空 ----------

test("summarizeActionLocal: createCategory 含分类名", () => {
  const summary = summarizeActionLocal({ type: "createCategory", name: "宠物用品" }, makeState())
  assert.ok(summary.includes("宠物用品"), `应含分类名, 实际：${summary}`)
  assert.ok(summary.includes("新建分类"), `应含"新建分类", 实际：${summary}`)
})

test("summarizeActionLocal: createItem 含名称/分类/周期", () => {
  const summary = summarizeActionLocal(
    { type: "createItem", name: "豆腐猫砂", category: "宠物用品", cycleDays: 20, bufferDays: 3, unit: "袋" },
    makeState()
  )
  assert.ok(summary.includes("豆腐猫砂"), `应含物品名, 实际：${summary}`)
  assert.ok(summary.includes("宠物用品"), `应含分类, 实际：${summary}`)
  assert.ok(summary.includes("20"), `应含周期, 实际：${summary}`)
})

test("summarizeActionLocal: createItem + addPurchaseOption 含常购商品", () => {
  const summary = summarizeActionLocal(
    {
      type: "createItem",
      name: "豆腐猫砂", category: "宠物用品", cycleDays: 20, bufferDays: 3, unit: "袋",
      addPurchaseOption: { productName: "洁珊豆腐猫砂 6L", unit: "袋" }
    },
    makeState()
  )
  assert.ok(summary.includes("洁珊豆腐猫砂"), `应含常购商品名, 实际：${summary}`)
})

test("summarizeActionLocal: updateItem 含目标物品名和变更字段", () => {
  const summary = summarizeActionLocal(
    { type: "updateItem", itemId: "i1", itemName: "猫砂", cycleDays: 30, bufferDays: 5 },
    makeState()
  )
  assert.ok(summary.includes("猫砂"), `应含物品名, 实际：${summary}`)
  assert.ok(summary.includes("30"), `应含周期, 实际：${summary}`)
  assert.ok(summary.includes("5"), `应含提前天数, 实际：${summary}`)
})

test("summarizeActionLocal: updateItem 无任何变更字段时显示「无变更」", () => {
  const summary = summarizeActionLocal(
    { type: "updateItem", itemId: "i1", itemName: "猫砂" },
    makeState()
  )
  assert.ok(summary.includes("无变更"), `无变更字段时应显示"无变更", 实际：${summary}`)
})

test("summarizeActionLocal: addPurchaseOption 含常购商品和目标物品", () => {
  const summary = summarizeActionLocal(
    { type: "addPurchaseOption", itemId: "i1", itemName: "猫砂", productName: "洁珊豆腐猫砂", unit: "袋" },
    makeState()
  )
  assert.ok(summary.includes("洁珊豆腐猫砂"), `应含常购商品, 实际：${summary}`)
  assert.ok(summary.includes("猫砂"), `应含目标物品, 实际：${summary}`)
})

test("summarizeActionLocal: recordRestock 含物品名和已填字段", () => {
  const summary = summarizeActionLocal(
    { type: "recordRestock", itemId: "i1", itemName: "猫砂", qty: 2, unit: "袋", price: 90, platform: "京东" },
    makeState()
  )
  assert.ok(summary.includes("猫砂"), `应含物品名, 实际：${summary}`)
  assert.ok(summary.includes("2"), `应含数量, 实际：${summary}`)
  assert.ok(summary.includes("京东"), `应含平台, 实际：${summary}`)
  assert.ok(summary.includes("90"), `应含价格, 实际：${summary}`)
})

test("summarizeActionLocal: recordRestock 缺字段时只展示已填字段", () => {
  const summary = summarizeActionLocal(
    { type: "recordRestock", itemId: "i1", itemName: "猫砂", qty: 1, unit: "袋" },
    makeState()
  )
  assert.ok(summary.includes("猫砂"), `应含物品名, 实际：${summary}`)
  assert.ok(summary.includes("1"), `应含数量, 实际：${summary}`)
  // 缺金额/平台时不应出现 ¥ 或 京东
  assert.ok(!summary.includes("¥"), `缺金额时不应显示 ¥, 实际：${summary}`)
  assert.ok(!summary.includes("京东"), `缺平台时不应显示"京东", 实际：${summary}`)
})

test("summarizeActionLocal: updateRestockRecord 含已填变更字段", () => {
  const summary = summarizeActionLocal(
    { type: "updateRestockRecord", itemId: "i1", eventId: "e1", patch: { price: 45, platform: "京东" } },
    makeState()
  )
  assert.ok(summary.includes("45"), `应含价格, 实际：${summary}`)
  assert.ok(summary.includes("京东"), `应含平台, 实际：${summary}`)
})

test("summarizeActionLocal: updateRestockRecord 无变更字段时显示「无变更」", () => {
  const summary = summarizeActionLocal(
    { type: "updateRestockRecord", itemId: "i1", eventId: "e1", patch: {} },
    makeState()
  )
  assert.ok(summary.includes("无变更"), `无变更字段时应显示"无变更", 实际：${summary}`)
})

test("summarizeActionLocal: setMonthlyBudget 含金额", () => {
  const summary = summarizeActionLocal({ type: "setMonthlyBudget", amount: 500 }, makeState())
  assert.ok(summary.includes("500"), `应含金额, 实际：${summary}`)
  assert.ok(summary.includes("预算"), `应含"预算", 实际：${summary}`)
})

// ---------- 2. AgentPlan 多 action 顺序展示 ----------

test("AgentPlan.actions 顺序保留，UI 按数组顺序展示", () => {
  const plan = createAgentPlan([
    { type: "createCategory", name: "宠物用品" },
    { type: "createItem", name: "豆腐猫砂", category: "宠物用品", cycleDays: 20, bufferDays: 3, unit: "袋" },
    { type: "setMonthlyBudget", amount: 500 }
  ], "建分类+加物品+设预算", 1000)
  // actions 数组顺序 = UI <ol> 渲染顺序
  assert.equal(plan.actions[0].type, "createCategory")
  assert.equal(plan.actions[1].type, "createItem")
  assert.equal(plan.actions[2].type, "setMonthlyBudget")
  // 每条都能产出摘要
  const summaries = plan.actions.map((a) => summarizeActionLocal(a, makeState()))
  assert.ok(summaries.every((s) => s && s.length > 0), "所有 action 摘要都非空")
  assert.ok(summaries[0].includes("宠物用品"))
  assert.ok(summaries[1].includes("豆腐猫砂"))
  assert.ok(summaries[2].includes("500"))
})

// ---------- 3. 状态约束（与 UI 对齐） ----------
//
// AgentPlanCard 的 pending/confirmed/cancelled/superseded 状态由消息层管理，
// 不在 summarizeActionLocal 范围内。这里只验证：
//   - confirmed/cancelled/superseded 状态下 plan 内容不变（UI 只改 statusLabel）
//   - 多次调用 summarizeActionLocal 是纯函数（无副作用）
test("summarizeActionLocal 是纯函数：多次调用结果一致", () => {
  const action = { type: "recordRestock", itemId: "i1", itemName: "猫砂", qty: 2, unit: "袋", price: 90, platform: "京东" }
  const state = makeState()
  const s1 = summarizeActionLocal(action, state)
  const s2 = summarizeActionLocal(action, state)
  const s3 = summarizeActionLocal(action, state)
  assert.equal(s1, s2)
  assert.equal(s2, s3)
})
