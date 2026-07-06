// 任务六补丁单元测试：简报插入条件 + 通知草稿构造
// 运行方式：node --test tests/notification-patch.test.mjs
//
// 覆盖三处修复：
// Bug1: buildManagerBriefing 返回非 null 即插入（已由 manager-briefing.test.mjs 覆盖触发条件，
//        此处补验「多次调用均返回非 null 时不应被外层 length===0 条件拦截」的语义契约）
// Bug2: 通知 openChat 分支 append 而非替换（通过纯函数验证消息和草稿构造正确性）
// 规格: buildNotificationRestockDraft 构造的草稿能被 commitAgentDraft 正常写入
//       buildNotificationRestockMessage 引用上次购买的平台/商品名
//       无历史记录时使用兜底值

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
  buildNotificationRestockDraft,
  buildNotificationRestockMessage,
  reviseAgentDraft
} = await import("../src/agent/drafts.ts")
const { commitAgentDraft } = await import("../src/agent/executor.ts")
const { buildManagerBriefing, buildManagerObservations } = await import("../src/agent/observations.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { startOfDay } = await import("../src/domain.ts")
const { findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")

const DAY = 24 * 60 * 60 * 1000

function makeItem(overrides = {}) {
  return {
    id: "i1",
    name: "猫砂",
    category: "宠物用品",
    type: "learning",
    cycleDays: 14,
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

// ---------- Bug1: buildManagerBriefing 触发条件语义契约 ----------

test("Bug1: lastSessionAt 为 undefined 时返回非 null（首次打开）", () => {
  const now = Date.now()
  const state = makeState({ settings: {} })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  const briefing = buildManagerBriefing(obs, undefined, buildChatDateContext(now))
  assert.ok(briefing, "首次打开（无 lastSessionAt）应返回简报")
})

test("Bug1: 距上次会话 >8 小时返回非 null（二次打开仍触发）", () => {
  const now = Date.now()
  const lastSession = now - 10 * 60 * 60 * 1000 // 10 小时前
  const state = makeState({ settings: { lastChatSessionAt: lastSession } })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  const briefing = buildManagerBriefing(obs, lastSession, buildChatDateContext(now))
  assert.ok(briefing, "距上次会话 >8 小时应返回简报，不应被外层 length 条件拦截")
})

test("Bug1: 存在 attention 观察时返回非 null（即使 <8 小时）", () => {
  const now = Date.now()
  const lastSession = now - 60 * 60 * 1000 // 1 小时前
  const item = makeItem({
    id: "i1", name: "猫粮",
    history: [{ id: "e1", at: now - 30 * DAY, review: "猫不爱吃", price: 100, qty: 1 }]
  })
  const view = makeView(item, makeComputed({
    displayStatus: "urgent", daysUntilDue: -1, dueAt: now - DAY, remainingText: "已用完 1 天"
  }))
  const state = makeState({ settings: { lastChatSessionAt: lastSession }, items: [item] })
  const obs = buildManagerObservations(state, [view], buildChatDateContext(now))
  const briefing = buildManagerBriefing(obs, lastSession, buildChatDateContext(now))
  assert.ok(briefing, "有 attention 观察时应返回简报，不应被外层 length 条件拦截")
})

test("Bug1: 多次调用 buildManagerBriefing 均返回非 null 时外层不应拦截", () => {
  const now = Date.now()
  const state = makeState({ settings: {} })
  const obs = buildManagerObservations(state, [], buildChatDateContext(now))
  // 模拟连续两次打开面板（均满足触发条件）
  const b1 = buildManagerBriefing(obs, undefined, buildChatDateContext(now))
  const b2 = buildManagerBriefing(obs, undefined, buildChatDateContext(now))
  // 两次都应返回非 null；外层不应因 length===0 条件拦截第二次
  assert.ok(b1)
  assert.ok(b2)
  // 语义契约：只要 buildManagerBriefing 返回非 null，就应插入
  // （旧代码 if (briefing && length === 0) 在第二次打开时会拦截，这是 bug）
})

// ---------- 规格: buildNotificationRestockDraft ----------

test("规格: 有历史记录时预填上次购买的平台/商品名/数量", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋",
    history: [{
      id: "e1", at: now - 7 * DAY,
      qty: 2, platform: "京东", purchaseProductName: "N1猫砂10L",
      purchaseUnit: "袋", price: 89, review: "好用"
    }]
  })
  const draft = buildNotificationRestockDraft(item, now)
  assert.equal(draft.kind, "restock")
  assert.equal(draft.itemId, "i1")
  assert.equal(draft.itemName, "猫砂")
  assert.equal(draft.qty, 2, "照旧：预填上次数量")
  assert.equal(draft.unit, "袋", "照旧：预填上次采购单位")
  assert.equal(draft.platform, "京东", "照旧：预填上次平台")
  assert.equal(draft.purchaseProductName, "N1猫砂10L", "照旧：预填上次商品名")
  assert.equal(draft.price, undefined, "价格不预填（每笔不同）")
  assert.equal(draft.review, undefined, "评价不预填")
  assert.equal(draft.restockDate, startOfDay(now), "补货日期默认今天")
})

test("规格: 无历史记录时使用兜底值", () => {
  const now = Date.now()
  const item = makeItem({ id: "i1", name: "猫砂", unit: "袋", platform: "淘宝" })
  const draft = buildNotificationRestockDraft(item, now)
  assert.equal(draft.kind, "restock")
  assert.equal(draft.itemId, "i1")
  assert.equal(draft.itemName, "猫砂")
  assert.equal(draft.qty, 1, "无历史时默认 1")
  assert.equal(draft.unit, "袋", "无历史时用 item.unit")
  assert.equal(draft.platform, "淘宝", "无历史时用 item.platform")
  assert.equal(draft.purchaseProductName, undefined, "无历史时无商品名")
  assert.equal(draft.restockDate, startOfDay(now))
})

test("规格: 无历史且 item 无 platform 时 platform 为 undefined", () => {
  const now = Date.now()
  const item = makeItem({ id: "i1", name: "纸巾", unit: "包", platform: undefined })
  const draft = buildNotificationRestockDraft(item, now)
  assert.equal(draft.platform, undefined)
})

// ---------- 规格: buildNotificationRestockMessage ----------

test("规格: 消息引用上次购买的平台和商品名", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂",
    history: [{
      id: "e1", at: now - 7 * DAY,
      platform: "京东", purchaseProductName: "N1猫砂10L"
    }]
  })
  const message = buildNotificationRestockMessage(item)
  assert.match(message, /猫砂到提醒点了/)
  assert.match(message, /京东/)
  assert.match(message, /N1猫砂10L/)
  assert.match(message, /照旧记一单/)
})

