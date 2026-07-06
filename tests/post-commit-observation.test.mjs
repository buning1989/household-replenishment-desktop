// 任务四（写入后观察）单元测试
// 运行方式：node --test tests/post-commit-observation.test.mjs
//
// 覆盖：
// 1. buildPostCommitObservation: 高价补货命中 priceAnomaly
// 2. buildPostCommitObservation: 正常价格无命中
// 3. buildPostCommitObservation: 周期漂移命中 cycleDrift
// 4. buildPostCommitObservation: 会话级去重（同条观察不重复返回）
// 5. buildPostCommitObservation: 历史不足不命中
// 6. commitAgentDraft: 高价补货确认后 result.observation 含价格提示
// 7. commitAgentDraft: 正常价格确认后 result.observation 为 undefined
// 8. commitAgentDraft: 不传 dateContext 时 observation 为 undefined（向后兼容）

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

const { buildPostCommitObservation, observationKey } = await import("../src/agent/observations.ts")
const { commitAgentDraft } = await import("../src/agent/executor.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")

const DAY = 24 * 60 * 60 * 1000

function makeItem(overrides = {}) {
  return {
    id: "i1",
    name: "猫砂",
    category: "宠物用品",
    type: "learning",
    cycleDays: 30,
    bufferDays: 2,
    lastRestockedAt: 1,
    anchorEstimated: false,
    purchaseOptions: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    unit: "袋",
    ...overrides
  }
}

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
    updatedAt: 1,
    ...overrides
  }
}

// ---------- buildPostCommitObservation: priceAnomaly ----------

test("buildPostCommitObservation: 高价补货命中 priceAnomaly", () => {
  const now = Date.now()
  // 历史均价 100，本次 130（用户视角贵 30%；算法 avg 含本次记录 = 110，pct=18%，超 10% 阈值）
  const item = makeItem({
    history: [
      { id: "e1", at: now - 60 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e3", at: now, price: 130, qty: 1 }
    ]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.ok(obs, "高价应命中观察")
  assert.equal(obs.kind, "priceAnomaly")
  assert.equal(obs.severity, "info")
  assert.match(obs.text, /猫砂/)
  assert.match(obs.text, /贵了/)
  assert.match(obs.text, /18%/)
})

test("buildPostCommitObservation: 正常价格无命中", () => {
  const now = Date.now()
  // 均价 100，本次 105（偏离 5%，未超 10% 阈值）
  const item = makeItem({
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 105, qty: 1 }
    ]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.equal(obs, null, "正常价格不应命中")
})

test("buildPostCommitObservation: 偏便宜也命中", () => {
  const now = Date.now()
  // 均价 100，本次 80（便宜 20%，超 10% 阈值）
  const item = makeItem({
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 80, qty: 1 }
    ]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.ok(obs, "偏便宜应命中")
  assert.equal(obs.kind, "priceAnomaly")
  assert.match(obs.text, /便宜了/)
})

test("buildPostCommitObservation: 历史不足 2 条不命中", () => {
  const now = Date.now()
  const item = makeItem({
    history: [{ id: "e1", at: now, price: 100, qty: 1 }]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.equal(obs, null, "历史不足 2 条不应命中")
})

// ---------- buildPostCommitObservation: cycleDrift ----------

test("buildPostCommitObservation: 周期漂移命中 cycleDrift", () => {
  const now = Date.now()
  // cycleDays=30, threshold=24, 连续 2 次间隔 20 天（短 33%）
  const item = makeItem({
    cycleDays: 30,
    history: [
      { id: "e1", at: now - 40 * DAY, intervalDays: 20, price: 100, qty: 1 },
      { id: "e2", at: now - 20 * DAY, intervalDays: 20, price: 100, qty: 1 },
      { id: "e3", at: now, intervalDays: 20, price: 100, qty: 1 }
    ]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.ok(obs, "周期漂移应命中")
  assert.equal(obs.kind, "cycleDrift")
  assert.match(obs.text, /猫砂/)
  assert.match(obs.text, /周期/)
})

test("buildPostCommitObservation: 周期正常不命中 cycleDrift", () => {
  const now = Date.now()
  // cycleDays=30, 间隔 28 天（未短 20%）
  const item = makeItem({
    cycleDays: 30,
    history: [
      { id: "e1", at: now - 56 * DAY, intervalDays: 28, price: 100, qty: 1 },
      { id: "e2", at: now - 28 * DAY, intervalDays: 28, price: 100, qty: 1 },
      { id: "e3", at: now, intervalDays: 28, price: 100, qty: 1 }
    ]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.equal(obs, null, "周期正常不应命中")
})

// ---------- buildPostCommitObservation: 会话级去重 ----------

test("buildPostCommitObservation: 同条观察在一次会话中最多返回一次", () => {
  const now = Date.now()
  const item = makeItem({
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 130, qty: 1 }
    ]
  })
  const seen = new Set()
  const dateContext = buildChatDateContext(now)

  // 第一次调用：应返回观察
  const obs1 = buildPostCommitObservation(item, dateContext, seen)
  assert.ok(obs1, "第一次应返回观察")
  assert.equal(obs1.kind, "priceAnomaly")

  // 第二次调用：同条观察已 seen，不应返回
  const obs2 = buildPostCommitObservation(item, dateContext, seen)
  assert.equal(obs2, null, "第二次不应返回相同观察")
})

test("buildPostCommitObservation: 无 seenKeys 参数时不做去重（向后兼容）", () => {
  const now = Date.now()
  const item = makeItem({
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 130, qty: 1 }
    ]
  })
  const dateContext = buildChatDateContext(now)

  // 不传 seenKeys：每次都应返回
  const obs1 = buildPostCommitObservation(item, dateContext)
  const obs2 = buildPostCommitObservation(item, dateContext)
  assert.ok(obs1)
  assert.ok(obs2, "不传 seenKeys 时不去重")
})

// ---------- buildPostCommitObservation: 不暴露禁用词 ----------

test("buildPostCommitObservation: 观察文案不含禁用词", () => {
  const now = Date.now()
  const item = makeItem({
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 130, qty: 1 }
    ]
  })
  const obs = buildPostCommitObservation(item, buildChatDateContext(now))
  assert.ok(obs)
  assert.equal(findForbiddenPhrase(obs.text), null)
})

// ---------- commitAgentDraft 集成 ----------

test("commitAgentDraft: 高价补货确认后 result.observation 含价格提示", () => {
  const now = Date.now()
  // 已有 2 次历史均价 100
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋",
    history: [
      { id: "e1", at: now - 60 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now - 30 * DAY, price: 100, qty: 1 }
    ]
  })
  const state = makeState({ items: [item] })
  // 本次补货价格 130（贵 30%，超 15% 阈值）
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 130,
    restockDate: now
  }
  const result = commitAgentDraft(state, draft, now, buildChatDateContext(now))
  assert.ok(result.observation, "高价补货应产出 observation")
  assert.match(result.observation, /猫砂/)
  assert.match(result.observation, /贵了/)
})

