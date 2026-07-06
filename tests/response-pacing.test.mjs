// 响应节奏层单元测试
// 运行方式：node --test tests/response-pacing.test.mjs
//
// 覆盖验收点：
// 1. confirm/cancel/committed：minDelayMs=0，showLoading=false
// 2. pending draft 字段补充：500-800ms，loadingText「我记到这张单里。」
// 3. 身份/简单闲聊：500-700ms，showLoading=true，无 loadingText（显示 typing dots）
// 4. 本地库存查询：800-1100ms，loadingText 来自库存查询文案池
// 5. 价格/预算/历史分析：1000-1500ms，loadingText 来自价格预算文案池
// 6. 订单截图识别：minDelayMs=0（真实 loading），loadingText「我看一下这张订单。」
// 7. 实时外部问题：500-700ms，showLoading=true（不静默等待，显示 typing dots）
// 8. 关键语义：minDelayMs > 0 时 showLoading 必须为 true（不允许静默等待）
// 9. compactRecentMessages 跳过 isTransient 消息
// 10. computeRemainingDelay：实际耗时超过 minDelayMs 时返回 0

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
  getResponseTiming,
  categorizePacingForTest,
  timingForCategoryForTest,
  computeRemainingDelay
} = await import("../src/agent/responsePacing.ts")
const { compactRecentMessages } = await import("../src/agent/conversationContext.ts")

// ---------- 辅助 ----------

function makeInput(overrides = {}) {
  return {
    text: "",
    intent: null,
    turn: null,
    hasPendingDraft: false,
    isOrderImport: false,
    ...overrides
  }
}

// ---------- 1. confirm/cancel/committed ----------

test("confirmCancel：intent=confirmDraft 时归类为 confirmCancel", () => {
  const category = categorizePacingForTest(makeInput({
    text: "确认吧",
    intent: "confirmDraft",
    hasPendingDraft: true
  }))
  assert.equal(category, "confirmCancel")
})

test("confirmCancel：intent=cancelDraft 时归类为 confirmCancel", () => {
  const category = categorizePacingForTest(makeInput({
    text: "算了",
    intent: "cancelDraft",
    hasPendingDraft: true
  }))
  assert.equal(category, "confirmCancel")
})

test("confirmCancel：turn.kind=cancelled 时归类为 confirmCancel", () => {
  const category = categorizePacingForTest(makeInput({
    text: "不要了",
    intent: "cancelDraft",
    turn: { kind: "cancelled", message: "好，先不记了。" },
    hasPendingDraft: true
  }))
  assert.equal(category, "confirmCancel")
})

test("confirmCancel 节奏：minDelayMs=0，showLoading=false", () => {
  const timing = timingForCategoryForTest("confirmCancel")
  assert.equal(timing.minDelayMs, 0)
  assert.equal(timing.showLoading, false)
  assert.equal(timing.loadingText, undefined)
})

test("getResponseTiming：confirmDraft 立即反馈", () => {
  const timing = getResponseTiming(makeInput({
    text: "确认吧",
    intent: "confirmDraft",
    hasPendingDraft: true
  }))
  assert.equal(timing.minDelayMs, 0)
  assert.equal(timing.showLoading, false)
})

// ---------- 2. pending draft 字段补充 ----------

test("draftRevise：hasPendingDraft + intent=reviseDraft 时归类为 draftRevise", () => {
  const category = categorizePacingForTest(makeInput({
    text: "100",
    intent: "reviseDraft",
    hasPendingDraft: true
  }))
  assert.equal(category, "draftRevise")
})

test("draftRevise：无 pendingDraft 时不归类为 draftRevise", () => {
  const category = categorizePacingForTest(makeInput({
    text: "100",
    intent: "reviseDraft",
    hasPendingDraft: false
  }))
  assert.notEqual(category, "draftRevise")
})

test("draftRevise 节奏：500ms 起步，showLoading=true，loadingText 是「我记到这张单里。」", () => {
  const timing = timingForCategoryForTest("draftRevise")
  assert.ok(timing.minDelayMs >= 500, `minDelayMs 应 >= 500，实际 ${timing.minDelayMs}`)
  assert.equal(timing.showLoading, true)
  assert.equal(timing.loadingText, "我记到这张单里。")
})