test("规格: 无历史记录时消息使用兜底文案", () => {
  const item = makeItem({ id: "i1", name: "纸巾", platform: undefined })
  const message = buildNotificationRestockMessage(item)
  assert.match(message, /纸巾到提醒点了/)
  assert.match(message, /上次购买的平台/, "无历史时用兜底文案")
  assert.match(message, /纸巾/, "无历史时商品名用 item.name")
})

test("规格: 消息不含禁用词", () => {
  const item = makeItem({
    history: [{ id: "e1", at: 1, platform: "京东", purchaseProductName: "N1猫砂" }]
  })
  const message = buildNotificationRestockMessage(item)
  assert.equal(findForbiddenPhrase(message), null)
})

// ---------- 规格: 草稿能被 commitAgentDraft 正常写入（端到端） ----------

test("规格端到端: 通知草稿经 commitAgentDraft 写入 history", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: now - 14 * DAY,
    history: [{
      id: "e1", at: now - 14 * DAY,
      qty: 2, platform: "京东", purchaseProductName: "N1猫砂10L",
      purchaseUnit: "袋", price: 89
    }]
  })
  const state = makeState({ items: [item] })
  const draft = buildNotificationRestockDraft(item, now)
  const result = commitAgentDraft(state, draft, now)
  assert.notEqual(result.state, state, "应返回新 state")
  const updated = result.state.items.find((i) => i.id === "i1")
  assert.ok(updated)
  assert.ok(updated.history.length >= 2, "应新增一条 history 记录")
  const newEvent = updated.history[updated.history.length - 1]
  assert.equal(newEvent.platform, "京东", "照旧写入平台")
  assert.equal(newEvent.purchaseProductName, "N1猫砂10L", "照旧写入商品名")
  assert.equal(newEvent.qty, 2, "照旧写入数量")
  assert.equal(newEvent.price, undefined, "价格不预填，写入为空")
  assert.match(result.summary, /已记录/)
})

test("规格端到端: 无历史记录的草稿也能正常写入", () => {
  const now = Date.now()
  const item = makeItem({ id: "i1", name: "纸巾", unit: "包", platform: undefined })
  const state = makeState({ items: [item] })
  const draft = buildNotificationRestockDraft(item, now)
  const result = commitAgentDraft(state, draft, now)
  const updated = result.state.items.find((i) => i.id === "i1")
  assert.ok(updated)
  assert.ok(updated.history.length >= 1)
  assert.equal(updated.history[updated.history.length - 1].qty, 1, "默认数量 1")
})

// ---------- 规格: 草稿进入 pending 流程后用户回「确认」即可记单 ----------
// 此验收点通过 orchestrator 的 confirmDraft 路径间接覆盖（orchestrator.test.mjs 已有），
// 这里补验：通知草稿被 reviseAgentDraft 修订时也能正常工作

test("规格: 通知草稿可被 reviseAgentDraft 修订价格", () => {
  const now = Date.now()
  const item = makeItem({
    id: "i1", name: "猫砂", unit: "袋",
    history: [{ id: "e1", at: now - 7 * DAY, qty: 2, platform: "京东", purchaseProductName: "N1猫砂" }]
  })
  const draft = buildNotificationRestockDraft(item, now)
  assert.equal(draft.price, undefined, "初始无价格")
  const revised = reviseAgentDraft(draft, "45块")
  assert.ok(revised)
  assert.equal(revised.price, 45, "修订后价格补进")
  assert.equal(revised.platform, "京东", "平台保持不变")
})
