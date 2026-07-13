// 非管家问题对话策略单元测试
// 运行方式：node --test tests/conversation-boundary.test.mjs
//
// 覆盖验收点：
// 1. "你是谁啊" → 返回 answer，含"403 管家"，不含"换一句问法"，不调 LLM
// 2. "你应该回答你是谁" → 含"我应该直接答"或"对"，含"403 管家"，不含"换一句问法"
// 3. "明天天气咋样" → 含"看不了实时天气"或"不能保证实时天气准确"，不含"我没能整理出可靠回答"，不编造天气
// 4. "明天适合洗衣服吗" → adjacentHomeLife 走 LLM；LLM 失败时 fallback 含洗衣相关建议
// 5. "猫砂买哪种好" → adjacentHomeLife 走 LLM；LLM 失败时 fallback 含"常购商品"提示
// 6. LLM 返回纯文本导致 parseAgentResponse 失败 → fallback 用 boundary answer，不含"换一句问法"

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

const { classifyConversationBoundary } = await import("../src/agent/conversationBoundary.ts")
const { composeBoundaryAnswer, composeFallbackMessage } = await import("../src/agent/responseComposer.ts")
const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { parseAgentResponse } = await import("../src/agent/drafts.ts")

// ---------- 测试用最小 state / dateContext ----------

const dateContext = {
  now: Date.now(),
  todayLabel: "2026-07-06",
  timestampLabel: "2026-07-06 14:00",
  timezone: "Asia/Shanghai"
}

const state = {
  version: 3,
  categories: ["宠物用品"],
  items: [{
    id: "i1", name: "猫砂", category: "宠物用品", type: "learning",
    cycleDays: 30, bufferDays: 3, lastRestockedAt: dateContext.now - 30 * 86400000,
    anchorEstimated: true, purchaseOptions: [], history: [],
    createdAt: dateContext.now - 60 * 86400000, updatedAt: dateContext.now - 30 * 86400000,
    unit: "袋"
  }],
  settings: { reminderIntervalHours: 24, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true },
  householdProfile: null,
  onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
  updatedAt: dateContext.now
}

const itemViews = [{
  item: state.items[0],
  computed: {
    status: "normal", displayStatus: "normal", statusLabel: "充足",
    dueAt: dateContext.now + 30 * 86400000, depletionAt: dateContext.now + 30 * 86400000,
    daysUntilDue: 30, daysUntilDepletion: 30, isDue: false, isSnoozed: false,
    remainingText: "还够用一阵", statusText: "充足"
  }
}]

const orchestrator = createHouseholdOrchestrator()

// ---------- 1. "你是谁啊" ----------

test("你是谁啊：返回 sync answer，含 403 管家，不调 LLM，不含换一句问法", () => {
  const text = "你是谁啊"
  const boundary = classifyConversationBoundary(text)
  assert.equal(boundary, "identityOrMeta")

  const decision = orchestrator.decide({
    text, state, itemViews, dateContext
  })

  // 不调 LLM
  assert.equal(decision.kind, "sync")

  // 返回 answer
  assert.equal(decision.turn.kind, "answer")

  // 含 403 管家
  assert.match(decision.turn.message, /403\s*管家/)

  // 不含换一句问法
  assert.doesNotMatch(decision.turn.message, /换一句问法/)
})

// ---------- 2. "你应该回答你是谁" ----------

test("你应该回答你是谁：含我应该直接答或对，含 403 管家，不含换一句问法", () => {
  const text = "你应该回答你是谁"
  const boundary = classifyConversationBoundary(text)
  assert.equal(boundary, "identityOrMeta")

  const answer = composeBoundaryAnswer(boundary, text)

  // 含"我应该直接答"或"对"
  const hasAck = /我应该直接答/.test(answer) || /对，/.test(answer) || /对，这类/.test(answer)
  assert.ok(hasAck, `应含承认表述，实际：${answer}`)

  // 含 403 管家
  assert.match(answer, /403\s*管家/)

  // 不含换一句问法
  assert.doesNotMatch(answer, /换一句问法/)
})

// ---------- 3. "明天天气咋样" ----------

test("明天天气咋样：含看不了实时天气，不含我没能整理出可靠回答，不编造天气", () => {
  const text = "明天天气咋样"
  const boundary = classifyConversationBoundary(text)
  assert.equal(boundary, "realtimeExternal")

  const decision = orchestrator.decide({
    text, state, itemViews, dateContext
  })

  // 不调 LLM
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")

  const msg = decision.turn.message

  // 含"看不了实时天气"或"不能保证实时天气准确"
  const hasBoundary = /看不了实时天气/.test(msg) || /不能保证.*天气/.test(msg) || /看不了实时/.test(msg)
  assert.ok(hasBoundary, `应含实时天气边界说明，实际：${msg}`)

  // 不含"我没能整理出可靠回答"
  assert.doesNotMatch(msg, /我没能整理出可靠回答/)

  // 不编造天气结果（不应出现具体温度/晴雨描述）
  assert.doesNotMatch(msg, /晴|阴|雨|雪|\d+\s*°|摄氏/)
})

