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

const { commitAgentPlan, applyAgentAction } = await import("../src/agent/executor.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")
const { validatePlan, summarizePlan } = await import("../src/agent/actionRegistry.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["厨房", "卫生间", "洗衣清洁", "日常护理", "宠物用品", "母婴用品", "其他"],
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

function planWith(actions, sourceText = "test") {
  return createAgentPlan(actions, sourceText, 1000)
}

// ---------- 1. createCategory ----------

test("createCategory: 新增分类", () => {
  const state = makeState()
  const plan = planWith([{ type: "createCategory", name: "园艺" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.ok(result.state.categories.includes("园艺"))
  assert.match(result.summary, /已新建分类：园艺/)
  assert.ok(result.links.some((l) => l.target.kind === "category"))
})

test("createCategory: 重复分类不重复添加", () => {
  const state = makeState({ categories: ["厨房", "卫生间"] })
  const plan = planWith([{ type: "createCategory", name: "厨房" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.categories.length, 2)
  assert.match(result.summary, /已存在/)
})

// ---------- 2. createItem ----------

test("createItem: 新增消耗品并自动补分类", () => {
  const state = makeState({ categories: ["卫生间"] })
  const plan = planWith([{
    type: "createItem",
    name: "豆腐猫砂",
    category: "宠物用品",
    cycleDays: 20,
    bufferDays: 3,
    unit: "袋"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.items.length, 1)
  assert.equal(result.state.items[0].name, "豆腐猫砂")
  assert.equal(result.state.items[0].cycleDays, 20)
  assert.ok(result.state.categories.includes("宠物用品"), "分类不存在时应自动补上")
  assert.match(result.summary, /已创建/)
})

test("createItem: 同名物品已存在时跳过", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{
    type: "createItem", name: "猫砂", category: "宠物用品",
    cycleDays: 30, bufferDays: 2, unit: "袋"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.items.length, 1)
  assert.match(result.summary, /已存在/)
})

test("createItem: 同时挂常购商品", () => {
  const state = makeState()
  const plan = planWith([{
    type: "createItem", name: "卷纸", category: "卫生间",
    cycleDays: 30, bufferDays: 2, unit: "卷",
    addPurchaseOption: { productName: "维达超韧", unit: "卷" }
  }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.items[0].purchaseOptions.length, 1)
  assert.equal(result.state.items[0].purchaseOptions[0].productName, "维达超韧")
  assert.match(result.summary, /常购商品/)
})

// ---------- 3. updateItem ----------

test("updateItem: 修改消耗品周期", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { cycleDays: 30, bufferDays: 2 })] })
  const plan = planWith([{
    type: "updateItem", itemId: "i1", cycleDays: 45, bufferDays: 5
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.cycleDays, 45)
  assert.equal(item.bufferDays, 5)
  assert.match(result.summary, /已修改/)
})

test("updateItem: 按 itemName 匹配目标", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品")] })
  const plan = planWith([{ type: "updateItem", itemName: "猫粮", cycleDays: 25 }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.items[0].cycleDays, 25)
})

test("updateItem: 找不到目标时跳过", () => {
  const state = makeState()
  const plan = planWith([{ type: "updateItem", itemName: "不存在", cycleDays: 25 }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.items.length, 0)
  assert.match(result.summary, /找不到/)
})

// ---------- 4. addPurchaseOption ----------

test("addPurchaseOption: 写入常购商品", () => {
  const state = makeState({ items: [makeItem("i1", "卷纸", "卫生间", { unit: "卷" })] })
  const plan = planWith([{
    type: "addPurchaseOption", itemId: "i1", itemName: "卷纸",
    productName: "维达超韧", unit: "卷"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.purchaseOptions.length, 1)
  assert.equal(item.purchaseOptions[0].productName, "维达超韧")
})

test("addPurchaseOption: 重复不重复添加", () => {
  const state = makeState({
    items: [makeItem("i1", "卷纸", "卫生间", {
      unit: "卷",
      purchaseOptions: [{ id: "o1", productName: "维达超韧", unit: "卷", pricingMode: "spec" }]
    })]
  })
  const plan = planWith([{
    type: "addPurchaseOption", itemId: "i1", itemName: "卷纸",
    productName: "维达超韧", unit: "卷"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.purchaseOptions.length, 1, "不重复添加")
  assert.match(result.summary, /已有/)
})

// ---------- 5. recordRestock ----------

test("recordRestock: 新增 history 记录并更新 lastRestockedAt", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { unit: "袋", lastRestockedAt: 1 })] })
  const plan = planWith([{
    type: "recordRestock", itemId: "i1", itemName: "猫粮",
    qty: 2, unit: "袋", price: 128, platform: "京东", restockDate: 5000
  }])
  const result = commitAgentPlan(state, plan, 6000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 1)
  assert.equal(item.history[0].qty, 2)
  assert.equal(item.history[0].price, 128)
  assert.equal(item.history[0].platform, "京东")
  // lastRestockedAt 会被 restockItem 用 startOfDay 归一化，只要不再是初始值 1 即可
  assert.notEqual(item.lastRestockedAt, 1, "lastRestockedAt 应被更新")
  assert.ok(Number.isFinite(item.lastRestockedAt))
  assert.match(result.summary, /已记录/)
})

test("recordRestock: cycleDaysPatch 同时修订周期", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { cycleDays: 30 })] })
  const plan = planWith([{
    type: "recordRestock", itemId: "i1", itemName: "猫粮",
    qty: 1, cycleDaysPatch: 25
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.cycleDays, 25, "周期应被修订")
  assert.equal(item.history.length, 1)
})

// ---------- 6. updateRestockRecord ----------

test("updateRestockRecord: 修改指定补货记录", () => {
  const state = makeState({
    items: [makeItem("i1", "猫粮", "宠物用品", {
      unit: "袋",
      history: [{
        id: "e1", at: 1000, qty: 1, price: 100, platform: "京东",
        purchaseUnit: "袋", rating: 3
      }]
    })]
  })
  const plan = planWith([{
    type: "updateRestockRecord", itemId: "i1", eventId: "e1",
    patch: { price: 68, platform: "淘宝" }
  }])
  const result = commitAgentPlan(state, plan, 2000)
  const event = result.state.items[0].history[0]
  assert.equal(event.price, 68)
  assert.equal(event.platform, "淘宝")
  assert.match(result.summary, /已修改/)
})

test("updateRestockRecord: 无 eventId 默认改最新一条", () => {
  const state = makeState({
    items: [makeItem("i1", "猫粮", "宠物用品", {
      history: [
        { id: "e1", at: 1000, qty: 1, price: 100, platform: "京东" },
        { id: "e2", at: 2000, qty: 2, price: 200, platform: "淘宝" }
      ]
    })]
  })
  const plan = planWith([{
    type: "updateRestockRecord", itemId: "i1",
    patch: { price: 188 }
  }])
  const result = commitAgentPlan(state, plan, 3000)
  const latest = result.state.items[0].history.find((e) => e.id === "e2")
  assert.equal(latest.price, 188)
})

// ---------- 7. setMonthlyBudget ----------

test("setMonthlyBudget: 更新 settings.monthlyBudget", () => {
  const state = makeState({ settings: { reminderIntervalHours: 1, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true } })
  const plan = planWith([{ type: "setMonthlyBudget", amount: 500 }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.settings.monthlyBudget, 500)
  assert.match(result.summary, /已设置本月预算/)
})

test("setMonthlyBudget: 不影响其他 settings 字段", () => {
  const state = makeState({ settings: { reminderIntervalHours: 2, quietStart: "23:00", quietEnd: "07:00", notificationEnabled: false, monthlyBudget: 300 } })
  const plan = planWith([{ type: "setMonthlyBudget", amount: 800 }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.settings.reminderIntervalHours, 2, "其他字段保持不变")
  assert.equal(result.state.settings.quietStart, "23:00")
  assert.equal(result.state.settings.monthlyBudget, 800)
})

// ---------- 8. 多 action plan ----------

test("多 action plan: 建分类 → 加消耗品 → 记补货 顺序执行", () => {
  const state = makeState({ categories: ["卫生间"], items: [] })
  const plan = planWith([
    { type: "createCategory", name: "宠物用品" },
    { type: "createItem", name: "豆腐猫砂", category: "宠物用品", cycleDays: 20, bufferDays: 3, unit: "袋" },
    { type: "recordRestock", itemName: "豆腐猫砂", qty: 2, unit: "袋", price: 58, platform: "京东", restockDate: 1000 }
  ])
  const result = commitAgentPlan(state, plan, 2000)
  assert.ok(result.state.categories.includes("宠物用品"))
  assert.equal(result.state.items.length, 1)
  const item = result.state.items[0]
  assert.equal(item.name, "豆腐猫砂")
  assert.equal(item.history.length, 1, "createItem 后紧跟 recordRestock 应能在工作区里找到刚建的物品")
  assert.equal(item.history[0].qty, 2)
  assert.match(result.summary, /已新建分类/)
  assert.match(result.summary, /已创建/)
  assert.match(result.summary, /已记录/)
})

test("多 action plan: 任一 action 失败不阻塞后续", () => {
  const state = makeState()
  const plan = planWith([
    { type: "updateItem", itemName: "不存在", cycleDays: 25 }, // 失败
    { type: "setMonthlyBudget", amount: 500 }                  // 仍应执行
  ])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.settings.monthlyBudget, 500)
  assert.match(result.summary, /找不到/)
  assert.match(result.summary, /已设置/)
})

// ---------- 9. 确认前不修改 state ----------

test("commitAgentPlan: 确认前不修改原 state", () => {
  const state = makeState()
  const plan = planWith([{ type: "createCategory", name: "园艺" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(state.categories.length, 7, "原 state 不应被修改")
  assert.ok(result.state.categories.includes("园艺"))
})

// ---------- 10. registry 校验与摘要 ----------

test("validatePlan: 畸形 action 返回 errors", () => {
  const state = makeState()
  const result = validatePlan([
    { type: "createCategory", name: "" },                              // error: 空名
    { type: "setMonthlyBudget", amount: -100 }                         // error: 负数
  ], state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.length >= 2)
})

test("validatePlan: 同名物品已存在返回 warning 但 ok=true", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = validatePlan([{
    type: "createItem", name: "猫砂", category: "宠物用品",
    cycleDays: 30, bufferDays: 2, unit: "袋"
  }], state)
  assert.equal(result.ok, true, "warnings 不阻断")
  assert.ok(result.warnings.some((w) => w.includes("已存在")))
})

test("summarizePlan: 多行摘要按顺序编号", () => {
  const state = makeState()
  const lines = summarizePlan([
    { type: "createCategory", name: "园艺" },
    { type: "setMonthlyBudget", amount: 500 }
  ], state)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^1\. 新建分类：园艺/)
  assert.match(lines[1], /^2\. 设置本月预算：¥500/)
})

test("applyAgentAction: 单个 action 可独立调用", () => {
  const work = { categories: ["卫生间"], items: [], settings: { reminderIntervalHours: 1, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true } }
  const links = []
  const summary = applyAgentAction(work, { type: "createCategory", name: "园艺" }, 1000, links)
  assert.ok(work.categories.includes("园艺"))
  assert.match(summary, /已新建分类/)
  assert.equal(links.length, 1)
})
