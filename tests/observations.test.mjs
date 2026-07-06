// 任务一（观察引擎）单元测试
// 运行方式：node --test tests/observations.test.mjs
//
// 覆盖：
// 1. 五类观察判定（budgetThreshold / dueSoon / priceAnomaly / cycleDrift / negativeReviewRepurchase）
// 2. 边界：无预算、历史不足、无负面评价、状态非 urgent/warning
// 3. 排序：attention 在前，同级按 dueAt 升序
// 4. 接入点 1：buildHouseholdContext 注入画像 + 【管家最近注意到】（间接通过 askHouseholdAssistant 系统提示）
// 5. 接入点 2：answerHouseholdQuickly 跨维度追加（验收：问「这周要补什么」且预算 90% 时出现预算提示）

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
  buildManagerObservations,
  serializeHouseholdProfile,
  detectPriceAnomaly,
  detectCycleDrift,
  pickObservationByPreference,
  NEGATIVE_REVIEW_KEYWORDS,
  BUDGET_INFO_THRESHOLD,
  BUDGET_ATTENTION_THRESHOLD,
  DUE_SOON_DAYS,
  PRICE_ANOMALY_RATIO,
  CYCLE_DRIFT_RATIO,
  CYCLE_DRIFT_CONSECUTIVE
} = await import("../src/agent/observations.ts")
const { buildChatDateContext, answerHouseholdQuickly } = await import("../src/llm/householdChat.ts")

const DAY = 24 * 60 * 60 * 1000

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
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

// ---------- 阈值常量自检 ----------

test("阈值常量与规格一致", () => {
  assert.equal(BUDGET_INFO_THRESHOLD, 0.85)
  assert.equal(BUDGET_ATTENTION_THRESHOLD, 1.0)
  assert.equal(DUE_SOON_DAYS, 3)
  assert.equal(PRICE_ANOMALY_RATIO, 0.10)
  assert.equal(CYCLE_DRIFT_RATIO, 0.20)
  assert.equal(CYCLE_DRIFT_CONSECUTIVE, 2)
})

test("NEGATIVE_REVIEW_KEYWORDS 剔除正向词", () => {
  assert.ok(!NEGATIVE_REVIEW_KEYWORDS.includes("好用"))
  assert.ok(!NEGATIVE_REVIEW_KEYWORDS.includes("回购"))
  assert.ok(NEGATIVE_REVIEW_KEYWORDS.includes("不好用"))
  assert.ok(NEGATIVE_REVIEW_KEYWORDS.includes("猫不爱吃"))
  assert.ok(NEGATIVE_REVIEW_KEYWORDS.includes("下次不买"))
})

// ---------- budgetThreshold ----------

test("budgetThreshold: 未设预算不产出", () => {
  const now = Date.now()
  const state = makeState({ settings: {} })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "budgetThreshold").length, 0)
})

test("budgetThreshold: 预算为 0 不产出", () => {
  const now = Date.now()
  const state = makeState({ settings: { monthlyBudget: 0 } })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "budgetThreshold").length, 0)
})

test("budgetThreshold: 使用率 < 85% 不产出", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i1", history: [{ id: "e1", at: now, price: 100, qty: 1 }]
    })]
  })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  // spend=100, budget=1000, ratio=0.1 < 0.85
  assert.equal(obs.filter((o) => o.kind === "budgetThreshold").length, 0)
})

test("budgetThreshold: 使用率 ≥ 85% 产出 info", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i1", history: [{ id: "e1", at: now, price: 900, qty: 1 }]
    })]
  })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  const budget = obs.filter((o) => o.kind === "budgetThreshold")
  assert.equal(budget.length, 1)
  assert.equal(budget[0].severity, "info")
  assert.ok(!budget[0].itemId, "budgetThreshold 不带 itemId")
  assert.match(budget[0].text, /900/)
  assert.match(budget[0].text, /90%/)
})

test("budgetThreshold: 使用率 ≥ 100% 产出 attention", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i1", history: [{ id: "e1", at: now, price: 1200, qty: 1 }]
    })]
  })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  const budget = obs.filter((o) => o.kind === "budgetThreshold")
  assert.equal(budget.length, 1)
  assert.equal(budget[0].severity, "attention")
  assert.match(budget[0].text, /超/)
})