// ---------- 4. "明天适合洗衣服吗" ----------

test("明天适合洗衣服吗：adjacentHomeLife 走 LLM；LLM 失败 fallback 含洗衣相关建议", () => {
  const text = "明天适合洗衣服吗"
  const boundary = classifyConversationBoundary(text)
  assert.equal(boundary, "adjacentHomeLife")

  const decision = orchestrator.decide({
    text, state, itemViews, dateContext
  })

  // adjacentHomeLife 走 LLM
  assert.equal(decision.kind, "needLlm")

  // LLM 失败时用 boundary answer 兜底
  const fallback = composeBoundaryAnswer(boundary, text)

  // 含洗衣相关建议或关联家务能力
  const hasLaundryHint = /洗衣/.test(fallback) || /家里场景/.test(fallback)
  assert.ok(hasLaundryHint, `fallback 应含洗衣建议，实际：${fallback}`)

  // 不含"换一句问法"
  assert.doesNotMatch(fallback, /换一句问法/)
})

// ---------- 5. "猫砂买哪种好" ----------

test("猫砂买哪种好：adjacentHomeLife 走 LLM；LLM 失败 fallback 含常购商品提示", () => {
  const text = "猫砂买哪种好"
  const boundary = classifyConversationBoundary(text)
  assert.equal(boundary, "adjacentHomeLife")

  const decision = orchestrator.decide({
    text, state, itemViews, dateContext
  })

  // adjacentHomeLife 走 LLM
  assert.equal(decision.kind, "needLlm")

  // LLM 失败时用 boundary answer 兜底
  const fallback = composeBoundaryAnswer(boundary, text)

  // 含"常购商品"提示
  assert.match(fallback, /常购商品/)

  // 不含"换一句问法"
  assert.doesNotMatch(fallback, /换一句问法/)
})

// ---------- 6. LLM 返回纯文本导致 parseAgentResponse 失败 ----------

test("LLM 返回纯文本失败：fallback 用 boundary answer，不含换一句问法", () => {
  const text = "明天天气咋样"

  // 模拟 LLM 返回纯文本（非 JSON），parseAgentResponse 应返回 null
  const llmContent = "明天天气应该不错吧。"
  const parsed = parseAgentResponse(llmContent, state)
  assert.equal(parsed, null)

  // App.tsx 在 turn 为 null 时会用 boundary answer 兜底
  const boundary = classifyConversationBoundary(text)
  const fallback = composeBoundaryAnswer(boundary, text)

  // 含实时天气边界说明
  const hasBoundary = /看不了实时天气/.test(fallback) || /不能保证.*天气/.test(fallback) || /看不了实时/.test(fallback)
  assert.ok(hasBoundary, `应含实时天气边界说明，实际：${fallback}`)

  // 不含"换一句问法"
  assert.doesNotMatch(fallback, /换一句问法/)

  // 不含旧的统一拒绝文案
  assert.doesNotMatch(fallback, /我没能整理出可靠回答/)
})

// ---------- 补充：边界分类准确性 ----------

test("边界分类：casual 短闲聊正确识别", () => {
  assert.equal(classifyConversationBoundary("哈哈"), "casual")
  assert.equal(classifyConversationBoundary("好的"), "casual")
  assert.equal(classifyConversationBoundary("没事"), "casual")
  assert.equal(classifyConversationBoundary("你真笨"), "casual")
})

test("边界分类：unsupported 不命中任何类别", () => {
  assert.equal(classifyConversationBoundary("量子力学的基本原理是什么"), "unsupported")
  assert.equal(classifyConversationBoundary("帮我写一首诗"), "unsupported")
})

test("边界分类：identity 优先于 casual，避免'你是谁啊'被识别为 casual", () => {
  // "你是谁啊" 长度 4，但应优先识别为 identityOrMeta
  assert.equal(classifyConversationBoundary("你是谁啊"), "identityOrMeta")
  assert.equal(classifyConversationBoundary("你是谁"), "identityOrMeta")
})

test("边界分类：realtimeExternal 关键词覆盖", () => {
  assert.equal(classifyConversationBoundary("明天天气怎么样"), "realtimeExternal")
  assert.equal(classifyConversationBoundary("今天温度多少"), "realtimeExternal")
  assert.equal(classifyConversationBoundary("今天股票涨了没"), "realtimeExternal")
  assert.equal(classifyConversationBoundary("现在汇率多少"), "realtimeExternal")
})

test("composeFallbackMessage no-answer 仍保留为极少数异常兜底", () => {
  // 旧的统一拒绝文案仍存在，但仅作为极少数真正异常兜底
  const msg = composeFallbackMessage("no-answer")
  assert.match(msg, /换一句问法/)
})
