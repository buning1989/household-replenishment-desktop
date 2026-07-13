// AgentPlan 第三期补丁：删除类实体识别测试
// 运行方式：node --test tests/agent-plan-delete-entity-resolution.test.mjs
//
// 403 能力收缩后：删除类请求不再通过 buildAgentPlan 生成 plan，一律返回 noPlan，
// 由 orchestrator 的导航处理器返回 answer 引导用户到对应 UI 手动操作。
// resolveEntityMention 仍保留实体识别能力（供导航处理器定位对象使用）。
//
// 覆盖：
//   - resolveEntityMention 统一实体识别（仍保留）
//   - "删除卫生间下的消耗品" → noPlan（不再批量删除）
//   - "删除卫生间" → noPlan（不再当成找不到消耗品或删除分类）
//   - 分类与物品同名 → noPlan（不再生成 clarification）
//   - 不再把"卫生间下/卫生间中"当成消耗品名（解析层仍正确，但不再生成 plan）

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

// 403 能力收缩后已关闭的删除类 action（不应通过对话生成）
const CLOSED_DELETE_TYPES = ["deletePurchaseOption", "deleteRestockRecord", "deleteItem", "deleteCategory"]

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

// ---------- 用例 1：删除空分类 → noPlan（能力已关闭） ----------

test("删除卫生间（空分类）→ noPlan（不再生成 deleteCategory plan）", () => {
  const state = makeState() // 卫生间下无物品
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- 用例 2：删除非空分类 → noPlan（能力已关闭） ----------

test("删除卫生间（非空分类，有 3 个物品）→ noPlan（不再生成 clarification）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  assert.equal(result.kind, "noPlan")
  // 不应生成 deleteCategory plan
  assert.ok(!result.plan)
})

// ---------- 用例 3-6：删除分类下全部消耗品 → noPlan（能力已关闭） ----------

test("删除卫生间下的消耗品 → noPlan（不再批量删除）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间下的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("删除卫生间中的消耗品 → noPlan（不再批量删除）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间中的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("删除卫生间里的物品 → noPlan（不再批量删除）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间里的物品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("清空卫生间分类 → noPlan（不再批量删除）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "清空卫生间分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- 用例 7：分类与物品同名 → noPlan（能力已关闭） ----------

test("删除卫生间（既是分类又是物品）→ noPlan（不再生成 clarification）", () => {
  const state = makeState({
    categories: ["卫生间"],
    items: [makeItem("i1", "卫生间", "其他")] // 同名物品属于其他分类
  })
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  assert.equal(result.kind, "noPlan")
  // 不应直接生成 plan
  assert.ok(!result.plan)
})

// ---------- 用例 8：删除不存在分类下的消耗品 → noPlan（能力已关闭） ----------

test("删除阳台下的消耗品（阳台不存在）→ noPlan（不再生成 clarification）", () => {
  const state = makeState() // 没有"阳台"分类
  const result = buildAgentPlan({ text: "删除阳台下的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- 回归：不再把"卫生间下/卫生间中"当成消耗品名（解析仍正确，但不再生成 plan） ----------

test('"卫生间下"不再生成删除 plan（能力已关闭）', () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸")]
  })
  const result = buildAgentPlan({ text: "删除卫生间下的消耗品", state, dateContext })
  // 能力收缩后：不再生成删除 plan，由导航处理器引导手动操作
  assert.equal(result.kind, "noPlan")
})

test('"卫生间中"不再生成删除 plan（能力已关闭）', () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸")]
  })
  const result = buildAgentPlan({ text: "删除卫生间中的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test('"卫生间"是分类时不再生成删除 plan（能力已关闭）', () => {
  const state = makeState() // 卫生间是空分类
  const result = buildAgentPlan({ text: "删除卫生间", state, dateContext })
  // 能力收缩后：不再生成 deleteCategory plan
  assert.equal(result.kind, "noPlan")
})

// ---------- 回归：已有删除功能不再通过对话触发（一律 noPlan） ----------

test("回归：删除猫砂（物品）→ noPlan（不再走 deleteItem）", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: [{ ...makeItem("i1", "猫砂"), category: "宠物用品" }]
  })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("回归：删除猫砂的 pidan 豆腐猫砂常购商品 → 不生成删除类 action（不再走 deletePurchaseOption）", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: [{
      ...makeItem("i1", "猫砂", "宠物用品"),
      purchaseOptions: [{ id: "opt1", productName: "pidan 豆腐猫砂", unit: "袋", pricingMode: "spec" }]
    }]
  })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 豆腐猫砂常购商品", state, dateContext })
  // 能力收缩后：不再生成 deletePurchaseOption；含商品名的句式可能回退到录入域 addPurchaseOption，
  // 但不应出现任何已关闭的删除类 action。
  if (result.kind === "plan") {
    const hasClosedDelete = result.plan.actions.some((a) => CLOSED_DELETE_TYPES.includes(a.type))
    assert.equal(hasClosedDelete, false, "不应生成已关闭的删除类 action")
  }
})