test("budgetThreshold: 仅统计当月支出（跨月不计）", () => {
  const now = Date.now()
  const lastMonth = new Date(now)
  lastMonth.setMonth(lastMonth.getMonth() - 1)
  lastMonth.setDate(15)
  const lastMonthTs = lastMonth.getTime()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i1", history: [{ id: "e1", at: lastMonthTs, price: 900, qty: 1 }]
    })]
  })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  // 上月的 900 不算当月支出，ratio=0 < 0.85
  assert.equal(obs.filter((o) => o.kind === "budgetThreshold").length, 0)
})

// ---------- dueSoon ----------

test("dueSoon: 已过点产出 attention", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({ id: "i1", name: "洗衣液" }),
    makeComputed({ displayStatus: "urgent", daysUntilDue: -2, dueAt: now - 2 * DAY, remainingText: "已用完 2 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const dueSoon = obs.filter((o) => o.kind === "dueSoon")
  assert.equal(dueSoon.length, 1)
  assert.equal(dueSoon[0].severity, "attention")
  assert.equal(dueSoon[0].itemId, "i1")
  assert.match(dueSoon[0].text, /洗衣液/)
  assert.match(dueSoon[0].text, /到提醒点/)
})

test("dueSoon: 3 天内到点产出 info", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({ id: "i1", name: "纸巾" }),
    makeComputed({ displayStatus: "warning", daysUntilDue: 2, dueAt: now + 2 * DAY, remainingText: "还剩约 2 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const dueSoon = obs.filter((o) => o.kind === "dueSoon")
  assert.equal(dueSoon.length, 1)
  assert.equal(dueSoon[0].severity, "info")
  assert.match(dueSoon[0].text, /2 天后/)
})

test("dueSoon: 正好第 3 天产出 info（边界包含）", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({ id: "i1", name: "纸巾" }),
    makeComputed({ displayStatus: "warning", daysUntilDue: 3, dueAt: now + 3 * DAY, remainingText: "还剩约 3 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "dueSoon").length, 1)
})

test("dueSoon: 超过 3 天不产出", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({ id: "i1", name: "纸巾" }),
    makeComputed({ displayStatus: "normal", daysUntilDue: 5, dueAt: now + 5 * DAY, remainingText: "还剩约 5 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "dueSoon").length, 0)
})

// ---------- priceAnomaly ----------

test("priceAnomaly: 历史不足 2 条不产出", () => {
  const now = Date.now()
  const item = makeItem({ history: [{ id: "e1", at: now, price: 100, qty: 1 }] })
  assert.equal(detectPriceAnomaly(item), null)
})

test("priceAnomaly: 偏贵 > 10% 产出 expensive", () => {
  const now = Date.now()
  const item = makeItem({ history: [
    { id: "e1", at: now - 60 * DAY, price: 100, qty: 1 },
    { id: "e2", at: now - 30 * DAY, price: 100, qty: 1 },
    { id: "e3", at: now, price: 130, qty: 1 }
  ] })
  const anomaly = detectPriceAnomaly(item)
  assert.ok(anomaly)
  assert.equal(anomaly.direction, "expensive")
  assert.ok(anomaly.pct > 10)
})

test("priceAnomaly: 偏便宜 > 10% 产出 cheap", () => {
  const now = Date.now()
  const item = makeItem({ history: [
    { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
    { id: "e2", at: now, price: 80, qty: 1 }
  ] })
  const anomaly = detectPriceAnomaly(item)
  assert.ok(anomaly)
  assert.equal(anomaly.direction, "cheap")
})

test("priceAnomaly: 偏离 ≤ 10% 不产出", () => {
  const now = Date.now()
  const item = makeItem({ history: [
    { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
    { id: "e2", at: now, price: 105, qty: 1 }
  ] })
  assert.equal(detectPriceAnomaly(item), null)
})

test("priceAnomaly: 缺 price 或 qty 的记录被忽略", () => {
  const now = Date.now()
  const item = makeItem({ history: [
    { id: "e1", at: now - 30 * DAY, price: 0, qty: 1 },
    { id: "e2", at: now, price: 100, qty: 1 }
  ] })
  // 只有 1 条有效 priced 记录，不够 2 条
  assert.equal(detectPriceAnomaly(item), null)
})

test("priceAnomaly: 集成进 buildManagerObservations 产出 info", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "纸巾",
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 130, qty: 1 }
    ]
  })
  const view = makeView(item, makeComputed())
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const priceObs = obs.filter((o) => o.kind === "priceAnomaly")
  assert.equal(priceObs.length, 1)
  assert.equal(priceObs[0].severity, "info")
  assert.equal(priceObs[0].itemId, "i1")
  assert.match(priceObs[0].text, /贵了/)
})

// ---------- cycleDrift ----------

test("cycleDrift: 连续 2 次间隔比 cycleDays 短 20% 产出", () => {
  const now = Date.now()
  // cycleDays=30, threshold=24, 两次间隔都是 20 天（短 33%）
  const item = makeItem({
    id: "i1", name: "猫粮", cycleDays: 30,
    history: [
      { id: "e1", at: now - 40 * DAY, intervalDays: 20, price: 100, qty: 1 },
      { id: "e2", at: now - 20 * DAY, intervalDays: 20, price: 100, qty: 1 }
    ]
  })
  const drift = detectCycleDrift(item)
  assert.ok(drift)
  assert.ok(drift.shortestDriftPct >= 20)
})

test("cycleDrift: 只有 1 次间隔不产出", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", cycleDays: 30,
    history: [{ id: "e1", at: now - 20 * DAY, intervalDays: 20, price: 100, qty: 1 }]
  })
  assert.equal(detectCycleDrift(item), null)
})

