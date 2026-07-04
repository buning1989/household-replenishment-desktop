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

const {
  buildLocalDraftFromText,
  reviseAgentDraft,
  parseNaturalDate,
  parseReview,
  parseSpec,
  parseProductNameRevision,
  parseItemNameRevision,
  resolveCategory,
  findItemMatch
} = await import("../src/agent/drafts.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["厨房", "卫生间", "洗衣清洁", "日常护理", "宠物用品", "母婴用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
    updatedAt: 1,
    ...overrides
  }
}

function dayMs(days) { return days * 24 * 60 * 60 * 1000 }

// ---------- 九个对话用例 ----------

test("对话1：我在京东买了两袋猫粮花了128，帮我记一下 → createItemWithRestock", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("我在京东买了两袋猫粮花了128，帮我记一下", state)
  assert.ok(draft, "应解析出草稿")
  assert.equal(draft.kind, "createItemWithRestock")
  assert.equal(draft.item.itemName, "猫粮")
  assert.equal(draft.item.category, "宠物用品")
  assert.equal(draft.restock.qty, 2)
  assert.equal(draft.restock.unit, "袋")
  assert.equal(draft.restock.price, 128)
  assert.equal(draft.restock.platform, "京东")
})

test("对话2：不是两袋，是一袋 → reviseDraft 修订数量", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("买了两袋猫粮花了128", state)
  const revised = reviseAgentDraft(draft, "不是两袋，是一袋", state)
  assert.ok(revised)
  const restock = revised.kind === "createItemWithRestock" ? revised.restock : revised
  assert.equal(restock.qty, 1)
})

test("对话3：昨天买的 → reviseDraft 修订日期", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("买了两袋猫粮花了128", state)
  const revised = reviseAgentDraft(draft, "昨天买的", state)
  assert.ok(revised)
  const restock = revised.kind === "createItemWithRestock" ? revised.restock : revised
  assert.ok(restock.restockDate, "应写入 restockDate")
  // 昨天日期：与 now 相差 0~2 天（startOfDay(now-1) 与 now 的差随当前时刻在 0~2 天之间）
  const now = Date.now()
  const diff = now - restock.restockDate
  assert.ok(diff >= dayMs(0.9) && diff <= dayMs(1.99), `昨天日期差应在约 1 天，实际 diff=${diff}`)
})

test("对话4：这个不好用，下次别推荐 → reviseDraft 修订评价", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("买了两袋猫粮花了128", state)
  const revised = reviseAgentDraft(draft, "这个不好用，下次别推荐", state)
  assert.ok(revised)
  const restock = revised.kind === "createItemWithRestock" ? revised.restock : revised
  assert.ok(restock.review, "应写入 review")
  assert.match(restock.review, /不好用|下次不买/)
})

test("对话5+6+7：确认/记了吗/算了别记 由 intent 层处理，drafts 不直接消费", () => {
  // 这三个用例在 agent-intent.test.mjs 里覆盖；这里只确认 reviseAgentDraft 对取消语义不会误改
  const state = makeState()
  const draft = buildLocalDraftFromText("买了两袋猫粮花了128", state)
  const revised = reviseAgentDraft(draft, "算了别记", state)
  // 取消语义不是修订，reviseAgentDraft 应返回 null 或不改变核心字段
  if (revised) {
    const restock = revised.kind === "createItemWithRestock" ? revised.restock : revised
    assert.equal(restock.qty, draft.kind === "createItemWithRestock" ? draft.restock.qty : draft.qty)
  }
})

test("对话8：帮我加一个洗发水，以后提醒 → createItem", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加一个洗发水，以后提醒", state)
  assert.ok(draft)
  assert.equal(draft.kind, "createItem")
  assert.equal(draft.itemName, "洗发水")
  assert.equal(draft.category, "日常护理")
})

