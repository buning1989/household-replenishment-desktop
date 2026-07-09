// AgentPlan 第三期补丁：删除类实体识别测试
// 运行方式：node --test tests/agent-plan-delete-entity-resolution.test.mjs
//
// 覆盖：
//   - resolveEntityMention 统一实体识别
//   - "删除卫生间下的消耗品" → 分类范围批量删除（多个 deleteItem）
//   - "删除卫生间" → 优先按分类处理（不再当成找不到消耗品）
//   - 分类与物品同名 → clarification
//   - 不再把"卫生间下/卫生间中"当成消耗品名

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

const { buildAgentPlan, resolveEntityMention } = await import("../src/agent/planner.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["卫生间", "宠物用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function makeItem(id, name, category = "卫生间") {
  return {
    id, name, category, type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "件",
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0
  }
}

const dateContext = buildChatDateContext(Date.UTC(2026, 6, 8))

// ---------- resolveEntityMention 测试 ----------

test("resolveEntityMention: 候选名是已有分类 → category", () => {
  const state = makeState()
  const result = resolveEntityMention("卫生间", state)
  assert.equal(result.kind, "category")
  assert.equal(result.name, "卫生间")
  assert.equal(result.confidence, "exact")
})

test("resolveEntityMention: 剥离尾部方位词后匹配分类 → category", () => {
  const state = makeState()
  const result = resolveEntityMention("卫生间下", state)
  assert.equal(result.kind, "category")
  assert.equal(result.name, "卫生间")
})

test("resolveEntityMention: 候选名是已有物品 → item", () => {
  const state = makeState({ items: [makeItem("i1", "卫生纸")] })
  const result = resolveEntityMention("卫生纸", state)
  assert.equal(result.kind, "item")
  assert.equal(result.name, "卫生纸")
})

test("resolveEntityMention: 分类与物品同名 → unknown（歧义）", () => {
  const state = makeState({ items: [makeItem("i1", "卫生间")] })
  const result = resolveEntityMention("卫生间", state)
  assert.equal(result.kind, "unknown")
})

test("resolveEntityMention: 无匹配 → unknown", () => {
  const state = makeState()
  const result = resolveEntityMention("不存在的东西", state)
  assert.equal(result.kind, "unknown")
})

// ---------- 用例 1：删除空分类 → deleteCategory plan ----------

test("删除卫生间（空分类）→ deleteCategory plan", () => {
  const state = makeState() // 卫生间下无物品
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "deleteCategory")
  assert.equal(result.plan.actions[0].categoryName, "卫生间")
  assert.equal(result.plan.risk, "high")
  assert.equal(result.plan.requiresSecondConfirm, true)
})

// ---------- 用例 2：删除非空分类 → clarification ----------

test("删除卫生间（非空分类，有 3 个物品）→ clarification", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.ok(result.message.includes("3 个消耗品"), `message 应包含"3 个消耗品"，实际：${result.message}`)
  // 不应生成 deleteCategory plan
  assert.ok(!result.plan)
})

// ---------- 用例 3-6：删除分类下全部消耗品 → 多个 deleteItem plan ----------

test("删除卫生间下的消耗品 → 3 个 deleteItem plan", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间下的消耗品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 3)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
  const names = result.plan.actions.map((a) => a.itemName).sort()
  assert.deepEqual(names, ["擦手巾", "卫生纸", "纸抽"].sort())
  assert.equal(result.plan.risk, "high")
  assert.equal(result.plan.requiresSecondConfirm, true)
})

test("删除卫生间中的消耗品 → 3 个 deleteItem plan", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间中的消耗品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 3)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})

test("删除卫生间里的物品 → 3 个 deleteItem plan", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间里的物品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 3)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})

test("清空卫生间分类 → 3 个 deleteItem plan", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "清空卫生间分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 3)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})

// ---------- 用例 7：分类与物品同名 → clarification ----------

test("删除卫生间（既是分类又是物品）→ clarification with options", () => {
  const state = makeState({
    categories: ["卫生间"],
    items: [makeItem("i1", "卫生间", "其他")] // 同名物品属于其他分类
  })
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.ok(result.message.includes("既是分类也是消耗品"), `message 应提示歧义，实际：${result.message}`)
  assert.ok(result.options && result.options.length === 2, "应提供 2 个选项")
  assert.ok(result.options.some((o) => o.includes("删除分类")), "应包含删除分类选项")
  assert.ok(result.options.some((o) => o.includes("删除消耗品")), "应包含删除消耗品选项")
  // 不应直接生成 plan
  assert.ok(!result.plan)
})

// ---------- 用例 8：删除不存在分类下的消耗品 → clarification ----------

test("删除阳台下的消耗品（阳台不存在）→ clarification 提示分类不存在", () => {
  const state = makeState() // 没有"阳台"分类
  const result = buildAgentPlan({ text: "删除阳台下的消耗品", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.ok(result.message.includes("分类「阳台」不存在"), `message 应提示分类不存在，实际：${result.message}`)
  // 不应回复"找不到消耗品「阳台下」"
  assert.ok(!result.message.includes("找不到消耗品"), `不应出现"找不到消耗品"，实际：${result.message}`)
})

// ---------- 回归：不再把"卫生间下/卫生间中"当成消耗品名 ----------

test('不再把"卫生间下"当成消耗品名', () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸")]
  })
  const result = buildAgentPlan({ text: "删除卫生间下的消耗品", state, dateContext })
  // 应识别为分类范围批量删除，不是"找不到消耗品「卫生间下」"
  assert.equal(result.kind, "plan")
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})