test("commitAgentDraft: 正常价格确认后 result.observation 为 undefined", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋", cycleDays: 14,
    history: [
      { id: "e1", at: now - 60 * DAY, price: 100, qty: 1, intervalDays: 30 },
      { id: "e2", at: now - 30 * DAY, price: 100, qty: 1, intervalDays: 30 }
    ]
  })
  const state = makeState({ items: [item] })
  // 本次补货价格 105（偏离 5%，正常）；间隔 30 天 > cycleDays*0.8=11.2，不触发 cycleDrift
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 105,
    restockDate: now
  }
  const result = commitAgentDraft(state, draft, now, buildChatDateContext(now))
  assert.equal(result.observation, undefined, "正常价格不应产出 observation")
})

test("commitAgentDraft: 不传 dateContext 时 observation 为 undefined（向后兼容）", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋",
    history: [
      { id: "e1", at: now - 30 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now, price: 130, qty: 1 }
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 130,
    restockDate: now
  }
  // 不传 dateContext 和 seenObservationKeys（旧调用方式）
  const result = commitAgentDraft(state, draft, now)
  assert.equal(result.observation, undefined, "不传 dateContext 时不应产出 observation")
  // summary 和 links 仍正常
  assert.ok(result.summary)
  assert.ok(result.links.length > 0)
})