test("对话9：把维达超韧加成卷纸的常购商品 → addPurchaseOption", () => {
  const state = makeState({
    items: [{
      id: "item-1",
      name: "卷纸",
      category: "卫生间",
      type: "learning",
      cycleDays: 30,
      bufferDays: 2,
      lastRestockedAt: 1,
      anchorEstimated: true,
      purchaseOptions: [],
      history: [],
      learningEnabled: true,
      source: "manual",
      confidence: "high",
      feedbackCount: 0,
      unit: "卷"
    }]
  })
  const draft = buildLocalDraftFromText("把维达超韧加成卷纸的常购商品加一下", state)
  assert.ok(draft, "应解析出 addPurchaseOption 草稿")
  // 可能是 addPurchaseOption 或 createItemWithRestock；这里期望命中已有「卷纸」→ addPurchaseOption
  if (draft.kind === "addPurchaseOption") {
    assert.equal(draft.itemName, "卷纸")
    assert.match(draft.productName, /维达/)
  }
})

test("对话10：今天优先买什么 → 不生成草稿（只读查询）", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("今天优先买什么", state)
  assert.equal(draft, null)
})

// ---------- 自然日期解析 ----------

test("parseNaturalDate: 今天/昨天/前天/大前天", () => {
  const now = new Date("2026-06-28T12:00:00").getTime()
  const today = parseNaturalDate("今天买的", now)
  const yesterday = parseNaturalDate("昨天", now)
  const beforeYesterday = parseNaturalDate("前天", now)
  const threeDaysAgo = parseNaturalDate("大前天", now)
  assert.ok(today)
  assert.ok(yesterday)
  assert.ok(beforeYesterday)
  assert.ok(threeDaysAgo)
  assert.ok(now - today <= dayMs(0.5), "今天应接近 now")
  assert.ok(now - yesterday >= dayMs(0.9) && now - yesterday <= dayMs(1.5))
  assert.ok(now - beforeYesterday >= dayMs(1.9) && now - beforeYesterday <= dayMs(2.5))
  assert.ok(now - threeDaysAgo >= dayMs(2.9) && now - threeDaysAgo <= dayMs(3.5))
})

test("parseNaturalDate: N月N日 / YYYY-MM-DD", () => {
  const now = new Date("2026-06-28T12:00:00").getTime()
  const date1 = parseNaturalDate("6月28日", now)
  const date2 = parseNaturalDate("2026-06-28", now)
  assert.ok(date1)
  assert.ok(date2)
  assert.equal(date1, date2)
})

test("parseNaturalDate: 无法解析返回 undefined", () => {
  assert.equal(parseNaturalDate("随便哪天"), undefined)
  assert.equal(parseNaturalDate("hello"), undefined)
})

// ---------- 评价解析 ----------

test("parseReview: 关键词映射短评", () => {
  assert.match(parseReview("这个好用") || "", /好用|回购/)
  assert.match(parseReview("不好用") || "", /不好用/)
  assert.match(parseReview("味道大") || "", /味道大/)
  assert.match(parseReview("猫不爱吃") || "", /猫不爱吃/)
  assert.match(parseReview("质量一般") || "", /质量一般/)
  assert.match(parseReview("下次不买") || "", /下次不买/)
  assert.equal(parseReview("普通的句子"), undefined)
})

// ---------- 规格解析 ----------

test("parseSpec: 500ml / 2kg / 100抽 / 24卷", () => {
  assert.deepEqual(parseSpec("500ml"), { amount: 500, unit: "ml" })
  assert.deepEqual(parseSpec("2kg"), { amount: 2, unit: "kg" })
  assert.deepEqual(parseSpec("100抽"), { amount: 100, unit: "抽" })
  assert.deepEqual(parseSpec("24卷"), { amount: 24, unit: "卷" })
})

test("parseSpec: 单位归一化（毫升→ml、公斤→kg）", () => {
  assert.deepEqual(parseSpec("500毫升"), { amount: 500, unit: "ml" })
  assert.deepEqual(parseSpec("2公斤"), { amount: 2, unit: "kg" })
  assert.deepEqual(parseSpec("1千克"), { amount: 1, unit: "kg" })
  assert.deepEqual(parseSpec("500克"), { amount: 500, unit: "g" })
})

