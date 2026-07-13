// 任务四 A：buildQueryFacts 单元测试
// 运行方式：node --test tests/queryFacts.test.mjs
//
// 覆盖：
// 1. 检测各类查询事实类型（identity / budget / thisWeek / nextWeek / today / missingInfo / priceAnomaly）
// 2. 本周/下周窗口严格区分（修复时间窗口 bug 的核心验收点）
// 3. 数字必须取自事实段（格式校验）
// 4. 写入意图返回 null

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
  buildQueryFacts,
  detectQueryFactType,
  partitionByWindow,
  buildChatDateContext
} = await import("../src/llm/householdChat.ts")

const DAY = 24 * 60 * 60 * 1000

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: { monthlyBudget: 1000 },
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function makeItem(overrides = {}) {
  return {
    id: "i1",
    name: "测试物品",
    category: "其他",
    type: "learning",
    cycleDays: 30,
    bufferDays: 2,
    lastRestockedAt: 1,
    anchorEstimated: false,
    purchaseOptions: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeView(item, computed) {
  return { item, computed }
}

function makeComputed(overrides = {}) {
  return {
    status: "normal",
    displayStatus: "normal",
    statusLabel: "充足",
    dueAt: Date.now() + 30 * DAY,
    depletionAt: Date.now() + 30 * DAY,
    daysUntilDue: 30,
    daysUntilDepletion: 30,
    isDue: false,
    isSnoozed: false,
    remainingText: "还剩约 30 天",
    statusText: "充足",
    ...overrides
  }
}

// ---------- detectQueryFactType ----------

test("detectQueryFactType: 写入意图返回 null", () => {
  assert.equal(detectQueryFactType("帮我加一袋猫砂"), null)
  assert.equal(detectQueryFactType("买了两袋猫粮"), null)
  assert.equal(detectQueryFactType("记一笔"), null)
  assert.equal(detectQueryFactType("新建一个物品"), null)
})

test("detectQueryFactType: 身份问题", () => {
  assert.equal(detectQueryFactType("你是谁"), "identity")
  assert.equal(detectQueryFactType("你能做什么"), "identity")
  assert.equal(detectQueryFactType("介绍下自己"), "identity")
})

test("detectQueryFactType: 预算问题", () => {
  assert.equal(detectQueryFactType("本月预算还剩多少"), "budget")
  assert.equal(detectQueryFactType("花了多少"), "budget")
})

test("detectQueryFactType: 本周/下周严格区分", () => {
  assert.equal(detectQueryFactType("这周可能要补什么"), "thisWeek")
  assert.equal(detectQueryFactType("本周有什么要补的"), "thisWeek")
  assert.equal(detectQueryFactType("一周内要补什么"), "thisWeek")
  assert.equal(detectQueryFactType("下周有什么要补充的么"), "nextWeek")
  assert.equal(detectQueryFactType("未来一周要补什么"), "nextWeek")
  assert.equal(detectQueryFactType("未来7天"), "nextWeek")
  assert.equal(detectQueryFactType("未来七天"), "nextWeek")
})

test("detectQueryFactType: 今日优先", () => {
  assert.equal(detectQueryFactType("今天优先补什么"), "today")
  assert.equal(detectQueryFactType("现在急需要买什么"), "today")
})

test("detectQueryFactType: 缺失信息", () => {
  assert.equal(detectQueryFactType("哪些信息还缺"), "missingInfo")
  assert.equal(detectQueryFactType("信息缺失"), "missingInfo")
})

test("detectQueryFactType: 价格异常", () => {
  assert.equal(detectQueryFactType("价格异常"), "priceAnomaly")
  assert.equal(detectQueryFactType("均价偏贵"), "priceAnomaly")
})

// ---------- partitionByWindow ----------

test("partitionByWindow: 三窗口互斥且按 dueAt 排序", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "逾期" }), makeComputed({ dueAt: now - DAY, daysUntilDue: -1 })),
    makeView(makeItem({ id: "i2", name: "本周" }), makeComputed({ dueAt: now + 3 * DAY, daysUntilDue: 3 })),
    makeView(makeItem({ id: "i3", name: "下周" }), makeComputed({ dueAt: now + 10 * DAY, daysUntilDue: 10 })),
    makeView(makeItem({ id: "i4", name: "远期" }), makeComputed({ dueAt: now + 30 * DAY, daysUntilDue: 30 }))
  ]
  const { overdue, thisWeek, nextWeek } = partitionByWindow(views)
  assert.equal(overdue.length, 1)
  assert.equal(overdue[0].item.id, "i1")
  assert.equal(thisWeek.length, 1)
  assert.equal(thisWeek[0].item.id, "i2")
  assert.equal(nextWeek.length, 1)
  assert.equal(nextWeek[0].item.id, "i3")
})

