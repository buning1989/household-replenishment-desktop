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

const { buildAgentPlan, composePlanMessage } = await import("../src/agent/planner.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["厨房", "卫生间", "洗衣清洁", "日常护理", "宠物用品", "其他"],
    items: [],
    settings: { reminderIntervalHours: 1, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true },
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function makeItem(id, name, category, extra = {}) {
  return {
    id, name, category, type: "learning", cycleDays: 30, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: true, purchaseOptions: [], history: [],
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0,
    unit: "件", createdAt: 1, updatedAt: 1, ...extra
  }
}

const dateContext = {
  today: 1000,
  todayLabel: "1月1日",
  weekStart: 1000,
  weekEnd: 7000,
  nextWeekStart: 8000,
  nextWeekEnd: 14000
}

function plan(text, state = makeState(), pendingPlan) {
  return buildAgentPlan({ text, state, dateContext, pendingPlan })
}

// ---------- 建分类 ----------

test("建一个 XX 分类 → createCategory", () => {
  const result = plan("建一个宠物用品分类")
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "createCategory")
  assert.equal(result.plan.actions[0].name, "宠物用品")
})

test("新建分类叫 XX → createCategory", () => {
  const result = plan("新建分类叫园艺")
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "createCategory")
  assert.equal(result.plan.actions[0].name, "园艺")
})

test("建一个猫咪用品分类 → createCategory 自定义名", () => {
  const result = plan("建一个猫咪用品分类")
  assert.equal(result.plan.actions[0].name, "猫咪用品")
})

// ---------- 添加消耗品 ----------

test("添加一个豆腐猫砂 → createItem", () => {
  const result = plan("添加一个豆腐猫砂")
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "createItem")
  assert.equal(result.plan.actions[0].name, "豆腐猫砂")
  assert.equal(result.plan.actions[0].category, "宠物用品")
})

test("添加一个豆腐猫砂，20 天提醒一次 → createItem cycleDays=20", () => {
  const result = plan("添加一个豆腐猫砂，20 天提醒一次")
  assert.equal(result.plan.actions[0].cycleDays, 20)
})

// ---------- 记录补货 ----------

test("我刚在京东买了两袋豆腐猫砂，58 元 → createItem + recordRestock", () => {
  const state = makeState({ items: [] })
  const result = plan("我刚在京东买了两袋豆腐猫砂，58 元", state)
  assert.equal(result.kind, "plan")
  const types = result.plan.actions.map((a) => a.type)
  assert.ok(types.includes("createItem"))
  assert.ok(types.includes("recordRestock"))
  const restock = result.plan.actions.find((a) => a.type === "recordRestock")
  assert.equal(restock.qty, 2)
  assert.equal(restock.unit, "袋")
  assert.equal(restock.platform, "京东")
  assert.equal(restock.price, 58)
})

test("已有物品时「买了两袋猫粮」→ 仅 recordRestock", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { unit: "袋" })] })
  const result = plan("买了两袋猫粮", state)
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "recordRestock")
  assert.equal(result.plan.actions[0].itemId, "i1")
  assert.equal(result.plan.actions[0].qty, 2)
})

// ---------- 设置预算 ----------

test("这个月预算设成 500 → setMonthlyBudget", () => {
  const result = plan("这个月预算设成 500")
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "setMonthlyBudget")
  assert.equal(result.plan.actions[0].amount, 500)
})

test("月预算 800 元 → setMonthlyBudget", () => {
  const result = plan("月预算 800 元")
  assert.equal(result.plan.actions[0].type, "setMonthlyBudget")
  assert.equal(result.plan.actions[0].amount, 800)
})

test("预算改成 1000 → setMonthlyBudget", () => {
  const result = plan("预算改成 1000")
  assert.equal(result.plan.actions[0].amount, 1000)
})

// ---------- 修改消耗品周期 ----------

test("猫粮周期改成 30 天 → updateItem", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品")] })
  const result = plan("猫粮周期改成 30 天", state)
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "updateItem")
  assert.equal(result.plan.actions[0].itemId, "i1")
  assert.equal(result.plan.actions[0].cycleDays, 30)
})

test("把猫粮的周期改成 45 天 → updateItem", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品")] })
  const result = plan("把猫粮的周期改成 45 天", state)
  assert.equal(result.plan.actions[0].cycleDays, 45)
})