test("getResponseTiming：「拼多多」在 pending draft 下走 draftRevise", () => {
  const timing = getResponseTiming(makeInput({
    text: "拼多多",
    intent: "reviseDraft",
    hasPendingDraft: true
  }))
  assert.ok(timing.minDelayMs >= 500)
  assert.equal(timing.showLoading, true)
  assert.ok(timing.loadingText)
})

test("getResponseTiming：「还挺好，不起灰」在 pending draft 下走 draftRevise", () => {
  const timing = getResponseTiming(makeInput({
    text: "还挺好，不起灰",
    intent: "reviseDraft",
    hasPendingDraft: true
  }))
  assert.ok(timing.minDelayMs >= 500)
  assert.equal(timing.showLoading, true)
})

// ---------- 3. 身份/简单闲聊 ----------

test("identityCasual：身份问题归类为 identityCasual", () => {
  const category = categorizePacingForTest(makeInput({
    text: "你是谁",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "identityCasual")
})

test("identityCasual：短闲聊归类为 identityCasual", () => {
  const category = categorizePacingForTest(makeInput({
    text: "哈哈",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "identityCasual")
})

test("identityCasual 节奏：500ms 起步，showLoading=true，无 loadingText（显示 typing dots）", () => {
  const timing = timingForCategoryForTest("identityCasual")
  assert.ok(timing.minDelayMs >= 500, `minDelayMs 应 >= 500，实际 ${timing.minDelayMs}`)
  assert.equal(timing.showLoading, true)
  assert.equal(timing.loadingText, undefined, "identityCasual 不应有 loadingText（显示 typing dots）")
})

test("getResponseTiming：「你是谁」不再秒回，先出现 typing dots", () => {
  const timing = getResponseTiming(makeInput({
    text: "你是谁",
    intent: null,
    hasPendingDraft: false
  }))
  assert.ok(timing.minDelayMs > 0, "「你是谁」不应秒回")
  assert.ok(timing.minDelayMs <= 700, "「你是谁」不应明显卡顿")
  assert.equal(timing.showLoading, true, "「你是谁」应显示 typing dots")
})

// ---------- 4. 本地库存查询 ----------

test("stockQuery：「这周要补什么」归类为 stockQuery", () => {
  const category = categorizePacingForTest(makeInput({
    text: "这周要补什么",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "stockQuery")
})

test("stockQuery：「今天优先补什么」归类为 stockQuery", () => {
  const category = categorizePacingForTest(makeInput({
    text: "今天优先补什么",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "stockQuery")
})

test("stockQuery 节奏：800ms 起步，showLoading=true，loadingText 来自文案池", () => {
  const timing = timingForCategoryForTest("stockQuery")
  assert.ok(timing.minDelayMs >= 800, `minDelayMs 应 >= 800，实际 ${timing.minDelayMs}`)
  assert.equal(timing.showLoading, true)
  assert.ok(timing.loadingText, "stockQuery 应有 loadingText")
  // 来自文案池
  const STOCK_QUERY_TEXTS = ["我看一下当前记录。", "我看一下这周的提醒。", "我先排一下优先级。"]
  assert.ok(
    STOCK_QUERY_TEXTS.includes(timing.loadingText),
    `loadingText 应来自文案池，实际 "${timing.loadingText}"`
  )
})

test("getResponseTiming：「这周要补什么」会先显示「我看一下当前记录。」", () => {
  const timing = getResponseTiming(makeInput({
    text: "这周要补什么",
    intent: null,
    hasPendingDraft: false
  }))
  assert.ok(timing.minDelayMs >= 800)
  assert.equal(timing.showLoading, true)
  assert.ok(timing.loadingText)
})

// ---------- 5. 价格/预算/历史分析 ----------

test("priceBudget：「本月预算还剩多少」归类为 priceBudget", () => {
  const category = categorizePacingForTest(makeInput({
    text: "本月预算还剩多少",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "priceBudget")
})

test("priceBudget：「价格异常」归类为 priceBudget", () => {
  const category = categorizePacingForTest(makeInput({
    text: "价格异常",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "priceBudget")
})

test("priceBudget 节奏：1000ms 起步，showLoading=true，loadingText 来自文案池", () => {
  const timing = timingForCategoryForTest("priceBudget")
  assert.ok(timing.minDelayMs >= 1000, `minDelayMs 应 >= 1000，实际 ${timing.minDelayMs}`)
  assert.equal(timing.showLoading, true)
  assert.ok(timing.loadingText)
  const PRICE_BUDGET_TEXTS = ["我对一下最近几次记录。", "我看一下本月支出。"]
  assert.ok(
    PRICE_BUDGET_TEXTS.includes(timing.loadingText),
    `loadingText 应来自文案池，实际 "${timing.loadingText}"`
  )
})

// ---------- 6. 订单截图识别 ----------

test("orderImport：isOrderImport=true 时归类为 orderImport", () => {
  const category = categorizePacingForTest(makeInput({
    text: "帮我看这张订单",
    intent: null,
    hasPendingDraft: false,
    isOrderImport: true
  }))
  assert.equal(category, "orderImport")
})

test("orderImport 节奏：minDelayMs=0（真实 loading），loadingText「我看一下这张订单。」", () => {
  const timing = timingForCategoryForTest("orderImport")
  assert.equal(timing.minDelayMs, 0, "订单识别不应额外假等待")
  assert.equal(timing.showLoading, true)
  assert.equal(timing.loadingText, "我看一下这张订单。")
})

test("getResponseTiming：订单截图识别使用真实 loading", () => {
  const timing = getResponseTiming(makeInput({
    text: "帮我看这张订单",
    intent: null,
    hasPendingDraft: false,
    isOrderImport: true
  }))
  assert.equal(timing.minDelayMs, 0)
})

// ---------- 7. 实时外部问题 ----------

test("realtimeExternal：天气问题归类为 realtimeExternal", () => {
  const category = categorizePacingForTest(makeInput({
    text: "明天天气怎么样",
    intent: null,
    hasPendingDraft: false
  }))
  assert.equal(category, "realtimeExternal")
})

test("realtimeExternal 节奏：500ms 起步，showLoading=true（不静默等待，显示 typing dots）", () => {
  const timing = timingForCategoryForTest("realtimeExternal")
  assert.ok(timing.minDelayMs >= 500, `minDelayMs 应 >= 500，实际 ${timing.minDelayMs}`)
  assert.equal(timing.showLoading, true, "实时外部问题应显示 typing dots，不静默等待")
  assert.equal(timing.loadingText, undefined, "实时外部问题不应有 loadingText（不假装查询）")
})

test("getResponseTiming：天气问题不再静默等待", () => {
  const timing = getResponseTiming(makeInput({
    text: "明天天气怎么样",
    intent: null,
    hasPendingDraft: false
  }))
  assert.ok(timing.minDelayMs > 0, "应有短暂延迟")
  assert.ok(timing.minDelayMs <= 700, "不应明显卡顿")
  assert.equal(timing.showLoading, true, "应有可见过程态")
})

// ---------- 默认节奏 ----------

test("default：无法归类的输入走 default 节奏", () => {
  const timing = getResponseTiming(makeInput({
    text: "某个不认识的输入",
    intent: null,
    hasPendingDraft: false
  }))
  assert.ok(timing.minDelayMs > 0)
  assert.equal(timing.showLoading, true)
})

test("default 节奏：500ms 起步，showLoading=true", () => {
  const timing = timingForCategoryForTest("default")
  assert.ok(timing.minDelayMs >= 500)
  assert.equal(timing.showLoading, true)
})

// ---------- 关键语义：不允许静默等待 ----------

test("关键语义：minDelayMs > 0 时 showLoading 必须为 true", () => {
  // 遍历所有 category，验证除了 confirmCancel 外都不允许静默等待
  const categories = [
    "confirmCancel", "draftRevise", "identityCasual", "stockQuery",
    "priceBudget", "orderImport", "realtimeExternal", "default"
  ]
  for (const category of categories) {
    const timing = timingForCategoryForTest(category)
    if (timing.minDelayMs > 0) {
      assert.ok(
        timing.showLoading === true,
        `${category} 的 minDelayMs=${timing.minDelayMs} > 0 时 showLoading 必须为 true，不允许静默等待`
      )
    }
  }
})

test("关键语义：只有 confirmCancel 允许 showLoading=false", () => {
  const categories = [
    "draftRevise", "identityCasual", "stockQuery",
    "priceBudget", "orderImport", "realtimeExternal", "default"
  ]
  for (const category of categories) {
    const timing = timingForCategoryForTest(category)
    assert.equal(
      timing.showLoading, true,
      `${category} 必须 showLoading=true，只有 confirmCancel 才允许 showLoading=false`
    )
  }
  // confirmCancel 才允许 showLoading=false
  const confirmCancelTiming = timingForCategoryForTest("confirmCancel")
  assert.equal(confirmCancelTiming.showLoading, false)
})

// ---------- 优先级 ----------

test("优先级：confirmDraft 优先于 orderImport", () => {
  // 即使 isOrderImport=true，confirmDraft 仍归类为 confirmCancel
  const category = categorizePacingForTest(makeInput({
    text: "确认吧",
    intent: "confirmDraft",
    hasPendingDraft: true,
    isOrderImport: true
  }))
  assert.equal(category, "confirmCancel")
})

test("优先级：orderImport 优先于 draftRevise", () => {
  const category = categorizePacingForTest(makeInput({
    text: "100",
    intent: "reviseDraft",
    hasPendingDraft: true,
    isOrderImport: true
  }))
  assert.equal(category, "orderImport")
})

test("优先级：draftRevise 优先于 realtimeExternal", () => {
  // pending draft 下即使是天气问题，仍优先 draftRevise（用户在补充当前单）
  const category = categorizePacingForTest(makeInput({
    text: "明天天气怎么样",
    intent: "reviseDraft",
    hasPendingDraft: true
  }))
  assert.equal(category, "draftRevise")
})

// ---------- computeRemainingDelay ----------

test("computeRemainingDelay：未超过 minDelayMs 时返回剩余时间", () => {
  const remaining = computeRemainingDelay(600, 200)
  assert.equal(remaining, 400)
})

test("computeRemainingDelay：超过 minDelayMs 时返回 0", () => {
  const remaining = computeRemainingDelay(600, 800)
  assert.equal(remaining, 0)
})

test("computeRemainingDelay：等于 minDelayMs 时返回 0", () => {
  const remaining = computeRemainingDelay(600, 600)
  assert.equal(remaining, 0)
})

test("computeRemainingDelay：minDelayMs=0 时返回 0", () => {
  const remaining = computeRemainingDelay(0, 100)
  assert.equal(remaining, 0)
})

// ---------- compactRecentMessages 跳过 isTransient ----------

test("compactRecentMessages：跳过 isTransient 消息", () => {
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "我看一下当前记录。", isTransient: true },
    { role: "assistant", content: "我是 403 管家" }
  ]
  const compacted = compactRecentMessages(messages, 6)
  const contents = compacted.map((m) => m.content)
  assert.ok(!contents.includes("我看一下当前记录。"), "isTransient 消息不应进入 LLM 上下文")
  assert.ok(contents.includes("你好"))
  assert.ok(contents.includes("我是 403 管家"))
})

test("compactRecentMessages：多条 isTransient 消息全部跳过", () => {
  const messages = [
    { role: "assistant", content: "loading1", isTransient: true },
    { role: "assistant", content: "loading2", isTransient: true },
    { role: "user", content: "用户消息" },
    { role: "assistant", content: "正式回复" }
  ]
  const compacted = compactRecentMessages(messages, 6)
  assert.equal(compacted.length, 2)
  assert.equal(compacted[0].content, "用户消息")
  assert.equal(compacted[1].content, "正式回复")
})

test("compactRecentMessages：空 content 的 typing dots transient 也会被跳过", () => {
  const messages = [
    { role: "user", content: "你是谁" },
    { role: "assistant", content: "", isTransient: true },
    { role: "assistant", content: "我是 403 管家" }
  ]
  const compacted = compactRecentMessages(messages, 6)
  const contents = compacted.map((m) => m.content)
  assert.ok(!contents.includes(""), "空 content 的 typing dots transient 也不应进入 LLM 上下文")
  assert.equal(compacted.length, 2)
})