// ---------- buildQueryFacts: 核心验收（本周/下周区分） ----------

test("buildQueryFacts: 这周与下周返回不同内容（修复 bug 核心验收点）", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "洗衣液" }), makeComputed({
      dueAt: now + 3 * DAY, daysUntilDue: 3, remainingText: "还剩约 3 天"
    })),
    makeView(makeItem({ id: "i2", name: "猫粮" }), makeComputed({
      dueAt: now + 10 * DAY, daysUntilDue: 10, remainingText: "还剩约 10 天"
    }))
  ]
  const state = makeState({ items: views.map((v) => v.item) })
  const dateContext = buildChatDateContext(now)

  const thisWeekFacts = buildQueryFacts("这周可能要补什么", state, views, dateContext)
  const nextWeekFacts = buildQueryFacts("下周有什么要补充的么", state, views, dateContext)

  assert.ok(thisWeekFacts !== null, "这周事实不应为 null")
  assert.ok(nextWeekFacts !== null, "下周事实不应为 null")

  // 这周应包含洗衣液（daysUntilDue=3），不含猫粮
  assert.ok(thisWeekFacts.includes("洗衣液"), "这周事实应包含洗衣液")
  assert.ok(!thisWeekFacts.includes("猫粮"), "这周事实不应包含猫粮")
  assert.ok(thisWeekFacts.includes("今天起 7 天内"))

  // 下周应包含猫粮（daysUntilDue=10），不含洗衣液
  assert.ok(nextWeekFacts.includes("猫粮"), "下周事实应包含猫粮")
  assert.ok(!nextWeekFacts.includes("洗衣液"), "下周事实不应包含洗衣液")
  assert.ok(nextWeekFacts.includes("8-14 天内"))

  // 两次回答内容不同
  assert.notEqual(thisWeekFacts, nextWeekFacts, "这周与下周事实内容必须不同")
})

test("buildQueryFacts: 这周包含已到提醒点物品", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "逾期物品" }), makeComputed({
      dueAt: now - DAY, daysUntilDue: -1, remainingText: "已用完 1 天"
    }))
  ]
  const state = makeState()
  const facts = buildQueryFacts("这周要补什么", state, views, buildChatDateContext(now))
  assert.ok(facts.includes("逾期物品"))
  assert.ok(facts.includes("已到提醒点"))
})

test("buildQueryFacts: 下周不包含已到提醒点和本周物品", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "逾期物品" }), makeComputed({ dueAt: now - DAY, daysUntilDue: -1 })),
    makeView(makeItem({ id: "i2", name: "本周物品" }), makeComputed({ dueAt: now + 3 * DAY, daysUntilDue: 3 })),
    makeView(makeItem({ id: "i3", name: "下周物品" }), makeComputed({ dueAt: now + 10 * DAY, daysUntilDue: 10 }))
  ]
  const state = makeState()
  const facts = buildQueryFacts("下周要补什么", state, views, buildChatDateContext(now))
  assert.ok(!facts.includes("逾期物品"))
  assert.ok(!facts.includes("本周物品"))
  assert.ok(facts.includes("下周物品"))
})

test("buildQueryFacts: 下周无物品时返回无", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "本周物品" }), makeComputed({ dueAt: now + 3 * DAY, daysUntilDue: 3 }))
  ]
  const state = makeState()
  const facts = buildQueryFacts("下周要补什么", state, views, buildChatDateContext(now))
  assert.ok(facts.includes("8-14 天到提醒点：无"))
})

// ---------- buildQueryFacts: 其他类型 ----------