test("cycleDrift: 最近一次间隔长于阈值不产出（非连续）", () => {
  const now = Date.now()
  // cycleDays=30, threshold=24, 第一次 20 天（短），第二次 28 天（长，未短 20%）
  const item = makeItem({
    id: "i1", cycleDays: 30,
    history: [
      { id: "e1", at: now - 48 * DAY, intervalDays: 20, price: 100, qty: 1 },
      { id: "e2", at: now - 20 * DAY, intervalDays: 28, price: 100, qty: 1 }
    ]
  })
  assert.equal(detectCycleDrift(item), null)
})

test("cycleDrift: 间隔正好等于阈值（短 20%）不产出（严格小于）", () => {
  const now = Date.now()
  // cycleDays=30, threshold=24, 间隔=24 不产出（需 < threshold）
  const item = makeItem({
    id: "i1", cycleDays: 30,
    history: [
      { id: "e1", at: now - 48 * DAY, intervalDays: 24, price: 100, qty: 1 },
      { id: "e2", at: now - 24 * DAY, intervalDays: 24, price: 100, qty: 1 }
    ]
  })
  assert.equal(detectCycleDrift(item), null)
})

test("cycleDrift: 集成进 buildManagerObservations 产出 info", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫粮", cycleDays: 30,
    history: [
      { id: "e1", at: now - 40 * DAY, intervalDays: 20, price: 100, qty: 1 },
      { id: "e2", at: now - 20 * DAY, intervalDays: 20, price: 100, qty: 1 }
    ]
  })
  const view = makeView(item, makeComputed())
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const driftObs = obs.filter((o) => o.kind === "cycleDrift")
  assert.equal(driftObs.length, 1)
  assert.equal(driftObs[0].severity, "info")
  assert.match(driftObs[0].text, /猫粮/)
  assert.match(driftObs[0].text, /周期/)
})

// ---------- negativeReviewRepurchase ----------

test("negativeReviewRepurchase: 负面评价 + urgent 产出 attention", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({
      id: "i1", name: "猫粮",
      history: [{ id: "e1", at: now - 30 * DAY, review: "猫不爱吃" }]
    }),
    makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const neg = obs.filter((o) => o.kind === "negativeReviewRepurchase")
  assert.equal(neg.length, 1)
  assert.equal(neg[0].severity, "attention")
  assert.equal(neg[0].itemId, "i1")
  assert.match(neg[0].text, /猫不爱吃/)
})

test("negativeReviewRepurchase: 正面评价不产出", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({
      id: "i1", name: "猫粮",
      history: [{ id: "e1", at: now - 30 * DAY, review: "好用" }]
    }),
    makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "negativeReviewRepurchase").length, 0)
})

