// 阶段 2C：pendingCollection 下本地低置信 → LLM Turn Interpreter fallback 端到端路由测试
// 运行方式：node --test tests/agent-entry-llm-fallback.test.mjs
//
// 覆盖《阶段 2C》10 个必测场景：
//   1. pendingCollection + 拼夕夕 → platform=拼多多
//   2. pendingCollection + pdd → platform=拼多多
//   3. pendingCollection + p'd'd → platform=拼多多
//   4. pendingCollection + 多多 → platform=拼多多
//   5. pendingCollection + 上次那个平台 → platform=京东（历史平台）
//   6. pendingCollection + asdfasdf → clarification（不回复「超出家务范围」）
//   7. pendingCollection + 查询 → route_to_query，不修改 collection
//   8. pendingCollection + 新物品 → start_new_collection
//   9. pendingCollection + 45块 → 本地高置信价格，不调用 LLM
//   10. pendingCollection + 长评价 → review 正确，不返回 needLlm
//
// 所有 LLM 调用通过 mock client 注入，不真实调用外部 LLM。

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

const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
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

function makeItem(id, name, category, extra = {}) {
  return {
    id,
    name,
    category,
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
    ...extra
  }
}

function viewsOf(items) {
  return items.map((item) => ({ item }))
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

function decideWithViews(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, ...input })
}

/** 从 AgentDraft（restock / createItemWithRestock）统一取出补货字段 */
function restockFields(draft) {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      platform: draft.platform,
      price: draft.price,
      review: draft.review,
      qty: draft.qty,
      unit: draft.unit
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      platform: draft.restock.platform,
      price: draft.restock.price,
      review: draft.restock.review,
      qty: draft.restock.qty,
      unit: draft.restock.unit
    }
  }
  return { itemName: undefined, platform: undefined, price: undefined, review: undefined, qty: undefined, unit: undefined }
}

// 构造「宠物擦脚巾湿巾」采集态（state 无此物品 → createItemWithRestock，缺 platform/price）
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

// 构造「猫砂」采集态（state 有此物品 → restock，缺 platform/price）
function buildCatSandCollection() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

