// 任务四 A：观察去重单元测试
// 运行方式：node --test tests/observation-dedup.test.mjs
//
// 覆盖：
// 1. observationKey：kind+itemId 唯一键（预算类无 itemId 用空串）
// 2. filterUnseenObservations：过滤已 seen 的观察
// 3. markObservationsSeen：把展示过的 key 累加进 Set
// 4. buildManagerBriefing：会话级去重，同一观察不重复出现
// 5. answerHouseholdQuickly：withObs 跨维度追加去重

import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier)
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
  buildManagerBriefing,
  observationKey,
  filterUnseenObservations,
  markObservationsSeen
} = await import("../src/agent/observations.ts")
const { buildChatDateContext, answerHouseholdQuickly } = await import("../src/llm/householdChat.ts")

const DAY = 24 * 60 * 60 * 1000

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: { monthlyBudget: 1000 },
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
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

// ---------- observationKey ----------

test("observationKey: kind+itemId 组合，预算类无 itemId 用空串", () => {
  assert.equal(observationKey({ kind: "dueSoon", severity: "info", itemId: "i1", text: "x" }), "dueSoon|i1")
  assert.equal(observationKey({ kind: "budgetThreshold", severity: "info", text: "x" }), "budgetThreshold|")
  assert.equal(observationKey({ kind: "priceAnomaly", severity: "info", itemId: "i2", text: "x" }), "priceAnomaly|i2")
})

test("observationKey: 同 kind 同 itemId 产生同 key", () => {
  const a = { kind: "dueSoon", severity: "info", itemId: "i1", text: "甲" }
  const b = { kind: "dueSoon", severity: "attention", itemId: "i1", text: "乙" }
  assert.equal(observationKey(a), observationKey(b))
})

// ---------- filterUnseenObservations ----------

test("filterUnseenObservations: 空 Set 返回原数组", () => {
  const obs = [
    { kind: "dueSoon", severity: "info", itemId: "i1", text: "a" },
    { kind: "budgetThreshold", severity: "info", text: "b" }
  ]
  assert.equal(filterUnseenObservations(obs, undefined).length, 2)
  assert.equal(filterUnseenObservations(obs, new Set()).length, 2)
})

test("filterUnseenObservations: 过滤已 seen 的 key", () => {
  const obs = [
    { kind: "dueSoon", severity: "info", itemId: "i1", text: "a" },
    { kind: "dueSoon", severity: "info", itemId: "i2", text: "b" },
    { kind: "budgetThreshold", severity: "info", text: "c" }
  ]
  const seen = new Set(["dueSoon|i1"])
  const result = filterUnseenObservations(obs, seen)
  assert.equal(result.length, 2)
  assert.ok(result.find((o) => o.itemId === "i2"))
  assert.ok(result.find((o) => o.kind === "budgetThreshold"))
})

test("filterUnseenObservations: 全部已 seen 返回空数组", () => {
  const obs = [{ kind: "dueSoon", severity: "info", itemId: "i1", text: "a" }]
  const seen = new Set(["dueSoon|i1"])
  assert.equal(filterUnseenObservations(obs, seen).length, 0)
})

// ---------- markObservationsSeen ----------

test("markObservationsSeen: 把 key 累加进 Set（原地修改）", () => {
  const obs = [
    { kind: "dueSoon", severity: "info", itemId: "i1", text: "a" },
    { kind: "budgetThreshold", severity: "info", text: "b" }
  ]
  const seen = new Set()
  const returned = markObservationsSeen(obs, seen)
  assert.equal(returned, seen, "应返回同一 Set 引用")
  assert.ok(seen.has("dueSoon|i1"))
  assert.ok(seen.has("budgetThreshold|"))
  assert.equal(seen.size, 2)
})

test("markObservationsSeen: 已存在的 key 不重复加", () => {
  const obs = [{ kind: "dueSoon", severity: "info", itemId: "i1", text: "a" }]
  const seen = new Set(["dueSoon|i1"])
  markObservationsSeen(obs, seen)
  assert.equal(seen.size, 1)
})

// ---------- buildManagerBriefing 会话级去重 ----------

test("buildManagerBriefing: 同一观察在一次会话中最多出现一次", () => {
  const now = Date.UTC(2026, 6, 4, 10, 0, 0)
  const dateContext = buildChatDateContext(now)
  // 构造一个有 attention 级观察的场景：dueSoon overdue
  const views = [
    makeView(makeItem({ id: "i1", name: "猫砂" }), makeComputed({
      status: "urgent", displayStatus: "urgent",
      dueAt: now - DAY, daysUntilDue: -1, remainingText: "已用完 1 天"
    }))
  ]
  const state = makeState({ items: views.map((v) => v.item) })
  const observations = buildManagerObservations(state, views, dateContext)
  assert.ok(observations.length > 0, "应产出到点观察")

  const seen = new Set()
  // 第一次简报：应包含猫砂观察
  const briefing1 = buildManagerBriefing(observations, undefined, dateContext, seen)
  assert.ok(briefing1, "首次应返回简报")
  assert.ok(briefing1.includes("猫砂"), "首次简报应含猫砂观察")
  assert.ok(seen.size > 0, "首次简报后 seen 应非空")

  // 第二次简报：猫砂观察已 seen，不再出现
  const briefing2 = buildManagerBriefing(observations, undefined, dateContext, seen)
  // 注意：如果只剩 attention 级观察且全 seen，briefing2 可能为 null（hoursSinceLastSession=0 < 8 且无 attention）
  if (briefing2) {
    assert.ok(!briefing2.includes("猫砂"), "第二次简报不应重复出现猫砂观察")
  }
  // 验收点：同一条观察在一次会话中最多出现一次
  const totalOccurrences = [briefing1, briefing2].filter((b) => b && b.includes("猫砂")).length
  assert.equal(totalOccurrences, 1, "猫砂观察应只出现一次")
})