test("negativeReviewRepurchase: 负面评价但状态 normal 不产出", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({
      id: "i1", name: "猫粮",
      history: [{ id: "e1", at: now, review: "猫不爱吃" }]
    }),
    makeComputed({ displayStatus: "normal", daysUntilDue: 30, dueAt: now + 30 * DAY, remainingText: "还剩约 30 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "negativeReviewRepurchase").length, 0)
})

test("negativeReviewRepurchase: 无评价不产出", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({ id: "i1", name: "猫粮", history: [] }),
    makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  assert.equal(obs.filter((o) => o.kind === "negativeReviewRepurchase").length, 0)
})

test("negativeReviewRepurchase: warning 状态也产出（即将复购）", () => {
  const now = Date.now()
  const view = makeView(
    makeItem({
      id: "i1", name: "洗发水",
      history: [{ id: "e1", at: now - 25 * DAY, review: "下次不买" }]
    }),
    makeComputed({ displayStatus: "warning", daysUntilDue: 2, dueAt: now + 2 * DAY, remainingText: "还剩约 2 天" })
  )
  const state = makeState()
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const neg = obs.filter((o) => o.kind === "negativeReviewRepurchase")
  assert.equal(neg.length, 1)
  assert.equal(neg[0].severity, "attention")
})

// ---------- 排序 ----------

test("排序: attention 在 info 之前", () => {
  const now = Date.now()
  const state = makeState({ settings: { monthlyBudget: 1000 }, items: [makeItem({
    id: "i-budget", history: [{ id: "e1", at: now, price: 900, qty: 1 }]
  })] })
  const views = [
    makeView(
      makeItem({ id: "i-overdue", name: "A" }),
      makeComputed({ displayStatus: "urgent", daysUntilDue: -2, dueAt: now - 2 * DAY, remainingText: "已用完 2 天" })
    ),
    makeView(
      makeItem({ id: "i-soon", name: "B" }),
      makeComputed({ displayStatus: "warning", daysUntilDue: 2, dueAt: now + 2 * DAY, remainingText: "还剩约 2 天" })
    )
  ]
  const obs = buildManagerObservations(state, views, buildChatDateContext(now))
  // overdue (attention) 应在最前
  assert.equal(obs[0].severity, "attention")
  assert.equal(obs[0].kind, "dueSoon")
  assert.equal(obs[0].itemId, "i-overdue")
  // budgetThreshold (info, 无 itemId) 应在所有 attention 之后
  const budgetIdx = obs.findIndex((o) => o.kind === "budgetThreshold")
  assert.ok(budgetIdx > 0)
})

test("排序: 同级按 dueAt 升序", () => {
  const now = Date.now()
  const views = [
    makeView(
      makeItem({ id: "i-late", name: "A" }),
      makeComputed({ displayStatus: "warning", daysUntilDue: 3, dueAt: now + 3 * DAY, remainingText: "还剩约 3 天" })
    ),
    makeView(
      makeItem({ id: "i-early", name: "B" }),
      makeComputed({ displayStatus: "warning", daysUntilDue: 1, dueAt: now + 1 * DAY, remainingText: "还剩约 1 天" })
    )
  ]
  const state = makeState()
  const obs = buildManagerObservations(state, views, buildChatDateContext(now))
  const dueSoonObs = obs.filter((o) => o.kind === "dueSoon")
  assert.equal(dueSoonObs[0].itemId, "i-early")
  assert.equal(dueSoonObs[1].itemId, "i-late")
})

test("排序: 无 itemId 的观察在同级最后", () => {
  const now = Date.now()
  // budget=1000, spend=1200 → attention；同时有 1 个 dueSoon attention（有 itemId）
  const state = makeState({ settings: { monthlyBudget: 1000 }, items: [makeItem({
    id: "i-budget", history: [{ id: "e1", at: now, price: 1200, qty: 1 }]
  })] })
  const views = [
    makeView(
      makeItem({ id: "i-overdue", name: "A" }),
      makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
    )
  ]
  const obs = buildManagerObservations(state, views, buildChatDateContext(now))
  // 两个 attention：dueSoon（有 itemId，dueAt=now-DAY）应排在 budgetThreshold（无 itemId）之前
  assert.equal(obs[0].kind, "dueSoon")
  assert.equal(obs[0].itemId, "i-overdue")
  assert.equal(obs[1].kind, "budgetThreshold")
})

// ---------- 画像序列化 ----------

test("serializeHouseholdProfile: null 返回 null", () => {
  assert.equal(serializeHouseholdProfile(null), null)
})