test("回归：删除猫砂最近一条补货记录 → noPlan（不再走 deleteRestockRecord）", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: [{
      ...makeItem("i1", "猫砂", "宠物用品"),
      history: [{ id: "h1", at: 1, qty: 1, unit: "袋", price: 45 }]
    }]
  })
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("回归：删除空分类 → noPlan（不再走 deleteCategory，含'分类'关键词）", () => {
  const state = makeState({
    categories: ["卫生间", "宠物用品", "其他"],
    items: []
  })
  const result = buildAgentPlan({ text: "删除卫生间分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- P0：分类名含正则元字符不崩溃（能力已关闭，仍返回 noPlan） ----------

test("P0：分类名含括号「零食(待整理)」删除时不抛异常 → noPlan", () => {
  const state = makeState({ categories: ["零食(待整理)"], items: [] })
  const result = buildAgentPlan({ text: "删除零食(待整理)分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("P0：分类名含括号「把零食(待整理)删掉」不抛异常 → noPlan", () => {
  const state = makeState({ categories: ["零食(待整理)"], items: [] })
  const result = buildAgentPlan({ text: "把零食(待整理)删掉", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- P1：分类名以「分类」结尾——能力已关闭，仍返回 noPlan ----------

test("P1：删除「临时分类」下的消耗品 → noPlan（能力已关闭）", () => {
  const state = makeState({
    categories: ["临时分类"],
    items: [
      makeItem("i1", "杂物A", "临时分类"),
      makeItem("i2", "杂物B", "临时分类")
    ]
  })
  const result = buildAgentPlan({ text: "删除临时分类下的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- P1：无方位词「删除 X 的消耗品」 → noPlan（能力已关闭） ----------

test("P1：删除卫生间的消耗品（无方位词）→ noPlan（能力已关闭）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾"),
      makeItem("i3", "纸抽")
    ]
  })
  const result = buildAgentPlan({ text: "删除卫生间的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("P1：清空卫生间的物品（无方位词）→ noPlan（能力已关闭）", () => {
  const state = makeState({
    items: [
      makeItem("i1", "卫生纸"),
      makeItem("i2", "擦手巾")
    ]
  })
  const result = buildAgentPlan({ text: "清空卫生间的物品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- P1：不再管理分类 → noPlan（能力已关闭） ----------

test("P1：不再管理卫生间（空分类）→ noPlan（能力已关闭）", () => {
  const state = makeState() // 卫生间是空分类
  const result = buildAgentPlan({ text: "不再管理卫生间", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("P1：不再管理卫生间（非空分类）→ noPlan（能力已关闭）", () => {
  const state = makeState({
    items: [makeItem("i1", "卫生纸")]
  })
  const result = buildAgentPlan({ text: "不再管理卫生间", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- P1：分类名含「下/中/里」——能力已关闭，仍返回 noPlan ----------

test("P1：清空「楼下超市」分类 → noPlan（能力已关闭）", () => {
  const state = makeState({
    categories: ["楼下超市"],
    items: [makeItem("i1", "矿泉水", "楼下超市")]
  })
  const result = buildAgentPlan({ text: "清空楼下超市分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("P1：删除「车里备货」下的消耗品 → noPlan（能力已关闭）", () => {
  const state = makeState({
    categories: ["车里备货"],
    items: [
      makeItem("i1", "车载纸巾", "车里备货"),
      makeItem("i2", "车载垃圾袋", "车里备货")
    ]
  })
  const result = buildAgentPlan({ text: "删除车里备货下的消耗品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})