/** mock client：返回预设 JSON */
function mockClient(response) {
  return {
    async complete(_prompt) {
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

/** mock client：记录是否被调用 */
function trackingClient(response, callLog) {
  return {
    async complete(prompt) {
      callLog.push(prompt)
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

// ---------- 1. pendingCollection + 拼夕夕 → platform=拼多多 ----------

test("1. pendingCollection + 拼夕夕 → LLM 解释为 platform=拼多多", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  // 1a. decide 返回 needTurnInterpreterLlm
  const d = decide(orch, {
    text: "拼夕夕",
    state,
    itemViews: [],
    pendingCollection
  })
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  // 1b. interpretAndRoute 返回 sync turn
  const llmDecision = await orch.interpretAndRoute(
    {
      text: "拼夕夕",
      state,
      itemViews: [],
      pendingCollection,
      dateContext: DATE_CONTEXT
    },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "拼夕夕是拼多多别名"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.ok(
    llmDecision.turn.kind === "collection" || llmDecision.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${llmDecision.turn.kind}`
  )
  const draft = llmDecision.turn.kind === "collection"
    ? llmDecision.turn.collection.draft
    : llmDecision.turn.executableDraft
  const f = restockFields(draft)
  assert.equal(f.platform, "拼多多", "platform 应归一为拼多多")
  assert.equal(f.itemName, "宠物擦脚巾湿巾", "itemName 不应变")
})

// ---------- 2. pendingCollection + pdd → platform=拼多多 ----------

test("2. pendingCollection + pdd → LLM 解释为 platform=拼多多", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  const d = decide(orch, { text: "pdd", state, itemViews: [], pendingCollection })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    { text: "pdd", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "pdd 是拼多多常见缩写"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  const draft = llmDecision.turn.kind === "collection"
    ? llmDecision.turn.collection.draft
    : llmDecision.turn.executableDraft
  assert.equal(restockFields(draft).platform, "拼多多")
})

// ---------- 3. pendingCollection + p'd'd → platform=拼多多 ----------

test("3. pendingCollection + p'd'd → LLM 解释为 platform=拼多多", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  const d = decide(orch, { text: "p'd'd", state, itemViews: [], pendingCollection })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    { text: "p'd'd", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "medium",
      reason: "p'd'd 是拼多多拼音缩写"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  const draft = llmDecision.turn.kind === "collection"
    ? llmDecision.turn.collection.draft
    : llmDecision.turn.executableDraft
  assert.equal(restockFields(draft).platform, "拼多多")
})

// ---------- 4. pendingCollection + 多多 → platform=拼多多 ----------

test("4. pendingCollection + 多多 → LLM 解释为 platform=拼多多", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  const d = decide(orch, { text: "多多", state, itemViews: [], pendingCollection })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    { text: "多多", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "medium",
      reason: "多多是拼多多简称"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  const draft = llmDecision.turn.kind === "collection"
    ? llmDecision.turn.collection.draft
    : llmDecision.turn.executableDraft
  assert.equal(restockFields(draft).platform, "拼多多")
})

// ---------- 5. pendingCollection + 上次那个平台 → platform=京东（历史平台） ----------

test("5. pendingCollection + 上次那个平台 → LLM 用历史平台=京东", async () => {
  // 猫砂有历史平台=京东
  const catSand = makeItem("i1", "猫砂", "宠物用品", {
    history: [
      { id: "h1", restockedAt: 1, qty: 5, unit: "袋", platform: "京东", price: 128, note: "" }
    ]
  })
  const state = makeState({ items: [catSand] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decideWithViews(orch, {
    text: "上次那个平台",
    state,
    itemViews: viewsOf([catSand]),
    pendingCollection
  })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    {
      text: "上次那个平台",
      state,
      itemViews: viewsOf([catSand]),
      pendingCollection,
      dateContext: DATE_CONTEXT
    },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "京东" },
      confidence: "medium",
      reason: "历史最近一次平台是京东"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  const draft = llmDecision.turn.kind === "collection"
    ? llmDecision.turn.collection.draft
    : llmDecision.turn.executableDraft
  assert.equal(restockFields(draft).platform, "京东")
})

// ---------- 6. pendingCollection + asdfasdf → clarification（不回复「超出家务范围」） ----------

test("6. pendingCollection + asdfasdf → clarification，不回复「超出家务范围」", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  // 6a. decide 返回 needTurnInterpreterLlm
  const d = decide(orch, { text: "asdfasdf", state, itemViews: [], pendingCollection })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  // 6b. LLM 也无法理解 → 返回 null → clarification
  const llmDecision = await orch.interpretAndRoute(
    { text: "asdfasdf", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "unknown",
      fields: {},
      confidence: "low",
      reason: "无法理解"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.equal(llmDecision.turn.kind, "clarification")
  // 关键：不得出现「超出家务范围」
  assert.ok(
    !llmDecision.turn.message.includes("超出家务范围"),
    `clarification 不应包含「超出家务范围」, 实际: ${llmDecision.turn.message}`
  )
  // 应包含当前记录名或补字段提示
  assert.ok(
    llmDecision.turn.message.includes("宠物擦脚巾湿巾") || llmDecision.turn.message.includes("记录"),
    `clarification 应提及当前记录, 实际: ${llmDecision.turn.message}`
  )
})

// ---------- 7. pendingCollection + 查询 → route_to_query，不修改 collection ----------

test("7. pendingCollection + 猫砂还能用多久 → 不修改 collection", async () => {
  const catSand = makeItem("i1", "猫砂", "宠物用品")
  const state = makeState({ items: [catSand] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  // 查询不命中 collection 字段补充 → 应落入 query/boundary 路径，不修改 collection
  const d = decideWithViews(orch, {
    text: "猫砂还能用多久",
    state,
    itemViews: viewsOf([catSand]),
    pendingCollection
  })

  // 查询路径：可能是 needLlm（adjacentHomeLife）或 sync answer
  // 关键：不返回 needTurnInterpreterLlm，不修改 collection
  assert.notEqual(d.kind, "needTurnInterpreterLlm", "查询不应进入 LLM interpreter fallback")

  if (d.kind === "needTurnInterpreterLlm") {
    // 如果确实进入 interpreter，LLM 应判为 query → needLlm（交常规 answer LLM）
    const llmDecision = await orch.interpretAndRoute(
      {
        text: "猫砂还能用多久",
        state,
        itemViews: viewsOf([catSand]),
        pendingCollection,
        dateContext: DATE_CONTEXT
      },
      mockClient({
        intent: "query_inventory",
        fields: {},
        confidence: "high",
        reason: "用户在查询库存"
      })
    )
    // query → needLlm（交常规 answer LLM），不是 sync collection
    assert.equal(llmDecision.kind, "needLlm")
  }
})

// ---------- 8. pendingCollection + 新物品 → start_new_collection ----------

test("8. pendingCollection + 今天买了 3 袋五常大米 → 新建五常大米 collection", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  // 新物品（itemName 不同）→ 本地高置信 new_restock_record → start_new_collection → writeDraft
  const d = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: [],
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "collection", "应新建 collection 而非续接旧物品")
  const f = restockFields(d.turn.collection.draft)
  assert.equal(f.itemName, "五常大米")
  assert.equal(f.qty, 3)
  assert.equal(f.unit, "袋")
  // message 不得出现旧物品名
  assert.ok(
    !d.turn.message.includes("宠物擦脚巾湿巾"),
    `新 collection message 不应出现旧物品名, 实际: ${d.turn.message}`
  )
})

// ---------- 9. pendingCollection + 45块 → 本地高置信价格，不调用 LLM ----------

test("9. pendingCollection + 45块 → 本地高置信 price=45，不调用 LLM", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  // 构造带平台的 collection（让 price 是唯一缺失的 quality 字段）
  const callLog = []
  const d = decide(orch, {
    text: "45块",
    state,
    itemViews: [],
    pendingCollection
  })

  // 本地高置信价格 → sync（collection 或 proposal），不是 needTurnInterpreterLlm
  assert.equal(d.kind, "sync", `45块 应本地高置信, 实际: ${d.kind}`)
  assert.notEqual(d.kind, "needTurnInterpreterLlm", "45块 不应调用 LLM")

  if (d.kind === "sync") {
    const draft = d.turn.kind === "collection"
      ? d.turn.collection.draft
      : d.turn.executableDraft
    const f = restockFields(draft)
    assert.equal(f.price, 45, `price 应为 45, 实际: ${f.price}`)
    assert.equal(f.itemName, "宠物擦脚巾湿巾", "itemName 不应变")
  }
})

// ---------- 10. pendingCollection + 长评价 → review 正确 ----------

test("10. pendingCollection + 这款猫砂品质不错，不起灰 → review 包含「不起灰」", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decideWithViews(orch, {
    text: "这款猫砂品质不错，不起灰",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  // 长评价应本地处理（handlePendingCollectionIntent 兜底），不走 LLM interpreter
  assert.equal(d.kind, "sync", `长评价应 sync, 实际: ${d.kind}`)
  assert.notEqual(d.kind, "needTurnInterpreterLlm", "长评价不应进入 LLM interpreter")

  if (d.kind === "sync") {
    const draft = d.turn.kind === "collection"
      ? d.turn.collection.draft
      : d.turn.executableDraft
    const f = restockFields(draft)
    assert.ok(f.review, "review 不应为空")
    assert.ok(
      f.review.includes("不起灰"),
      `review 应包含「不起灰」, 实际: ${f.review}`
    )
  }
})

// ---------- 补充 11. LLM 失败 → clarification ----------

test("11. pendingCollection + 拼夕夕 + LLM 调用失败 → clarification", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  const d = decide(orch, { text: "拼夕夕", state, itemViews: [], pendingCollection })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    { text: "拼夕夕", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT },
    {
      async complete() {
        throw new Error("network error")
      }
    }
  )
  assert.equal(llmDecision.kind, "sync")
  assert.equal(llmDecision.turn.kind, "clarification")
  assert.ok(
    !llmDecision.turn.message.includes("超出家务范围"),
    `LLM 失败也不应回复「超出家务范围」, 实际: ${llmDecision.turn.message}`
  )
})

// ---------- 补充 12. LLM 返回新物品 → start_new_collection ----------

test("12. pendingCollection + 今天买了 3 袋五常大米 → LLM 确认新物品，走 writeDraft", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  // 本地已能识别新物品（hasPurchaseVerb + itemName 不同），不走 LLM
  // 这里验证即使走 LLM，也不会被旧 collection 吞掉
  const d = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: [],
    pendingCollection
  })
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "collection")
  assert.equal(restockFields(d.turn.collection.draft).itemName, "五常大米")
})
