// 任务 P6: AgentPlan 第二期 executor 执行测试
// 运行方式：node --test tests/agent-plan-edit-executor.test.mjs
//
// 覆盖：
//   - renameCategory 成功 / 同名冲突失败 / 原分类不存在失败
//   - moveItem 成功 / 目标分类不存在失败
//   - updateItemUnit 成功 / 目标物品不存在跳过
//   - updateItemReminder 成功 / 目标物品不存在跳过
//   - updatePurchaseOption 成功（平台/价格）/ 常购商品不存在跳过
//   - setDefaultPurchaseOption 成功（旧默认自动取消）/ 常购商品不存在跳过
//   - 多 action 顺序执行成功
//   - action 失败时回滚 state，不产生部分错误写入

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

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "日常护理", "其他"],
    items: [],
    settings: { reminderIntervalHours: 1, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true },
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

function planWith(actions, sourceText = "test") {
  return createAgentPlan(actions, sourceText, 1000)
}

// ---------- renameCategory ----------

test("renameCategory: 成功", () => {
  const state = makeState()
  const plan = planWith([{ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.ok(result.state.categories.includes("猫咪用品"), "新分类名应存在")
  assert.ok(!result.state.categories.includes("宠物用品"), "旧分类名应被替换")
  assert.match(result.summary, /已重命名分类/)
})

test("renameCategory: 同步迁移物品的 category 字段", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.category, "猫咪用品", "物品分类应同步迁移")
})

test("renameCategory: 同名冲突失败 → state 不被污染", () => {
  const state = makeState()
  const plan = planWith([{ type: "renameCategory", oldName: "宠物用品", newName: "日常护理" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时应返回原 state")
  assert.ok(result.state.categories.includes("宠物用品"), "原分类应保留")
  assert.match(result.summary, /重名/)
})

test("renameCategory: 原分类不存在失败 → state 不被污染", () => {
  const state = makeState()
  const plan = planWith([{ type: "renameCategory", oldName: "不存在的分类", newName: "新分类" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时应返回原 state")
  assert.match(result.summary, /不存在/)
})

// ---------- moveItem ----------

test("moveItem: 成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{ type: "moveItem", itemId: "i1", itemName: "猫砂", targetCategory: "日常护理" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.category, "日常护理", "物品分类应被移动")
  assert.match(result.summary, /已移动/)
})

test("moveItem: 目标分类不存在失败 → state 不被污染", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{ type: "moveItem", itemId: "i1", itemName: "猫砂", targetCategory: "不存在的分类" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时应返回原 state")
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.category, "宠物用品", "物品分类应保持原状")
  assert.match(result.summary, /不存在/)
})

test("moveItem: 同分类不算失败", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{ type: "moveItem", itemId: "i1", itemName: "猫砂", targetCategory: "宠物用品" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.notEqual(result.state, state, "同分类仍返回新 state（updatedAt 变化）")
  assert.match(result.summary, /已经在/)
})

test("moveItem: 目标物品不存在 → 良性跳过", () => {
  const state = makeState()
  const plan = planWith([{ type: "moveItem", itemName: "不存在的猫砂", targetCategory: "宠物用品" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.match(result.summary, /找不到/)
  // 良性跳过不回滚（state 是新 state，但内容不变）
})

// ---------- updateItemUnit ----------

test("updateItemUnit: 成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const plan = planWith([{ type: "updateItemUnit", itemId: "i1", itemName: "猫砂", unit: "包" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.unit, "包", "单位应被修改")
  assert.match(result.summary, /已修改单位/)
})

test("updateItemUnit: 目标物品不存在 → 良性跳过", () => {
  const state = makeState()
  const plan = planWith([{ type: "updateItemUnit", itemName: "不存在的猫砂", unit: "包" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.match(result.summary, /找不到/)
})

// ---------- updateItemReminder ----------

test("updateItemReminder: 成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{ type: "updateItemReminder", itemId: "i1", itemName: "猫砂", bufferDays: 5 }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.bufferDays, 5, "提前天数应被修改")
  assert.match(result.summary, /已修改提醒/)
})

test("updateItemReminder: 目标物品不存在 → 良性跳过", () => {
  const state = makeState()
  const plan = planWith([{ type: "updateItemReminder", itemName: "不存在的猫砂", bufferDays: 5 }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.match(result.summary, /找不到/)
})

// ---------- updatePurchaseOption ----------

test("updatePurchaseOption: 平台修改成功", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const plan = planWith([{
    type: "updatePurchaseOption", itemId: "i1", itemName: "猫砂", optionId: "o1", productName: "pidan 豆腐猫砂",
    patch: { platform: "京东" }
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const opt = result.state.items[0].purchaseOptions[0]
  assert.equal(opt.platform, "京东", "平台应被修改")
  assert.match(result.summary, /已修改常购商品/)
})

test("updatePurchaseOption: 价格修改成功", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const plan = planWith([{
    type: "updatePurchaseOption", itemId: "i1", itemName: "猫砂", optionId: "o1", productName: "pidan 豆腐猫砂",
    patch: { price: 58 }
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const opt = result.state.items[0].purchaseOptions[0]
  assert.equal(opt.price, 58, "价格应被修改")
})

test("updatePurchaseOption: 常购商品不存在 → 良性跳过", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const plan = planWith([{
    type: "updatePurchaseOption", itemId: "i1", itemName: "猫砂", productName: "不存在的商品",
    patch: { price: 58 }
  }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.match(result.summary, /找不到常购商品/)
  const opt = result.state.items[0].purchaseOptions[0]
  assert.equal(opt.price, undefined, "原常购商品价格应保持不变")
})

// ---------- setDefaultPurchaseOption ----------

test("setDefaultPurchaseOption: 成功设置默认", () => {
  const item = {
    ...makeItem("i1", "猫砂"),
    purchaseOptions: [
      makeOpt("o1", "pidan 豆腐猫砂", { isDefault: true }),
      makeOpt("o2", "洁珊豆腐猫砂")
    ]
  }
  const state = makeState({ items: [item] })
  const plan = planWith([{
    type: "setDefaultPurchaseOption", itemId: "i1", itemName: "猫砂", optionId: "o2", productName: "洁珊豆腐猫砂"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const opts = result.state.items[0].purchaseOptions
  assert.equal(opts[0].isDefault, false, "旧默认应被取消")
  assert.equal(opts[1].isDefault, true, "新默认应被设置")
  assert.match(result.summary, /已设默认常购商品/)
})

// 回归测试：productName 空格差异应被忽略（"pidan 豆腐猫砂" vs "pidan豆腐猫砂"）
// 源自手动 QA B7 发现的 bug：用户输入无空格时匹配不到带空格的常购商品
test("setDefaultPurchaseOption: productName 空格差异应被忽略", () => {
  const item = {
    ...makeItem("i1", "猫砂"),
    purchaseOptions: [
      makeOpt("o1", "pidan 豆腐猫砂"),  // state 里带空格
      makeOpt("o2", "洁珊", { isDefault: true })
    ]
  }
  const state = makeState({ items: [item] })
  // 用户输入无空格（与 planner 的 cleanText 行为一致）
  const plan = planWith([{
    type: "setDefaultPurchaseOption",
    itemId: "i1", itemName: "猫砂",
    productName: "pidan豆腐猫砂"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const opts = result.state.items[0].purchaseOptions
  assert.equal(opts[0].isDefault, true, "pidan 应被设为默认（忽略空格差异）")
  assert.equal(opts[1].isDefault, false, "洁珊 应被取消默认")
  assert.match(result.summary, /已设默认常购商品/)
})

// updatePurchaseOption 同样应忽略空格差异
test("updatePurchaseOption: productName 空格差异应被忽略", () => {
  const item = {
    ...makeItem("i1", "猫砂"),
    purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")]  // state 里带空格
  }
  const state = makeState({ items: [item] })
  const plan = planWith([{
    type: "updatePurchaseOption",
    itemId: "i1", itemName: "猫砂",
    productName: "pidan豆腐猫砂",  // 用户输入无空格
    patch: { price: 58 }
  }])
  const result = commitAgentPlan(state, plan, 1000)
  const opt = result.state.items[0].purchaseOptions[0]
  assert.equal(opt.price, 58, "价格应被修改（忽略空格差异匹配成功）")
})

test("setDefaultPurchaseOption: 常购商品不存在 → 良性跳过", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const plan = planWith([{
    type: "setDefaultPurchaseOption", itemId: "i1", itemName: "猫砂", productName: "不存在的商品"
  }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.match(result.summary, /找不到常购商品/)
  assert.equal(result.state.items[0].purchaseOptions[0].isDefault, undefined, "原状态应保持不变")
})

// ---------- 多 action 顺序执行 ----------

test("多 action 顺序执行成功：renameCategory + moveItem + updateItemReminder", () => {
  // 物品初始在「宠物用品」，rename 后物品的 category 会被同步迁移到「猫咪用品」，
  // 所以 moveItem 的目标分类必须与 rename 后的新分类不同，才能验证 moveItem 真正生效。
  const item = makeItem("i1", "猫砂", "宠物用品")
  const state = makeState({ items: [item] })
  const plan = planWith([
    { type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" },
    { type: "moveItem", itemId: "i1", itemName: "猫砂", targetCategory: "日常护理" },
    { type: "updateItemReminder", itemId: "i1", itemName: "猫砂", bufferDays: 7 }
  ])
  const result = commitAgentPlan(state, plan, 1000)
  assert.ok(result.state.categories.includes("猫咪用品"), "分类应被重命名")
  assert.ok(result.state.categories.includes("日常护理"), "目标分类应保留")
  const updatedItem = result.state.items.find((i) => i.id === "i1")
  assert.equal(updatedItem.category, "日常护理", "物品应被移到日常护理")
  assert.equal(updatedItem.bufferDays, 7, "提醒天数应被修改")
  assert.match(result.summary, /已重命名/)
  assert.match(result.summary, /已移动/)
  assert.match(result.summary, /已修改提醒/)
})

// ---------- action 失败时回滚 state，不产生部分错误写入 ----------

test("action 失败时回滚：renameCategory 失败 → moveItem 不执行 → state 不变", () => {
  // renameCategory 因同名冲突失败 → 后续 moveItem 不应执行 → state 应被回滚
  const item = makeItem("i1", "猫砂", "宠物用品")
  const state = makeState({ items: [item] })
  const plan = planWith([
    { type: "renameCategory", oldName: "宠物用品", newName: "日常护理" }, // 失败（与日常护理同名）
    { type: "moveItem", itemId: "i1", itemName: "猫砂", targetCategory: "日常护理" } // 不应执行
  ])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时应返回原 state（不产生部分写入）")
  assert.ok(result.state.categories.includes("宠物用品"), "原分类应保留")
  const itemAfter = result.state.items.find((i) => i.id === "i1")
  assert.equal(itemAfter.category, "宠物用品", "物品分类应保持原状（moveItem 未执行）")
})

test("action 失败时回滚：moveItem 目标分类不存在 → 后续 updateItemReminder 不执行", () => {
  const item = makeItem("i1", "猫砂", "宠物用品")
  const state = makeState({ items: [item] })
  const plan = planWith([
    { type: "moveItem", itemId: "i1", itemName: "猫砂", targetCategory: "不存在的分类" }, // 失败
    { type: "updateItemReminder", itemId: "i1", itemName: "猫砂", bufferDays: 7 } // 不应执行
  ])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时应返回原 state")
  const itemAfter = result.state.items.find((i) => i.id === "i1")
  assert.equal(itemAfter.bufferDays, 2, "提醒天数应保持原状（updateItemReminder 未执行）")
})

// ---------- applyAgentAction 单元测试 ----------

test("applyAgentAction: renameCategory 单独调用", () => {
  const work = { categories: ["宠物用品"], items: [], settings: {} }
  const links = []
  const result = applyAgentAction(work, { type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }, 1000, links)
  assert.equal(result.ok, true)
  assert.ok(work.categories.includes("猫咪用品"))
  assert.equal(links.length, 1)
})

test("applyAgentAction: renameCategory 原分类不存在 → ok=false", () => {
  const work = { categories: ["宠物用品"], items: [], settings: {} }
  const links = []
  const result = applyAgentAction(work, { type: "renameCategory", oldName: "不存在", newName: "新名" }, 1000, links)
  assert.equal(result.ok, false)
  assert.match(result.summary, /不存在/)
})

test("applyAgentAction: setDefaultPurchaseOption 单独调用", () => {
  const item = {
    ...makeItem("i1", "猫砂"),
    purchaseOptions: [
      makeOpt("o1", "pidan", { isDefault: true }),
      makeOpt("o2", "洁珊")
    ]
  }
  const work = { categories: ["宠物用品"], items: [item], settings: {} }
  const links = []
  const result = applyAgentAction(work, {
    type: "setDefaultPurchaseOption", itemId: "i1", optionId: "o2"
  }, 1000, links)
  assert.equal(result.ok, true)
  assert.equal(work.items[0].purchaseOptions[0].isDefault, false)
  assert.equal(work.items[0].purchaseOptions[1].isDefault, true)
})