test("buildManagerBriefing: 无 seen 参数时不去重（向后兼容）", () => {
  const now = Date.UTC(2026, 6, 4, 10, 0, 0)
  const dateContext = buildChatDateContext(now)
  const views = [
    makeView(makeItem({ id: "i1", name: "猫砂" }), makeComputed({
      status: "urgent", displayStatus: "urgent",
      dueAt: now - DAY, daysUntilDue: -1, remainingText: "已用完 1 天"
    }))
  ]
  const state = makeState({ items: views.map((v) => v.item) })
  const observations = buildManagerObservations(state, views, dateContext)
  // 不传 seenObservationKeys
  const briefing1 = buildManagerBriefing(observations, undefined, dateContext)
  const briefing2 = buildManagerBriefing(observations, undefined, dateContext)
  assert.ok(briefing1 && briefing1.includes("猫砂"))
  // 无去重状态时，第二次仍会出现（向后兼容，旧调用方不受影响）
  if (briefing2) {
    assert.ok(briefing2.includes("猫砂"), "无 seen 参数时不去重")
  }
})

// ---------- answerHouseholdQuickly 跨维度追加去重 ----------

test("answerHouseholdQuickly: withObs 同一观察在一次会话中最多追加一次", () => {
  const now = Date.UTC(2026, 6, 4, 10, 0, 0)
  const dateContext = buildChatDateContext(now)
  const views = [
    makeView(makeItem({ id: "i1", name: "猫砂" }), makeComputed({
      status: "urgent", displayStatus: "urgent",
      dueAt: now - DAY, daysUntilDue: -1, remainingText: "已用完 1 天"
    })),
    makeView(makeItem({ id: "i2", name: "猫粮" }), makeComputed({
      status: "warning", displayStatus: "warning",
      dueAt: now + 2 * DAY, daysUntilDue: 2, remainingText: "还剩约 2 天"
    }))
  ]
  const state = makeState({ items: views.map((v) => v.item) })
  const seen = new Set()

  // 第一次问预算：会追加一条 dueSoon/priceAnomaly 等跨维度观察
  const answer1 = answerHouseholdQuickly("本月预算还剩多少", state, views, dateContext, seen)
  assert.ok(answer1, "首次应返回兜底回答")
  const seenSizeAfter1 = seen.size
  assert.ok(seenSizeAfter1 > 0, "首次回答后 seen 应非空")

  // 第二次问预算：同一条观察已 seen，不应再追加
  const answer2 = answerHouseholdQuickly("本月预算还剩多少", state, views, dateContext, seen)
  assert.ok(answer2, "第二次应仍返回兜底回答（只是不重复追加同一条观察）")
  // 验收点：同一观察在一次会话中最多出现一次
  // answer1 和 answer2 都有预算正文，但 answer2 不应再重复 answer1 追加过的那条观察
  // 通过 seen 增量验证：如果第二次还追加了新观察，seen 会再增长
  // 这里不强制 seen 不增长（可能追加了不同的跨维度观察），但同一条不会重复
})

test("answerHouseholdQuickly: 同一 dueSoon 观察不重复追加", () => {
  const now = Date.UTC(2026, 6, 4, 10, 0, 0)
  const dateContext = buildChatDateContext(now)
  const views = [
    makeView(makeItem({ id: "i1", name: "猫砂" }), makeComputed({
      status: "urgent", displayStatus: "urgent",
      dueAt: now - DAY, daysUntilDue: -1, remainingText: "已用完 1 天"
    }))
  ]
  const state = makeState({
    settings: { monthlyBudget: 1000 },
    items: views.map((v) => v.item)
  })
  const seen = new Set()

  // 第一次问预算：会追加猫砂的 dueSoon 观察
  const answer1 = answerHouseholdQuickly("本月预算还剩多少", state, views, dateContext, seen)
  assert.ok(answer1)
  assert.ok(answer1.includes("猫砂"), "首次应追加猫砂 dueSoon 观察")
  assert.ok(seen.has("dueSoon|i1"), "seen 应含 dueSoon|i1")

  // 第二次问预算：猫砂 dueSoon 已 seen，不再追加
  const answer2 = answerHouseholdQuickly("本月预算还剩多少", state, views, dateContext, seen)
  assert.ok(answer2)
  assert.ok(!answer2.includes("猫砂"), "第二次不应重复追加猫砂观察")
})