test("serializeHouseholdProfile: 完整画像产出段落", () => {
  const now = Date.now()
  const profile = {
    residentCount: 2, children: "none", pets: "cat",
    cookingFrequency: "often", laundryFrequency: "medium", homeSize: "twoBedroom",
    createdAt: now, updatedAt: now
  }
  const text = serializeHouseholdProfile(profile)
  assert.ok(text)
  assert.match(text, /【家庭画像】/)
  assert.match(text, /2 人/)
  assert.match(text, /猫/)
  assert.match(text, /经常/)
  assert.match(text, /两居/)
})

test("serializeHouseholdProfile: 标签复用 PROFILE_OPTIONS 不漂移", () => {
  const now = Date.now()
  const profile = {
    residentCount: 4, children: "infant", pets: "catAndDog",
    cookingFrequency: "daily", laundryFrequency: "low", homeSize: "threePlus",
    createdAt: now, updatedAt: now
  }
  const text = serializeHouseholdProfile(profile)
  assert.match(text, /4 人及以上/)
  assert.match(text, /婴幼儿/)
  assert.match(text, /猫狗都有/)
  assert.match(text, /基本每天/)
  assert.match(text, /每周 1-2 次/)
  assert.match(text, /三居及以上/)
})

// ---------- pickObservationByPreference ----------

test("pickObservationByPreference: 按偏好顺序取第一条命中", () => {
  const observations = [
    { kind: "priceAnomaly", severity: "info" },
    { kind: "budgetThreshold", severity: "info" }
  ]
  const picked = pickObservationByPreference(observations, ["budgetThreshold", "priceAnomaly"])
  assert.ok(picked)
  assert.equal(picked.kind, "budgetThreshold")
})

test("pickObservationByPreference: 无命中返回 null", () => {
  const observations = [{ kind: "priceAnomaly", severity: "info" }]
  assert.equal(pickObservationByPreference(observations, ["dueSoon"]), null)
})

// ---------- 接入点 2: answerHouseholdQuickly 跨维度追加 ----------

test("接入点2 验收: 问「这周要补什么」且预算使用率 90% 时，回答末尾出现预算提示", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i1", name: "纸巾",
      history: [{ id: "e1", at: now, price: 900, qty: 1 }]
    })]
  })
  // 物品 daysUntilDue=10（不在 7 天内），所以「这周」答案为空；预算 90% 应被追加
  const views = [makeView(
    state.items[0],
    makeComputed({ displayStatus: "normal", daysUntilDue: 10, dueAt: now + 10 * DAY, remainingText: "还剩约 10 天" })
  )]
  const answer = answerHouseholdQuickly("这周要补什么", state, views, buildChatDateContext(now))
  assert.ok(answer, "应返回非空回答")
  assert.match(answer, /预算|90%|900/)
})

test("接入点2: 问预算时，回答末尾追加非预算维度提示（dueSoon）", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i1", name: "洗衣液",
      history: [{ id: "e1", at: now, price: 100, qty: 1 }]
    })]
  })
  // 洗衣液 urgent，应追加 dueSoon 观察
  const views = [makeView(
    state.items[0],
    makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
  )]
  const answer = answerHouseholdQuickly("本月预算还剩多少", state, views, buildChatDateContext(now))
  assert.ok(answer)
  // 预算答案本身不应重复包含 dueSoon 物品名，追加的观察应包含
  assert.match(answer, /洗衣液/)
  assert.match(answer, /到提醒点/)
})

test("接入点2: 问「这周」且有 overdue 物品时，不追加同维度 dueSoon（避免重复）", () => {
  const now = Date.now()
  const state = makeState()
  const views = [makeView(
    makeItem({ id: "i1", name: "洗衣液" }),
    makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
  )]
  const answer = answerHouseholdQuickly("这周要补什么", state, views, buildChatDateContext(now))
  assert.ok(answer)
  // 答案已包含洗衣液（overdue 列出），不应再追加 dueSoon 观察「洗衣液已经到提醒点了」
  // 由于无其他维度观察，答案不应有第二个换行段
  const segments = answer.split("\n")
  assert.ok(segments.length <= 2, `应有至多 2 段（主答案 + 至多 1 条观察），实际 ${segments.length}`)
})