test("buildQueryFacts: 身份问题返回管家概览", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "物品1" }), makeComputed({ displayStatus: "urgent" })),
    makeView(makeItem({ id: "i2", name: "物品2" }), makeComputed({ displayStatus: "warning" })),
    makeView(makeItem({ id: "i3", name: "物品3" }), makeComputed({ displayStatus: "normal" }))
  ]
  const state = makeState()
  const facts = buildQueryFacts("你是谁", state, views, buildChatDateContext(now))
  assert.ok(facts.includes("提问类型：identity"))
  assert.ok(facts.includes("管理物品数：3 项"))
  assert.ok(facts.includes("急需补货：1 项"))
  assert.ok(facts.includes("快用完：1 项"))
})

test("buildQueryFacts: 预算问题返回预算数字", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({ id: "i1", history: [{ id: "e1", at: now, price: 900, qty: 1 }] })]
  })
  const facts = buildQueryFacts("本月预算还剩多少", state, [], buildChatDateContext(now))
  assert.ok(facts.includes("¥1000"))
  assert.ok(facts.includes("¥900"))
  assert.ok(facts.includes("90%"))
})

test("buildQueryFacts: 未设预算时返回未设置", () => {
  const now = Date.now()
  const state = makeState({ settings: {} })
  const facts = buildQueryFacts("预算多少", state, [], buildChatDateContext(now))
  assert.ok(facts.includes("未设置"))
})

test("buildQueryFacts: 今日优先返回 urgent + warning", () => {
  const now = Date.now()
  const views = [
    makeView(makeItem({ id: "i1", name: "urgent物品" }), makeComputed({
      displayStatus: "urgent", dueAt: now - DAY, daysUntilDue: -1, remainingText: "已用完"
    })),
    makeView(makeItem({ id: "i2", name: "warning物品" }), makeComputed({
      displayStatus: "warning", dueAt: now + 3 * DAY, daysUntilDue: 3, remainingText: "还剩约 3 天"
    }))
  ]
  const state = makeState()
  const facts = buildQueryFacts("今天优先补什么", state, views, buildChatDateContext(now))
  assert.ok(facts.includes("urgent物品"))
  assert.ok(facts.includes("warning物品"))
})

test("buildQueryFacts: 缺失信息分组返回", () => {
  const views = [
    makeView(makeItem({ id: "i1", name: "无价格物品" }), makeComputed()),
    makeView(makeItem({
      id: "i2", name: "有价格物品",
      history: [{ id: "e1", at: 1, price: 10, qty: 1, platform: "京东", review: "还行" }],
      purchaseOptions: [{ id: "p1", productName: "某商品", unit: "件", platform: "京东", review: "还行" }],
      platform: "京东"
    }), makeComputed())
  ]
  const state = makeState()
  const facts = buildQueryFacts("哪些信息还缺", state, views, buildChatDateContext())
  assert.ok(facts.includes("无价格物品"))
  assert.ok(!facts.includes("有价格物品"))
})

test("buildQueryFacts: 价格异常返回偏离百分比", () => {
  const views = [
    makeView(makeItem({
      id: "i1", name: "猫砂",
      history: [
        { id: "e1", at: 1, price: 100, qty: 10 },
        { id: "e2", at: 2, price: 150, qty: 10 }
      ]
    }), makeComputed())
  ]
  const state = makeState()
  const facts = buildQueryFacts("价格异常", state, views, buildChatDateContext())
  assert.ok(facts.includes("猫砂"))
  assert.ok(facts.includes("贵了"))
})

// ---------- 格式约束 ----------

test("buildQueryFacts: 事实段以【本地计算的事实】开头", () => {
  const facts = buildQueryFacts("你是谁", makeState(), [], buildChatDateContext())
  assert.ok(facts.startsWith("【本地计算的事实】"))
  assert.ok(facts.includes("不得自行推算或编造"))
})

test("buildQueryFacts: 写入意图返回 null", () => {
  assert.equal(buildQueryFacts("帮我加一袋猫砂", makeState(), [], buildChatDateContext()), null)
  assert.equal(buildQueryFacts("买了两袋猫粮", makeState(), [], buildChatDateContext()), null)
})

test("buildQueryFacts: 无法识别的查询返回 null", () => {
  assert.equal(buildQueryFacts("今天天气怎么样", makeState(), [], buildChatDateContext()), null)
})
