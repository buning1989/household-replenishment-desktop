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

const { commitAgentDraft, commitAgentDraftBatch, buildAgentDraftsFromOrderRows } = await import("../src/agent/executor.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["厨房", "卫生间", "洗衣清洁", "日常护理", "宠物用品", "母婴用品", "其他"],
    items: [],
    settings: {},
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
    unit: "件", ...extra
  }
}

// ---------- commitAgentDraft 单条 ----------

test("commitAgentDraft: createItem 写入新物品并附带链接", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加一个洗发水", state)
  const result = commitAgentDraft(state, draft, 1000)
  assert.equal(result.state.items.length, 1)
  assert.equal(result.state.items[0].name, "洗发水")
  assert.match(result.summary, /已创建/)
  assert.ok(result.links.some((link) => link.target.kind === "item"))
})

test("commitAgentDraft: 已有同名物品时「帮我加一个洗发水」走 restock 不重复创建", () => {
  const state = makeState({ items: [makeItem("i1", "洗发水", "日常护理")] })
  const draft = buildLocalDraftFromText("帮我加一个洗发水", state)
  // 库里已存在时本地 parser 应识别为 restock，避免重复创建
  assert.equal(draft?.kind, "restock")
  const result = commitAgentDraft(state, draft, 1000)
  assert.equal(result.state.items.length, 1, "不应新增物品")
  assert.match(result.summary, /已记录|补货/)
})

test("commitAgentDraft: restock 写入 history 记录", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { unit: "袋" })] })
  const draft = { kind: "restock", itemId: "i1", itemName: "猫粮", qty: 2, unit: "袋", price: 128, platform: "京东" }
  const result = commitAgentDraft(state, draft, 2000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 1)
  assert.equal(item.history[0].qty, 2)
  assert.equal(item.history[0].price, 128)
  assert.equal(item.history[0].platform, "京东")
  assert.match(result.summary, /已记录/)
})

test("commitAgentDraft: createItemWithRestock 创建并补货", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("买了两袋猫粮花了128", state)
  const result = commitAgentDraft(state, draft, 3000)
  assert.equal(result.state.items.length, 1)
  assert.equal(result.state.items[0].history.length, 1)
  assert.match(result.summary, /已创建并记录/)
})

test("commitAgentDraft: addPurchaseOption 写入常购商品", () => {
  const state = makeState({ items: [makeItem("i1", "卷纸", "卫生间", { unit: "卷" })] })
  const draft = { kind: "addPurchaseOption", itemId: "i1", itemName: "卷纸", productName: "维达超韧", unit: "卷" }
  const result = commitAgentDraft(state, draft, 4000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.purchaseOptions.length, 1)
  assert.equal(item.purchaseOptions[0].productName, "维达超韧")
})

test("commitAgentDraft: 确认前不修改原 state", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加一个洗发水", state)
  const result = commitAgentDraft(state, draft, 1000)
  assert.equal(state.items.length, 0, "原 state 不应被修改")
  assert.equal(result.state.items.length, 1)
})

// ---------- commitAgentDraftBatch 批量 ----------

test("commitAgentDraftBatch: 多条草稿共享工作区一次性写入", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { unit: "袋" })] })
  const drafts = [
    { kind: "restock", itemId: "i1", itemName: "猫粮", qty: 1, price: 64, platform: "京东" },
    buildLocalDraftFromText("买了两包猫砂花了80", state)
  ]
  const result = commitAgentDraftBatch(state, drafts, 5000)
  // 第一条补货到已有猫粮；第二条新建猫砂并补货
  const catFood = result.state.items.find((i) => i.name === "猫粮")
  const catLitter = result.state.items.find((i) => i.name === "猫砂")
  assert.ok(catFood, "猫粮应存在")
  assert.ok(catLitter, "猫砂应被新建")
  assert.equal(catFood.history.length, 1)
  assert.ok(catLitter.history.length >= 1)
  assert.ok(result.summary.includes("\n"), "批量小结应包含多条")
})

test("commitAgentDraftBatch: 空数组不写入", () => {
  const state = makeState()
  const result = commitAgentDraftBatch(state, [], 1000)
  assert.equal(result.state.items.length, 0)
  assert.equal(result.summary, "")
})

