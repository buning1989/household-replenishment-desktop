// 阶段 2C：LLM Turn Interpreter 单元测试（mock client）
// 运行方式：node --test tests/turn-interpreter-llm.test.mjs
//
// 覆盖：
//   1. parseLlmTurnInterpretation：合法 JSON / markdown 包裹 / 非法 JSON / 缺字段
//   2. askTurnInterpreterLlm：mock client 返回 supplement / query / new_restock / low / unknown / 空 fields / 失败
//
// 不真实调用外部 LLM。所有 LLM 响应由 mock client 返回。

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

const { parseLlmTurnInterpretation, askTurnInterpreterLlm } = await import("../src/agent/turnInterpreterLlm.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

/** mock client：返回预设 JSON 字符串 */
function mockClient(response) {
  return {
    async complete(_prompt) {
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

/** mock client：抛异常 */
function failingClient() {
  return {
    async complete(_prompt) {
      throw new Error("mock llm failure")
    }
  }
}

// ---------- 1. parseLlmTurnInterpretation：合法 JSON ----------

test("1. parseLlmTurnInterpretation 解析合法 JSON", () => {
  const raw = JSON.stringify({
    intent: "supplement_current_collection",
    fields: { platform: "拼多多" },
    confidence: "high",
    reason: "pdd 是拼多多常见缩写"
  })
  const parsed = parseLlmTurnInterpretation(raw)
  assert.ok(parsed)
  assert.equal(parsed.intent, "supplement_current_collection")
  assert.equal(parsed.fields.platform, "拼多多")
  assert.equal(parsed.confidence, "high")
  assert.equal(parsed.reason, "pdd 是拼多多常见缩写")
})

// ---------- 2. parseLlmTurnInterpretation：markdown 代码块包裹 ----------

test("2. parseLlmTurnInterpretation 容忍 markdown 代码块", () => {
  const raw = '```json\n{"intent":"smalltalk","fields":{},"confidence":"medium","reason":"问候"}\n```'
  const parsed = parseLlmTurnInterpretation(raw)
  assert.ok(parsed)
  assert.equal(parsed.intent, "smalltalk")
  assert.equal(parsed.confidence, "medium")
})

// ---------- 3. parseLlmTurnInterpretation：非法 JSON ----------

test("3. parseLlmTurnInterpretation 非法 JSON 返回 null", () => {
  assert.equal(parseLlmTurnInterpretation("not json at all"), null)
  assert.equal(parseLlmTurnInterpretation(""), null)
  assert.equal(parseLlmTurnInterpretation("   "), null)
})

// ---------- 4. parseLlmTurnInterpretation：非法 intent ----------

test("4. parseLlmTurnInterpretation 非法 intent 返回 null", () => {
  const raw = JSON.stringify({
    intent: "invalid_intent",
    fields: {},
    confidence: "high",
    reason: "test"
  })
  assert.equal(parseLlmTurnInterpretation(raw), null)
})

// ---------- 5. parseLlmTurnInterpretation：缺少 confidence ----------

test("5. parseLlmTurnInterpretation 缺少 confidence 返回 null", () => {
  const raw = JSON.stringify({
    intent: "smalltalk",
    fields: {},
    reason: "test"
  })
  assert.equal(parseLlmTurnInterpretation(raw), null)
})

// ---------- 6. askTurnInterpreterLlm：supplement + platform=拼多多 ----------

test("6. askTurnInterpreterLlm mock 返回 supplement platform=拼多多", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "pdd",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "pdd 是拼多多常见缩写"
    })
  })
  assert.ok(result, "应返回 TurnInterpretation")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.platform, "拼多多")
  assert.equal(result.confidence, "high")
})

// ---------- 7. askTurnInterpreterLlm：low confidence → null ----------

test("7. askTurnInterpreterLlm low confidence 返回 null", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "asdfasdf",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "low",
      reason: "不确定"
    })
  })
  assert.equal(result, null, "低置信应返回 null")
})

// ---------- 8. askTurnInterpreterLlm：unknown → null ----------

test("8. askTurnInterpreterLlm unknown 返回 null", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "asdfasdf",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "unknown",
      fields: {},
      confidence: "high",
      reason: "无法理解"
    })
  })
  assert.equal(result, null, "unknown 应返回 null")
})

// ---------- 9. askTurnInterpreterLlm：supplement 空 fields → null ----------

test("9. askTurnInterpreterLlm supplement 空 fields 返回 null", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "随便",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "supplement_current_collection",
      fields: {},
      confidence: "high",
      reason: "不知道补什么"
    })
  })
  assert.equal(result, null, "supplement 空 fields 应返回 null")
})

// ---------- 10. askTurnInterpreterLlm：client 失败 → null ----------

test("10. askTurnInterpreterLlm client 失败返回 null", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "pdd",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: failingClient()
  })
  assert.equal(result, null, "client 异常应返回 null")
})

// ---------- 11. askTurnInterpreterLlm：query_inventory ----------

test("11. askTurnInterpreterLlm 返回 query_inventory", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "猫砂还能用多久",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "query_inventory",
      fields: {},
      confidence: "high",
      reason: "用户在查询库存"
    })
  })
  assert.ok(result)
  assert.equal(result.intent, "query_inventory")
})

// ---------- 12. askTurnInterpreterLlm：new_restock_record ----------

test("12. askTurnInterpreterLlm 返回 new_restock_record", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "今天买了 3 袋五常大米",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "new_restock_record",
      fields: { itemName: "五常大米", quantity: 3, unit: "袋" },
      confidence: "high",
      reason: "物品名与当前 collection 不同"
    })
  })
  assert.ok(result)
  assert.equal(result.intent, "new_restock_record")
  assert.equal(result.fields.itemName, "五常大米")
})

// ---------- 13. parseLlmTurnInterpretation：数量字段兼容字符串 ----------

test("13. parseLlmTurnInterpretation 数量字段兼容字符串数字", () => {
  const raw = JSON.stringify({
    intent: "new_restock_record",
    fields: { itemName: "猫砂", quantity: "5", unit: "袋", price: "36" },
    confidence: "medium",
    reason: "test"
  })
  const parsed = parseLlmTurnInterpretation(raw)
  assert.ok(parsed)
  assert.equal(parsed.fields.quantity, 5)
  assert.equal(parsed.fields.price, 36)
})

// ---------- 14. askTurnInterpreterLlm：correct_current_collection ----------

test("14. askTurnInterpreterLlm 返回 correct_current_collection", async () => {
  const state = makeState()
  const collection = buildWipesCollection()
  const result = await askTurnInterpreterLlm({
    text: "不是宠物擦脚巾湿巾，是五常大米",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    client: mockClient({
      intent: "correct_current_collection",
      fields: { itemName: "五常大米" },
      confidence: "high",
      reason: "用户要修正物品名"
    })
  })
  assert.ok(result)
  assert.equal(result.intent, "correct_current_collection")
  assert.equal(result.fields.itemName, "五常大米")
})