test("commitAgentDraft: observation 接入会话级去重", () => {
  const now = Date.now()
  // history 间隔 30 天 = cycleDays，不触发 cycleDrift；避免干扰 priceAnomaly 的去重验证
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋", cycleDays: 30,
    history: [
      { id: "e1", at: now - 60 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now - 30 * DAY, price: 100, qty: 1 }
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 130,
    restockDate: now
  }
  const seen = new Set()
  const dateContext = buildChatDateContext(now)

  // 第一次确认：应产出 priceAnomaly observation
  const state1 = commitAgentDraft(state, draft, now, dateContext, seen)
  assert.ok(state1.observation, "第一次应产出 observation")
  assert.match(state1.observation, /贵了/, "第一次应是 priceAnomaly")

  // 第二次确认（模拟同会话再次补货同物品，价格仍偏高）：
  // 由于 priceAnomaly 的 key 是 kind+itemId，已 seen，不应再产出
  const state2 = commitAgentDraft(state1.state, draft, now + 1000, dateContext, seen)
  assert.equal(state2.observation, undefined, "同条观察在同会话中不应重复产出")
})

test("commitAgentDraft: createItem 草稿不产出 observation（无 restock）", () => {
  const now = Date.now()
  const state = makeState()
  const draft = {
    kind: "createItem",
    itemName: "新物品",
    category: "其他",
    cycleDays: 30,
    bufferDays: 2,
    unit: "件"
  }
  const result = commitAgentDraft(state, draft, now, buildChatDateContext(now))
  assert.equal(result.observation, undefined, "createItem 草稿不应产出 observation")
})

test("commitAgentDraft: createItemWithRestock 草稿可产出 observation", () => {
  const now = Date.now()
  const state = makeState()
  // 第一次创建并补货：历史不足 2 条，priceAnomaly 不命中
  const draft1 = {
    kind: "createItemWithRestock",
    item: {
      kind: "createItem",
      itemName: "猫砂",
      category: "宠物用品",
      cycleDays: 30,
      bufferDays: 2,
      unit: "袋"
    },
    restock: {
      qty: 1,
      unit: "袋",
      price: 100,
      restockDate: now
    }
  }
  const result1 = commitAgentDraft(state, draft1, now, buildChatDateContext(now))
  assert.equal(result1.observation, undefined, "历史不足 2 条不应命中")

  // 第二次补货（高价）：历史有 2 条，应命中
  const draft2 = {
    kind: "restock",
    itemId: result1.state.items[0].id,
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 150,
    restockDate: now + 1000
  }
  const result2 = commitAgentDraft(result1.state, draft2, now + 1000, buildChatDateContext(now + 1000))
  assert.ok(result2.observation, "高价补货应命中")
  assert.match(result2.observation, /贵了/)
})

// ---------- 验收点：录入单价高于均价 15% 的补货并确认 ----------

test("验收: 录入单价高于均价 15% 的补货并确认，结果消息含价格提示", () => {
  const now = Date.now()
  // 历史均价 100/袋
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋", cycleDays: 30,
    history: [
      { id: "e1", at: now - 60 * DAY, price: 100, qty: 1 },
      { id: "e2", at: now - 30 * DAY, price: 100, qty: 1 }
    ]
  })
  const state = makeState({ items: [item] })
  // 本次补货单价 130（用户视角贵 30%，高于均价 15%；算法 avg 含本次 = 110，pct=18%，超 10% 阈值）
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 130,
    restockDate: now
  }
  const result = commitAgentDraft(state, draft, now, buildChatDateContext(now))
  assert.ok(result.observation, "高于均价 15% 应产出价格提示")
  assert.match(result.observation, /猫砂/)
  assert.match(result.observation, /贵了/)
  // summary 仍正常
  assert.match(result.summary, /已记录/)
  // 拼接后的完整消息
  const fullMessage = `${result.summary} ${result.observation}`
  assert.match(fullMessage, /已记录/)
  assert.match(fullMessage, /贵了/)
})

test("验收: 正常价格补货无附加提示", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋", cycleDays: 14,
    history: [
      { id: "e1", at: now - 60 * DAY, price: 100, qty: 1, intervalDays: 30 },
      { id: "e2", at: now - 30 * DAY, price: 100, qty: 1, intervalDays: 30 }
    ]
  })
  const state = makeState({ items: [item] })
  // 本次补货单价 102（偏离 2%，正常）；间隔 30 天 > cycleDays*0.8=11.2，不触发 cycleDrift
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 102,
    restockDate: now
  }
  const result = commitAgentDraft(state, draft, now, buildChatDateContext(now))
  assert.equal(result.observation, undefined, "正常价格不应有附加提示")
  assert.match(result.summary, /已记录/)
})