test('不再把"卫生间中"当成消耗品名', () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸")]
  })
  const result = buildAgentPlan({ text: "删除卫生间中的消耗品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})

test('不再把"卫生间"当成消耗品名（卫生间是分类）', () => {
  const state = makeState() // 卫生间是空分类
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  // 应识别为删除分类，不是"找不到消耗品「卫生间」"
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
})

// ---------- 回归：已有删除功能不受影响 ----------

test("回归：删除猫砂（物品）仍走 deleteItem", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: [{ ...makeItem("i1", "猫砂"), category: "宠物用品" }]
  })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteItem")
  assert.equal(result.plan.actions[0].itemName, "猫砂")
})

test("回归：删除猫砂的 pidan 豆腐猫砂常购商品仍走 deletePurchaseOption", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: [{
      ...makeItem("i1", "猫砂", "宠物用品"),
      purchaseOptions: [{ id: "opt1", productName: "pidan 豆腐猫砂", unit: "袋", pricingMode: "spec" }]
    }]
  })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 豆腐猫砂常购商品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deletePurchaseOption")
})

test("回归：删除猫砂最近一条补货记录仍走 deleteRestockRecord", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: [{
      ...makeItem("i1", "猫砂", "宠物用品"),
      history: [{ id: "h1", at: 1, qty: 1, unit: "袋", price: 45 }]
    }]
  })
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteRestockRecord")
})

test("回归：删除空分类仍走 deleteCategory（含'分类'关键词）", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: []
  })
  const result = buildAgentPlan({ text: "删除卫生间分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
})

// ---------- P0：分类名含正则元字符不崩溃 ----------

test("P0：分类名含括号「零食(待整理)」删除时不抛异常", () => {
  const state = makeState({ categories: ["零食(待整理)"], items: [] })
  const result = buildAgentPlan({ text: "删除零食(待整理)分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
  assert.equal(result.plan.actions[0].categoryName, "零食(待整理)")
})

test("P0：分类名含括号「把零食(待整理)删掉」不抛异常", () => {
  const state = makeState({ categories: ["零食(待整理)"], items: [] })
  const result = buildAgentPlan({ text: "把零食(待整理)删掉", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
})

// ---------- P1：分类名以「分类」结尾不被误剥 ----------

test("P1：删除「临时分类」下的消耗品——分类名以「分类」结尾不误剥", () => {
  const state = makeState({
    categories: ["临时分类"],
    items: [
      makeItem("i1", "杂物A", "临时分类"),
      makeItem("i2", "杂物B", "临时分类")
    ]
  })
  const result = buildAgentPlan({ text: "删除临时分类下的消耗品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 2)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
  // 不应出现「分类「临时」不存在」
  assert.ok(!result.message || !result.message.includes("「临时」"))
})

// ---------- P1：无方位词「删除 X 的消耗品」 ----------

test("P1：删除卫生间的消耗品（无方位词）→ 多个 deleteItem", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间的消耗品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 3)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
  // 不应返回"找不到消耗品「卫生间」"
  assert.ok(!result.message || !result.message.includes("找不到消耗品"))
})

test("P1：清空卫生间的物品（无方位词）→ 多个 deleteItem", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾")
    ]
  })
  const result = buildAgentPlan({ text: "清空卫生间的物品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 2)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})

// ---------- P1：不再管理分类 ----------

test("P1：不再管理卫生间（空分类）→ deleteCategory plan", () => {
  const state = makeState() // 卫生间是空分类
  const result = buildAgentPlan({ text: "不再管理卫生间", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
  // 不应返回"找不到消耗品「卫生间」"
  assert.ok(!result.message || !result.message.includes("找不到消耗品"))
})

test("P1：不再管理卫生间（非空分类）→ clarification", () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸")]
  })
  const result = buildAgentPlan({ text: "不再管理卫生间", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.ok(result.message.includes("3 个消耗品") || result.message.includes("1 个消耗品"),
    `message 应提示分类下有消耗品，实际：${result.message}`)
})

// ---------- P1：分类名含「下/中/里」不被截断 ----------

test("P1：清空「楼下超市」分类——分类名含「下」不截断", () => {
  const state = makeState({
    categories: ["楼下超市"],
    items: [makeItem("i1", "矿泉水", "楼下超市")]
  })
  const result = buildAgentPlan({ text: "清空楼下超市分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "deleteItem")
  assert.equal(result.plan.actions[0].itemName, "矿泉水")
})

test("P1：删除「车里备货」下的消耗品——分类名含「里」不截断", () => {
  const state = makeState({
    categories: ["车里备货"],
    items: [
      makeItem("i1", "车载纸巾", "车里备货"),
      makeItem("i2", "车载垃圾袋", "车里备货")
    ]
  })
  const result = buildAgentPlan({ text: "删除车里备货下的消耗品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 2)
  assert.ok(result.plan.actions.every((a) => a.type === "deleteItem"))
})