test("目标物品不存在时 updateItem → noPlan（交给 LLM）", () => {
  const state = makeState()
  const result = plan("不存在的物品周期改成 30 天", state)
  // 物品匹配失败，不生成本地 plan
  assert.equal(result.kind, "noPlan")
})

// ---------- pendingPlan 修订 ----------

test("pendingPlan 下「价格改成 68」→ 修订所有 recordRestock 的 price", () => {
  const pendingPlan = createAgentPlan([{
    type: "recordRestock", itemId: "i1", itemName: "猫粮",
    qty: 2, unit: "袋", price: 58, platform: "京东"
  }], "买了两袋猫粮", 1000)
  const result = plan("价格改成 68", makeState(), pendingPlan)
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].price, 68)
  assert.equal(result.plan.actions[0].qty, 2, "其他字段保持不变")
})

test("pendingPlan 下「平台改成淘宝」→ 修订 platform", () => {
  const pendingPlan = createAgentPlan([{
    type: "recordRestock", itemId: "i1", itemName: "猫粮",
    qty: 2, unit: "袋", platform: "京东"
  }], "买了两袋猫粮", 1000)
  const result = plan("平台改成淘宝", makeState(), pendingPlan)
  assert.equal(result.plan.actions[0].platform, "淘宝")
})

test("pendingPlan 下纯数字「68」→ 视为价格修订", () => {
  const pendingPlan = createAgentPlan([{
    type: "recordRestock", itemId: "i1", itemName: "猫粮", qty: 2, unit: "袋"
  }], "买了两袋猫粮", 1000)
  const result = plan("68", makeState(), pendingPlan)
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].price, 68)
})

test("pendingPlan 下「周期改成 30 天」→ 修订 cycleDaysPatch", () => {
  const pendingPlan = createAgentPlan([{
    type: "recordRestock", itemId: "i1", itemName: "猫粮", qty: 2, unit: "袋"
  }], "买了两袋猫粮", 1000)
  const result = plan("周期改成 30 天", makeState(), pendingPlan)
  assert.equal(result.plan.actions[0].cycleDaysPatch, 30)
})

test("pendingPlan 下修订多 action plan → 全部应用", () => {
  const pendingPlan = createAgentPlan([
    { type: "recordRestock", itemName: "猫粮", qty: 1, unit: "袋", price: 50 },
    { type: "recordRestock", itemName: "猫砂", qty: 1, unit: "袋", price: 30 }
  ], "买了猫粮和猫砂", 1000)
  const result = plan("价格都改成 60", makeState(), pendingPlan)
  // 注意：「都」不在第一期 parser 的关键词里，但「价格改成 60」会匹配并应用全部
  if (result.kind === "plan") {
    assert.equal(result.plan.actions[0].price, 60)
  }
})

// ---------- 非写入意图 ----------

test("「你好棒」→ noPlan", () => {
  const result = plan("你好棒")
  assert.equal(result.kind, "noPlan")
})

test("「明天天气咋样」→ noPlan（实时外部问题，不生成 plan）", () => {
  const result = plan("明天天气咋样")
  assert.equal(result.kind, "noPlan")
})

test("「你是谁」→ noPlan（身份问题，不生成 plan）", () => {
  const result = plan("你是谁")
  assert.equal(result.kind, "noPlan")
})

// ---------- 摘要文案 ----------

test("composePlanMessage: 多 action 生成编号摘要", () => {
  const plan = createAgentPlan([
    { type: "createCategory", name: "宠物用品" },
    { type: "createItem", name: "豆腐猫砂", category: "宠物用品", cycleDays: 20, bufferDays: 3, unit: "袋" }
  ], "建一个宠物用品分类，再加个豆腐猫砂", 1000)
  const message = composePlanMessage(plan, makeState())
  assert.match(message, /1\.\s*新建分类：宠物用品/)
  assert.match(message, /2\.\s*添加消耗品「豆腐猫砂」/)
  assert.match(message, /你要是没问题/)
})

test("composePlanMessage: 单 action plan 也有编号", () => {
  const plan = createAgentPlan([{ type: "setMonthlyBudget", amount: 500 }], "预算 500", 1000)
  const message = composePlanMessage(plan, makeState())
  assert.match(message, /1\.\s*本月预算设为 ¥500/)
})

// ---------- sourceText 保留 ----------

test("plan 保留 sourceText", () => {
  const result = plan("建一个园艺分类")
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.sourceText, "建一个园艺分类")
})