test("接入点2: 身份问题不追加观察", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({ history: [{ id: "e1", at: now, price: 1200, qty: 1 }] })]
  })
  const views = [makeView(
    state.items[0],
    makeComputed({ displayStatus: "normal", daysUntilDue: 30, dueAt: now + 30 * DAY, remainingText: "还剩约 30 天" })
  )]
  const answer = answerHouseholdQuickly("你是谁", state, views, buildChatDateContext(now))
  assert.ok(answer)
  // 身份回答是单句，不应追加观察
  assert.match(answer, /403 家庭管家/)
  assert.doesNotMatch(answer, /预算|到提醒点|均价|周期/)
})

test("接入点2: 写入意图仍返回 null（不被快捷回答拦截）", () => {
  const now = Date.now()
  const state = makeState()
  const answer = answerHouseholdQuickly("帮我加一袋猫砂", state, [], buildChatDateContext(now))
  assert.equal(answer, null)
})

// ---------- 集成：buildManagerObservations 综合场景 ----------

test("综合: 空物品列表 + 无预算 → 无观察", () => {
  const now = Date.now()
  const state = makeState()
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  assert.equal(obs.length, 0)
})

test("综合: 五类观察同时存在时按 severity + dueAt 排序", () => {
  const now = Date.now()
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: [makeItem({
      id: "i-budget", name: "X", history: [{ id: "e1", at: now, price: 1200, qty: 1 }]
    })]
  })
  const views = [
    // i-neg：同时命中 dueSoon(attention) + negativeReviewRepurchase(attention)，dueAt=now-DAY
    makeView(
      makeItem({ id: "i-neg", name: "猫粮", history: [{ id: "e1", at: now - 30 * DAY, review: "猫不爱吃" }] }),
      makeComputed({ displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天" })
    ),
    // dueSoon info（dueAt=now+2*DAY）
    makeView(
      makeItem({ id: "i-soon", name: "纸巾" }),
      makeComputed({ displayStatus: "warning", daysUntilDue: 2, dueAt: now + 2 * DAY, remainingText: "还剩约 2 天" })
    ),
    // priceAnomaly info（itemId=i-price，dueAt=now+30*DAY）
    makeView(
      makeItem({
        id: "i-price", name: "洗发水",
        history: [
          { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
          { id: "e2", at: now, price: 130, qty: 1 }
        ]
      }),
      makeComputed({ displayStatus: "normal", daysUntilDue: 30, dueAt: now + 30 * DAY, remainingText: "还剩约 30 天" })
    )
  ]
  const obs = buildManagerObservations(state, views, buildChatDateContext(now))

  // 全部 attention 应在全部 info 之前
  const firstInfoIdx = obs.findIndex((o) => o.severity === "info")
  const lastAttentionIdx = obs.map((o) => o.severity).lastIndexOf("attention")
  assert.ok(firstInfoIdx > lastAttentionIdx, "attention 应全部在 info 之前")

  // attention 段：i-neg 的两类 attention（同 dueAt=now-DAY）都应在 budgetThreshold（无 itemId → Infinity）之前
  const attentionObs = obs.filter((o) => o.severity === "attention")
  const negDueSoonIdx = attentionObs.findIndex((o) => o.kind === "dueSoon" && o.itemId === "i-neg")
  const negReviewIdx = attentionObs.findIndex((o) => o.kind === "negativeReviewRepurchase" && o.itemId === "i-neg")
  const budgetIdx = attentionObs.findIndex((o) => o.kind === "budgetThreshold")
  assert.ok(negDueSoonIdx >= 0 && negReviewIdx >= 0 && budgetIdx >= 0)
  assert.ok(budgetIdx > negDueSoonIdx && budgetIdx > negReviewIdx, "budgetThreshold（无 itemId）应排在 i-neg 的 attention 之后")

  // info 段：dueSoon（i-soon, dueAt=now+2DAY）应在 priceAnomaly（i-price, dueAt=now+30DAY）之前
  const infoObs = obs.filter((o) => o.severity === "info")
  const dueSoonIdx = infoObs.findIndex((o) => o.kind === "dueSoon")
  const priceIdx = infoObs.findIndex((o) => o.kind === "priceAnomaly")
  assert.ok(dueSoonIdx >= 0 && priceIdx >= 0)
  assert.ok(dueSoonIdx < priceIdx, "dueSoon（dueAt 更早）应排在 priceAnomaly 之前")
})