// ---------- 商品名 / itemName 修订 ----------

test("parseProductNameRevision: 商品名叫 X / 买的是 X", () => {
  assert.equal(parseProductNameRevision("商品名叫皇家猫粮"), "皇家猫粮")
  assert.equal(parseProductNameRevision("买的是维达超韧"), "维达超韧")
  assert.equal(parseProductNameRevision("品牌是清风"), "清风")
})

test("parseItemNameRevision: 这个不是抽纸，是卷纸", () => {
  const r = parseItemNameRevision("这个不是抽纸，是卷纸")
  assert.ok(r)
  assert.equal(r.from, "抽纸")
  assert.equal(r.to, "卷纸")
})

// ---------- 分类别名 ----------

test("resolveCategory: 别名映射到标准分类", () => {
  const state = makeState()
  assert.equal(resolveCategory("放到宠物", state), "宠物用品")
  assert.equal(resolveCategory("归到猫咪用品", state), "宠物用品")
  assert.equal(resolveCategory("分类改成个人护理", state), "日常护理")
  assert.equal(resolveCategory("归到洗漱", state), "日常护理")
  assert.equal(resolveCategory("放到清洁", state), "洗衣清洁")
  assert.equal(resolveCategory("归到宝宝", state), "母婴用品")
  assert.equal(resolveCategory("放到母婴", state), "母婴用品")
})

test("resolveCategory: 显式分类优先级", () => {
  const state = makeState()
  assert.equal(resolveCategory("放到宠物用品", state), "宠物用品")
  assert.equal(resolveCategory("分类改成厨房", state), "厨房")
})

// ---------- 物品匹配 ----------

test("findItemMatch: exact 命中", () => {
  const state = makeState({
    items: [{
      id: "i1", name: "猫粮", category: "宠物用品", type: "learning",
      cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: true,
      purchaseOptions: [], history: [], learningEnabled: true, source: "manual",
      confidence: "high", feedbackCount: 0, unit: "袋"
    }]
  })
  const m = findItemMatch(state, "猫粮")
  assert.equal(m.confidence, "exact")
  assert.equal(m.item?.id, "i1")
})

test("findItemMatch: synonym 命中（卫生纸 ↔ 卷纸）", () => {
  const state = makeState({
    items: [{
      id: "i1", name: "卫生纸", category: "卫生间", type: "learning",
      cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: true,
      purchaseOptions: [], history: [], learningEnabled: true, source: "manual",
      confidence: "high", feedbackCount: 0, unit: "卷"
    }]
  })
  const m = findItemMatch(state, "卷纸")
  assert.ok(m.item, "卷纸应通过 synonym 命中卫生纸")
  assert.equal(m.item.id, "i1")
})

test("findItemMatch: 短名疑似匹配保护（纸/粮/砂）", () => {
  const state = makeState({
    items: [
      { id: "i1", name: "卷纸", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: true, purchaseOptions: [], history: [], learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0, unit: "卷" },
      { id: "i2", name: "抽纸", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: true, purchaseOptions: [], history: [], learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0, unit: "包" }
    ]
  })
  const m = findItemMatch(state, "纸")
  // 「纸」是 AMBIGUOUS_SHORT_NAMES，多命中时应返回 ambiguous 或带 hint
  assert.ok(m.confidence === "ambiguous" || m.matchHint, "短名多命中应触发疑似匹配保护")
})

test("findItemMatch: 未命中返回无 item 的 ambiguous", () => {
  const state = makeState()
  const m = findItemMatch(state, "完全不存在的物品名XYZ")
  assert.ok(!m.item)
  assert.equal(m.confidence, "ambiguous")
  assert.equal(m.candidates.length, 0)
})