test("commitAgentDraftBatch: 某条找不到物品只跳过该条不阻塞其他", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品")] })
  const drafts = [
    { kind: "restock", itemId: "不存在的id", itemName: "不存在的物品", qty: 1 },
    { kind: "restock", itemId: "i1", itemName: "猫粮", qty: 1, price: 60 }
  ]
  const result = commitAgentDraftBatch(state, drafts, 6000)
  const catFood = result.state.items.find((i) => i.name === "猫粮")
  assert.ok(catFood, "猫粮仍应被补货")
  assert.equal(catFood.history.length, 1)
  assert.match(result.summary, /没有记录补货/) // 第一条的跳过小结
})

test("commitAgentDraftBatch: 确认前不修改原 state", () => {
  const state = makeState()
  const drafts = [buildLocalDraftFromText("帮我加一个洗发水", state)]
  const result = commitAgentDraftBatch(state, drafts, 1000)
  assert.equal(state.items.length, 0, "原 state 不应被修改")
  assert.equal(result.state.items.length, 1)
})

// ---------- buildAgentDraftsFromOrderRows 订单导入转换 ----------

test("buildAgentDraftsFromOrderRows: __skip__ 行被跳过", () => {
  const state = makeState()
  const rows = [
    { productName: "猫粮", qty: 2, price: 128, platform: "京东", targetItem: "__skip__", targetOption: "", category: "宠物用品" },
    { productName: "猫砂", qty: 1, price: 40, platform: "京东", targetItem: "__create__", targetOption: "", category: "宠物用品" }
  ]
  const drafts = buildAgentDraftsFromOrderRows(rows, state, 1000)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].kind, "createItemWithRestock")
})

test("buildAgentDraftsFromOrderRows: 命中已有物品生成 restock", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { unit: "袋" })] })
  const rows = [
    { productName: "皇家猫粮", coreName: "猫粮", qty: 2, price: 128, platform: "京东", targetItem: "i1", targetOption: "", category: "宠物用品" }
  ]
  const drafts = buildAgentDraftsFromOrderRows(rows, state, 1000)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].kind, "restock")
  assert.equal(drafts[0].itemId, "i1")
  assert.equal(drafts[0].qty, 2)
  assert.equal(drafts[0].price, 128)
})

test("buildAgentDraftsFromOrderRows: __create__ 生成 createItemWithRestock", () => {
  const state = makeState()
  const rows = [
    { productName: "猫砂", coreName: "猫砂", qty: 1, price: 40, platform: "京东", targetItem: "__create__", targetOption: "", category: "宠物用品" }
  ]
  const drafts = buildAgentDraftsFromOrderRows(rows, state, 1000)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].kind, "createItemWithRestock")
  assert.equal(drafts[0].item.itemName, "猫砂")
  assert.equal(drafts[0].item.category, "宠物用品")
})

test("buildAgentDraftsFromOrderRows: qty<=0 被跳过", () => {
  const state = makeState()
  const rows = [
    { productName: "猫砂", qty: 0, targetItem: "__create__", targetOption: "", category: "宠物用品" }
  ]
  const drafts = buildAgentDraftsFromOrderRows(rows, state, 1000)
  assert.equal(drafts.length, 0)
})

test("buildAgentDraftsFromOrderRows: 转换后经 commitAgentDraftBatch 写入不另写一套", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", { unit: "袋" })] })
  const rows = [
    { productName: "皇家猫粮", coreName: "猫粮", qty: 2, price: 128, platform: "京东", targetItem: "i1", targetOption: "", category: "宠物用品" },
    { productName: "猫砂", coreName: "猫砂", qty: 1, price: 40, platform: "京东", targetItem: "__create__", targetOption: "", category: "宠物用品" }
  ]
  const drafts = buildAgentDraftsFromOrderRows(rows, state, 7000)
  const result = commitAgentDraftBatch(state, drafts, 7000)
  const catFood = result.state.items.find((i) => i.name === "猫粮")
  const catLitter = result.state.items.find((i) => i.name === "猫砂")
  assert.equal(catFood.history.length, 1)
  assert.ok(catLitter)
  assert.equal(state.items.length, 1, "原 state 不变")
})

test("buildAgentDraftsFromOrderRows: 评价/规格字段透传到草稿", () => {
  const state = makeState()
  const rows = [
    { productName: "猫砂", coreName: "猫砂", qty: 1, price: 40, platform: "京东", targetItem: "__create__", targetOption: "", category: "宠物用品", review: "好用", measureAmount: 5, measureUnit: "kg" }
  ]
  const drafts = buildAgentDraftsFromOrderRows(rows, state, 1000)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].restock.review, "好用")
  assert.equal(drafts[0].restock.purchaseMeasureAmount, 5)
  assert.equal(drafts[0].restock.purchaseMeasureUnit, "kg")
})
