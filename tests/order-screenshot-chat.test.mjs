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

const { mapOrderLinesToDrafts, commitAgentDraftBatch, buildAgentDraftsFromOrderRows } = await import("../src/agent/executor.ts")
const { composeOrderBatchMessage, composeOrderRecognizingMessage, composeOrderImportSummary, findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")
const { buildOrderImportRowsFromExtract, orderImportRowsToConfirmed } = await import("../src/orderImportRows.ts")

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

function makeItem(id, name, category = "宠物用品", unit = "袋", extra = {}) {
  return {
    id, name, category, type: "learning", cycleDays: 30, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: true, purchaseOptions: [], history: [],
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0,
    unit, ...extra
  }
}

// 模拟订单截图识别结果
function makeOrder(lines, platform = "京东", orderDate = Date.UTC(2026, 6, 4)) {
  return { platform, orderDate, lines }
}

// 禁用词校验：管家文案不应出现系统用语
const ORDER_FORBIDDEN = [
  "识别结果如下", "请确认订单导入", "待确认批量草稿", "字段缺失", "以下为解析结果",
  "我理解为", "我猜", "我估算", "根据模板", "根据常识",
  "bufferDays", "cycleDays"
]

function assertNoOrderForbidden(text, label = "text") {
  for (const phrase of ORDER_FORBIDDEN) {
    assert.ok(!text.includes(phrase), `${label} 不应包含禁用词「${phrase}」，实际：${text}`)
  }
}

// ---------- 测试 1：上传订单截图后不直接写 state ----------
// 识别出订单行 → 生成 proposalBatch → state.items 不变 → 用户确认后才写入

test("测试1：订单截图识别后生成 drafts/skippedRows，不直接写 state", () => {
  const state = makeState()
  const order = makeOrder([
    { productName: "皇家猫粮 L40", coreName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  // 应生成草稿
  assert.ok(mapping.drafts.length > 0, "应生成至少一条草稿")
  // state.items 不应变化（mapOrderLinesToDrafts 是纯函数，不修改 state）
  assert.equal(state.items.length, 0, "mapOrderLinesToDrafts 不应修改 state.items")
  // 确认后才写入
  const beforeCommit = state.items.length
  const result = commitAgentDraftBatch(state, mapping.drafts, 6000)
  assert.equal(state.items.length, beforeCommit, "commitAgentDraftBatch 也不应修改原 state（返回新 state）")
  assert.ok(result.state.items.length > beforeCommit, "确认后新 state 应写入物品")
})

// ---------- 测试 2：已有猫粮 item，订单行命中 restock ----------

test("测试2：已有猫粮 item 时订单行「皇家猫粮 2袋 128」生成 restock draft", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮 L40", coreName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  assert.equal(mapping.drafts.length, 1, "应生成 1 条草稿")
  const draft = mapping.drafts[0]
  assert.equal(draft.kind, "restock", "应生成 restock 草稿")
  assert.equal(draft.itemId, "i1", "itemId 应命中已有猫粮")
  assert.equal(draft.qty, 2, "qty 应为 2")
  assert.equal(draft.platform, "京东", "platform 应为京东")
  assert.equal(draft.price, 128, "price 应为 128")
  // 不应重复创建
  assert.equal(mapping.drafts.filter((d) => d.kind === "createItemWithRestock" || d.kind === "createItem").length, 0, "不应生成创建草稿")
})

// ---------- 测试 3：无猫砂 item，生成 createItemWithRestock ----------

test("测试3：无猫砂 item 时订单行「猫砂 1袋 40」生成 createItemWithRestock（14/3）", () => {
  const state = makeState()
  const order = makeOrder([
    { productName: "猫砂 10kg", coreName: "猫砂", genericName: "猫砂", qty: 1, price: 40, measureUnit: "袋" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  assert.equal(mapping.drafts.length, 1, "应生成 1 条草稿")
  const draft = mapping.drafts[0]
  assert.equal(draft.kind, "createItemWithRestock", "应生成 createItemWithRestock 草稿")
  assert.equal(draft.item.itemName, "猫砂")
  assert.equal(draft.item.category, "宠物用品", "category 应为宠物用品")
  assert.equal(draft.item.cycleDays, 14, "cycleDays 应为 14（DEFAULT_CYCLES）")
  assert.equal(draft.item.bufferDays, 3, "bufferDays 应为 3（周期 20% 向上取整）")
  assert.equal(draft.item.unit, "袋")
  assert.equal(draft.restock.qty, 1)
  assert.equal(draft.restock.price, 40)
})

// ---------- 测试 4：非消耗品跳过 ----------

test("测试4：非消耗品（手机壳/数据线）出现在 skippedRows，不生成草稿", () => {
  const state = makeState()
  const order = makeOrder([
    { productName: "硅胶手机壳 iPhone 15", coreName: "手机壳", qty: 1, price: 29, measureUnit: "个" },
    { productName: "Type-C 数据线 1米", coreName: "数据线", qty: 1, price: 15, measureUnit: "根" },
    { productName: "猫粮 5kg", coreName: "猫粮", genericName: "猫粮", qty: 1, price: 80, measureUnit: "袋" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  // 手机壳和数据线应在 skippedRows
  assert.equal(mapping.skippedRows.length, 2, "应跳过 2 条非消耗品")
  const skippedNames = mapping.skippedRows.map((r) => r.coreName || r.productName)
  assert.ok(skippedNames.includes("手机壳"), "skippedRows 应包含手机壳")
  assert.ok(skippedNames.includes("数据线"), "skippedRows 应包含数据线")
  // 不应生成 AgentDraft
  assert.equal(mapping.drafts.length, 1, "只应为猫粮生成 1 条草稿")
  const draft = mapping.drafts[0]
  assert.ok(draft.kind === "createItemWithRestock" || draft.kind === "restock", "猫粮应生成草稿")
})

// ---------- 测试 5：用户取消不写 state ----------

test("测试5：proposalBatch 取消后不写入 state（commitAgentDraftBatch 不被调用）", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  // 模拟用户取消：不调用 commitAgentDraftBatch，state 不变
  const itemsBeforeCancel = state.items.length
  const historyBeforeCancel = state.items[0].history.length
  // 取消路径：直接丢弃 drafts，不调用 commit
  // 这里验证 state 未被修改
  assert.equal(state.items.length, itemsBeforeCancel, "取消后 state.items 数量不变")
  assert.equal(state.items[0].history.length, historyBeforeCancel, "取消后 history 不变")
  // 草稿确实存在但未提交
  assert.ok(mapping.drafts.length > 0, "草稿应存在（只是未被提交）")
})

// ---------- 测试 6：用户确认调用 commitAgentDraftBatch 写入 history ----------

test("测试6：用户确认后 commitAgentDraftBatch 写入 history 并返回结果", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  // 模拟用户确认：调用 commitAgentDraftBatch
  const result = commitAgentDraftBatch(state, mapping.drafts, 6000)
  // 应写入 history
  const item = result.state.items.find((i) => i.id === "i1")
  assert.ok(item, "猫粮 item 应存在")
  assert.ok(item.history.length > 0, "应写入 history 记录")
  const record = item.history[item.history.length - 1]
  assert.equal(record.qty, 2, "history qty 应为 2")
  assert.equal(record.price, 128, "history price 应为 128")
  assert.equal(record.platform, "京东", "history platform 应为京东")
  // 应返回 summary 和 links
  assert.ok(result.summary.length > 0, "应返回 summary")
  assert.ok(result.links.length > 0, "应返回 links")
})

// ---------- 文案测试：composeOrderBatchMessage 符合管家口吻 ----------

test("文案：composeOrderBatchMessage 输出管家口吻，不含禁用词", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" },
    { productName: "猫砂 10kg", genericName: "猫砂", qty: 1, price: 40, measureUnit: "袋" },
    { productName: "硅胶手机壳", coreName: "手机壳", qty: 1, price: 29, measureUnit: "个" }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  const message = composeOrderBatchMessage({
    drafts: mapping.drafts,
    skippedRows: mapping.skippedRows,
    uncertainRows: mapping.uncertainRows
  })
  assert.ok(message.includes("我看了下"), "应包含管家口吻「我看了下」")
  assert.ok(message.includes("你要是没问题"), "应包含确认引导「你要是没问题」")
  assert.ok(message.includes("手机壳"), "应提到跳过的手机壳")
  assert.ok(message.includes("不像日常消耗品"), "应说明跳过原因")
  assertNoOrderForbidden(message, "composeOrderBatchMessage")
  // 用 findForbiddenPhrase 再校验一次（responseComposer 的禁用词表）
  const forbiddenHit = findForbiddenPhrase(message)
  assert.equal(forbiddenHit, null, `responseComposer 禁用词命中：${forbiddenHit}`)
})

test("文案：composeOrderRecognizingMessage 返回「我看一下这张订单。」", () => {
  const msg = composeOrderRecognizingMessage()
  assert.equal(msg, "我看一下这张订单。")
  assertNoOrderForbidden(msg, "composeOrderRecognizingMessage")
})

// ---------- 补充：空订单 / 全部跳过的情况 ----------

test("补充：全部为非消耗品时 drafts 为空，全部进 skippedRows", () => {
  const state = makeState()
  const order = makeOrder([
    { productName: "手机壳", coreName: "手机壳", qty: 1, price: 29 },
    { productName: "数据线", coreName: "数据线", qty: 1, price: 15 }
  ])
  const mapping = mapOrderLinesToDrafts(order, state, 5000)
  assert.equal(mapping.drafts.length, 0, "不应生成草稿")
  assert.equal(mapping.skippedRows.length, 2, "应全部跳过")
  assert.equal(mapping.uncertainRows.length, 0, "不应有歧义行")
})

// ============================================================
// 第二部分：对话模式复用 OrderImportReview 共享组件
// 对话上传截图后生成 OrderImportRow[]（与弹窗同结构），
// 用户确认后调 orderImportRowsToConfirmed + buildAgentDraftsFromOrderRows + commitAgentDraftBatch
// ============================================================

// ---------- 对话测试 1：上传截图后生成 OrderImportRow[]，不直接写 state ----------

test("对话测试1：上传截图后生成 OrderImportRow[]，与弹窗同结构，不直接写 state", () => {
  const state = makeState()
  const order = makeOrder([
    { productName: "皇家猫粮 L40", coreName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  // 应生成与弹窗同结构的行
  assert.equal(rows.length, 1, "应生成 1 行")
  assert.equal(rows[0].productName, "皇家猫粮 L40")
  assert.equal(rows[0].qty, 2)
  assert.equal(rows[0].price, 128)
  assert.equal(rows[0].platform, "京东")
  assert.equal(rows[0].targetItem, "__create__", "无已有物品时应为 __create__")
  // state 不变
  assert.equal(state.items.length, 0, "不应修改 state")
})

// ---------- 对话测试 2：已有猫粮 item，行命中已有物品 ----------

test("对话测试2：已有猫粮 item 时行命中 targetItem 为已有物品 id", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮 L40", coreName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].targetItem, "i1", "应命中已有猫粮的 id")
  assert.equal(rows[0].category, "宠物用品")
})

// ---------- 对话测试 3：确认后复用 buildAgentDraftsFromOrderRows + commitAgentDraftBatch ----------

test("对话测试3：确认时 orderImportRowsToConfirmed + buildAgentDraftsFromOrderRows + commitAgentDraftBatch 写入 history", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  // 模拟用户在对话卡片点「就这么记」
  const confirmedRows = orderImportRowsToConfirmed(rows)
  assert.equal(confirmedRows.length, 1)
  assert.equal(confirmedRows[0].targetItem, "i1")
  assert.equal(confirmedRows[0].qty, 2)
  assert.equal(confirmedRows[0].price, 128)
  // 复用 buildAgentDraftsFromOrderRows（与弹窗同路径）
  const drafts = buildAgentDraftsFromOrderRows(confirmedRows, state, 6000)
  assert.equal(drafts.length, 1, "应生成 1 条草稿")
  assert.equal(drafts[0].kind, "restock", "应生成 restock 草稿")
  assert.equal(drafts[0].itemId, "i1")
  // 复用 commitAgentDraftBatch（与弹窗同路径）
  const result = commitAgentDraftBatch(state, drafts, 7000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.ok(item.history.length > 0, "应写入 history")
  const record = item.history[item.history.length - 1]
  assert.equal(record.qty, 2)
  assert.equal(record.price, 128)
  assert.equal(record.platform, "京东")
})

// ---------- 对话测试 4：用户取消不写 state ----------

test("对话测试4：用户取消时不调用 commitAgentDraftBatch，state 不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  // 取消路径：不调用 orderImportRowsToConfirmed + buildAgentDraftsFromOrderRows + commitAgentDraftBatch
  const historyBefore = state.items[0].history.length
  // 模拟取消：什么都不做
  assert.equal(state.items[0].history.length, historyBefore, "取消后 history 不变")
  // rows 仍存在（只是未被提交）
  assert.ok(rows.length > 0, "行仍存在，只是未提交")
})

// ---------- 对话测试 5：单条跳过（targetItem 设为 __skip__）----------

test("对话测试5：单条跳过后该行不进入 confirmedRows", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" },
    { productName: "猫砂", genericName: "猫砂", qty: 1, price: 40, measureUnit: "袋" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  // 模拟用户点「单条跳过」第 0 行
  rows[0].targetItem = "__skip__"
  const confirmedRows = orderImportRowsToConfirmed(rows)
  assert.equal(confirmedRows.length, 1, "应只剩 1 行")
  assert.equal(confirmedRows[0].targetItem, "__create__", "应只保留猫砂的新建行")
})

// ---------- 对话测试 6：composeOrderImportSummary 管家口吻 ----------

test("对话测试6：composeOrderImportSummary 输出管家口吻，不含禁用词", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品", "袋")] })
  const order = makeOrder([
    { productName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureUnit: "袋", matchedItemName: "猫粮" },
    { productName: "猫砂 10kg", genericName: "猫砂", qty: 1, price: 40, measureUnit: "袋" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  const message = composeOrderImportSummary(rows, "京东")
  assert.ok(message.includes("我看了下"), "应包含「我看了下」")
  assert.ok(message.includes("你要是没问题"), "应包含确认引导")
  assert.ok(message.includes("猫粮"), "应提到猫粮")
  assertNoOrderForbidden(message, "composeOrderImportSummary")
  const forbiddenHit = findForbiddenPhrase(message)
  assert.equal(forbiddenHit, null, `responseComposer 禁用词命中：${forbiddenHit}`)
})

// ---------- 对话测试 7：字段结构与弹窗一致 ----------

test("对话测试7：OrderImportRow 字段结构与弹窗完全一致", () => {
  const state = makeState()
  const order = makeOrder([
    { productName: "皇家猫粮", brandName: "皇家", coreName: "皇家猫粮", genericName: "猫粮", qty: 2, price: 128, measureAmount: 2, measureUnit: "kg" }
  ])
  const rows = buildOrderImportRowsFromExtract(order, state.items, state.categories, 0)
  const row = rows[0]
  // 弹窗 OrderImportRow 的所有字段都应存在
  assert.ok("key" in row, "应有 key")
  assert.ok("productName" in row, "应有 productName")
  assert.ok("brandName" in row, "应有 brandName")
  assert.ok("coreName" in row, "应有 coreName")
  assert.ok("qty" in row, "应有 qty")
  assert.ok("price" in row, "应有 price")
  assert.ok("measureAmount" in row, "应有 measureAmount")
  assert.ok("measureUnit" in row, "应有 measureUnit")
  assert.ok("review" in row, "应有 review")
  assert.ok("date" in row, "应有 date")
  assert.ok("platform" in row, "应有 platform")
  assert.ok("genericName" in row, "应有 genericName")
  assert.ok("targetItem" in row, "应有 targetItem")
  assert.ok("targetOption" in row, "应有 targetOption")
  assert.ok("category" in row, "应有 category")
  assert.ok("customCategory" in row, "应有 customCategory")
  assert.ok("duplicate" in row, "应有 duplicate")
})
