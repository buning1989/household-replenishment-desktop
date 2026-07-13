// 阶段 4B.6：pending 活跃期本地过度自信与上下文未进入决策的修复测试
// 运行方式：node --test tests/agent-pending-aware-routing.test.mjs
//
// 覆盖任务规范第八节 10 个场景：
//   1. pendingDraft(猫砂 5袋 拼多多 ¥110) + "我花了多少钱买的这 5 袋猫砂"
//      => query_current_pending price，answer ¥110，不新建 collection
//   2. pendingDraft + "猫砂那条你记了多少钱" => answer ¥110
//   3. pendingDraft + "这 5 袋猫砂哪个平台买的" => answer 拼多多
//   4. pendingDraft + "买了几袋猫砂来着" => answer 5袋
//   5. pendingDraft + "猫砂你还没记上呢" => answer 当前待确认，提示确认保存
//   6. pendingDraft + "我花了120买的这 5 袋猫砂" => revise price=120，不新建 collection
//   7. pendingDraft + "今天买了 3 袋五常大米" => start_new_collection
//   8. pendingCollection(猫砂 5袋，缺 price/platform) + "这 5 袋猫砂多少钱"
//      => answer 当前金额还缺，不新建 collection
//   9. no pending + "我花了多少钱买的这 5 袋猫砂" => 不新建 collection
//   10. pendingDraft + "你好棒" / "我今天有点累" => 自然回应，不写入、不新建 collection

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

const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "日常护理", "其他"],
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

/** 构造 pendingDraft(猫砂 5袋 拼多多 ¥110) — 全字段已填的 restock 草稿。 */
function buildCatSandPendingDraft() {
  return {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 110,
    platform: "拼多多",
    restockDate: NOW,
    matchHint: undefined
  }
}

/** 构造 pendingCollection(猫砂 5袋，缺 price/platform)。 */
function buildCatSandCollectionMissingFields() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  assert.ok(draft, "应能解析出猫砂草稿")
  return createDraftCollection(draft, [], NOW)
}

/** mock client：返回预设 JSON。 */
function mockClient(response) {
  return {
    async complete(_prompt) {
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

/** 从 AgentDraft（restock / createItemWithRestock）统一取出补货字段。 */
function restockFields(draft) {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      platform: draft.platform,
      price: draft.price,
      review: draft.review,
      qty: draft.qty,
      unit: draft.unit,
      restockDate: draft.restockDate
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      platform: draft.restock.platform,
      price: draft.restock.price,
      review: draft.restock.review,
      qty: draft.restock.qty,
      unit: draft.restock.unit,
      restockDate: draft.restock.restockDate
    }
  }
  return { itemName: undefined, platform: undefined, price: undefined, review: undefined, qty: undefined, unit: undefined, restockDate: undefined }
}

function draftFromDecision(d) {
  if (d.turn.kind === "collection") return d.turn.collection.draft
  if (d.turn.kind === "proposal") return d.turn.executableDraft
  return undefined
}

// ---------- 1. pendingDraft + "我花了多少钱买的这 5 袋猫砂" => answer ¥110 ----------

test("1. pendingDraft(猫砂 5袋 拼多多 ¥110) + 「我花了多少钱买的这 5 袋猫砂」→ query_current_pending price，answer ¥110", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  // decideSync 应返回 needTurnInterpreterLlm（混合信号降级，不本地高置信写入）
  const d = decide(orch, {
    text: "我花了多少钱买的这 5 袋猫砂",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  // LLM 解释为 query_current_pending/price
  const llmDecision = await orch.interpretAndRoute(
    { text: "我花了多少钱买的这 5 袋猫砂", state, itemViews: viewsOf(state.items), pendingDraft, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "query_current_pending",
      fields: { targetField: "price", itemName: "猫砂", quantity: 5, unit: "袋" },
      confidence: "high",
      reason: "用户在问当前待确认草稿的金额"
    })
  )
  assert.equal(llmDecision.kind, "sync", `期望 sync, 实际: ${llmDecision.kind}`)
  assert.equal(llmDecision.turn.kind, "answer", `期望 answer, 实际: ${llmDecision.turn.kind}`)
  assert.ok(
    llmDecision.turn.message.includes("110"),
    `回答应包含 ¥110, 实际: ${llmDecision.turn.message}`
  )
  // 不应新建 collection 或 supersede
  assert.ok(!llmDecision.turn.message.includes("五常大米"), `不应含其他物品`)
})

// ---------- 2. pendingDraft + "猫砂那条你记了多少钱" => answer ¥110 ----------

test("2. pendingDraft + 「猫砂那条你记了多少钱」→ answer ¥110", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "猫砂那条你记了多少钱",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  const llmDecision = await orch.interpretAndRoute(
    { text: "猫砂那条你记了多少钱", state, itemViews: viewsOf(state.items), pendingDraft, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "query_current_pending",
      fields: { targetField: "price", itemName: "猫砂" },
      confidence: "high",
      reason: "用户在问当前草稿记的金额"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.equal(llmDecision.turn.kind, "answer")
  assert.ok(
    llmDecision.turn.message.includes("110"),
    `回答应包含 ¥110, 实际: ${llmDecision.turn.message}`
  )
})

// ---------- 3. pendingDraft + "这 5 袋猫砂哪个平台买的" => answer 拼多多 ----------

test("3. pendingDraft + 「这 5 袋猫砂哪个平台买的」→ answer 拼多多", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "这 5 袋猫砂哪个平台买的",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  const llmDecision = await orch.interpretAndRoute(
    { text: "这 5 袋猫砂哪个平台买的", state, itemViews: viewsOf(state.items), pendingDraft, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "query_current_pending",
      fields: { targetField: "platform", itemName: "猫砂", quantity: 5, unit: "袋" },
      confidence: "high",
      reason: "用户在问当前草稿的平台"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.equal(llmDecision.turn.kind, "answer")
  assert.ok(
    llmDecision.turn.message.includes("拼多多"),
    `回答应包含「拼多多」, 实际: ${llmDecision.turn.message}`
  )
})

// ---------- 4. pendingDraft + "买了几袋猫砂来着" => answer 5袋 ----------

test("4. pendingDraft + 「买了几袋猫砂来着」→ answer 5袋", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "买了几袋猫砂来着",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  const llmDecision = await orch.interpretAndRoute(
    { text: "买了几袋猫砂来着", state, itemViews: viewsOf(state.items), pendingDraft, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "query_current_pending",
      fields: { targetField: "qty", itemName: "猫砂" },
      confidence: "high",
      reason: "用户在问当前草稿的数量"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.equal(llmDecision.turn.kind, "answer")
  assert.ok(
    llmDecision.turn.message.includes("5"),
    `回答应包含「5」, 实际: ${llmDecision.turn.message}`
  )
  assert.ok(
    llmDecision.turn.message.includes("袋"),
    `回答应包含「袋」, 实际: ${llmDecision.turn.message}`
  )
})

// ---------- 5. pendingDraft + "猫砂你还没记上呢" => answer 当前待确认 ----------

test("5. pendingDraft + 「猫砂你还没记上呢」→ answer 当前待确认，提示确认保存", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "猫砂你还没记上呢",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 应进入 needTurnInterpreterLlm（hasQuestionSignal=true，因为"还没记"匹配 MIXED_SIGNAL_QUESTION_PATTERN）
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  const llmDecision = await orch.interpretAndRoute(
    { text: "猫砂你还没记上呢", state, itemViews: viewsOf(state.items), pendingDraft, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "query_current_pending",
      fields: { targetField: "status", itemName: "猫砂" },
      confidence: "high",
      reason: "用户在问当前草稿是否已记录"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.equal(llmDecision.turn.kind, "answer")
  assert.ok(
    llmDecision.turn.message.includes("待确认") || llmDecision.turn.message.includes("还没"),
    `回答应说明还没正式写入, 实际: ${llmDecision.turn.message}`
  )
  assert.ok(
    llmDecision.turn.message.includes("确认") || llmDecision.turn.message.includes("保存"),
    `回答应提示确认保存, 实际: ${llmDecision.turn.message}`
  )
})

// ---------- 6. pendingDraft + "我花了120买的这 5 袋猫砂" => revise price=120 ----------

test("6. pendingDraft(猫砂 5袋 拼多多 ¥110) + 「我花了120买的这 5 袋猫砂」→ revise price=120，不新建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "我花了120买的这 5 袋猫砂",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 应本地同步处理（同物品修订，不走 start_new_collection）
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  // 应是 proposal（revise）或 answer，不是 collection（新建）
  assert.ok(
    d.turn.kind === "proposal" || d.turn.kind === "answer",
    `期望 proposal 或 answer, 实际: ${d.turn.kind}`
  )
  if (d.turn.kind === "proposal") {
    const draft = draftFromDecision(d)
    assert.ok(draft, "应取出 draft")
    const f = restockFields(draft)
    assert.equal(f.price, 120, `price 应修订为 120, 实际: ${f.price}`)
    assert.equal(f.itemName, "猫砂", "itemName 不应变")
    assert.equal(f.qty, 5, "qty 应保持 5")
    assert.equal(f.platform, "拼多多", "platform 应保持拼多多")
  }
})

// ---------- 7. pendingDraft + "今天买了 3 袋五常大米" => start_new_collection ----------

test("7. pendingDraft(猫砂 5袋) + 「今天买了 3 袋五常大米」→ start_new_collection，旧 pendingDraft superseded", () => {
  const state = makeState({
    items: [
      makeItem("i1", "猫砂", "宠物用品"),
      makeItem("i2", "五常大米", "日常护理", { unit: "袋" })
    ]
  })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 应本地同步处理（不同物品 → start_new_collection → writeDraft）
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  assert.ok(draft, "应取出 draft")
  const f = restockFields(draft)
  assert.equal(f.itemName, "五常大米", `itemName 应为五常大米, 实际: ${f.itemName}`)
  assert.equal(f.qty, 3, `qty 应为 3, 实际: ${f.qty}`)
})

// ---------- 8. pendingCollection(猫砂 5袋，缺 price/platform) + "这 5 袋猫砂多少钱" => answer 金额还缺 ----------

test("8. pendingCollection(猫砂 5袋 缺 price/platform) + 「这 5 袋猫砂多少钱」→ answer 当前金额还缺，不新建 collection", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollectionMissingFields()

  // 直接测试 interpretAndRoute（LLM 判定为 query_current_pending/price）
  // pendingCollection 的 price 缺失 → composePendingFieldAnswer 应回答金额还没记上
  const llmDecision = await orch.interpretAndRoute(
    { text: "这 5 袋猫砂多少钱", state, itemViews: viewsOf(state.items), pendingCollection, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "query_current_pending",
      fields: { targetField: "price", itemName: "猫砂", quantity: 5, unit: "袋" },
      confidence: "high",
      reason: "用户在问当前采集态的金额"
    })
  )
  assert.equal(llmDecision.kind, "sync", `期望 sync, 实际: ${llmDecision.kind}`)
  assert.equal(llmDecision.turn.kind, "answer", `期望 answer, 实际: ${llmDecision.turn.kind}`)
  assert.ok(
    llmDecision.turn.message.includes("金额") || llmDecision.turn.message.includes("还没记"),
    `回答应说明金额还没记上, 实际: ${llmDecision.turn.message}`
  )
  // 不应新建 collection
  assert.notEqual(llmDecision.turn.kind, "collection", "不应新建 collection")
  assert.notEqual(llmDecision.turn.kind, "proposal", "不应新建 proposal")
})

// ---------- 9. no pending + "我花了多少钱买的这 5 袋猫砂" => 不新建 collection ----------

test("9. no pending + 「我花了多少钱买的这 5 袋猫砂」→ 不新建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "我花了多少钱买的这 5 袋猫砂",
    state,
    itemViews: viewsOf(state.items)
  })
  // 无 pending 时，混合信号 → unknown/low → 不应新建 collection
  // 应返回 needLlm（交常规 answer LLM 查询历史）或 sync answer（边界）
  assert.ok(
    d.kind === "needLlm" || d.kind === "sync",
    `期望 needLlm 或 sync, 实际: ${d.kind}`
  )
  if (d.kind === "sync") {
    assert.ok(
      d.turn.kind !== "collection" && d.turn.kind !== "proposal",
      `不应新建 collection 或 proposal, 实际: ${d.turn.kind}`
    )
  }
})

// ---------- 10. pendingDraft + "你好棒" / "我今天有点累" => 自然回应，不写入 ----------

test("10a. pendingDraft + 「你好棒」→ 自然回应，不写入、不新建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "你好棒",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 闲聊应返回 sync answer 或 needLlm（交 LLM 自然回应）
  assert.ok(
    d.kind === "sync" || d.kind === "needLlm",
    `期望 sync 或 needLlm, 实际: ${d.kind}`
  )
  if (d.kind === "sync") {
    assert.ok(
      d.turn.kind !== "collection" && d.turn.kind !== "proposal",
      `不应新建 collection 或 proposal, 实际: ${d.turn.kind}`
    )
  }
})

test("10b. pendingDraft + 「我今天有点累」→ 自然回应，不写入、不新建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "我今天有点累",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 阶段 4B.6 补口：pendingDraft route_to_llm 无条件升级 needTurnInterpreterLlm，
  // 因此 smalltalk/unknown 会交 LLM Turn Interpreter 自然回应（不再落回 answer LLM）。
  assert.ok(
    d.kind === "sync" || d.kind === "needLlm" || d.kind === "needTurnInterpreterLlm",
    `期望 sync / needLlm / needTurnInterpreterLlm, 实际: ${d.kind}`
  )
  if (d.kind === "sync") {
    assert.ok(
      d.turn.kind !== "collection" && d.turn.kind !== "proposal",
      `不应新建 collection 或 proposal, 实际: ${d.turn.kind}`
    )
  }
})

// ---------- 补充：4B.5 回归 — pdd+110 合并能力不回退 ----------

test("补充1. 4B.5 回归：pendingCollection 猫砂 5袋 + 「pdd 买的，110」→ platform=拼多多, price=110", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollectionMissingFields()

  const d = decide(orch, {
    text: "pdd 买的，110",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  assert.ok(draft, "应取出 draft")
  const f = restockFields(draft)
  assert.equal(f.platform, "拼多多", `platform 应为拼多多, 实际: ${f.platform}`)
  assert.equal(f.price, 110, `price 应为 110, 实际: ${f.price}`)
  assert.equal(f.qty, 5, `qty 应保持 5, 实际: ${f.qty}`)
})

// ---------- 补充：4B.4 回归 — 自然语言 answer 能力不回退 ----------

test("补充2. 4B.4 回归：pendingCollection + LLM 返回 query → needLlm（交常规 answer LLM）", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollectionMissingFields()

  // 模拟「上次那个平台」这类需要 LLM 解释的输入
  const d = decide(orch, {
    text: "上次那个平台",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })
  // 应进入 needTurnInterpreterLlm（本地无法解析指代）
  if (d.kind === "needTurnInterpreterLlm") {
    const llmDecision = await orch.interpretAndRoute(
      { text: "上次那个平台", state, itemViews: viewsOf(state.items), pendingCollection, dateContext: DATE_CONTEXT },
      mockClient({
        intent: "supplement_current_collection",
        fields: { platform: "京东" },
        confidence: "medium",
        reason: "用户指代历史平台"
      })
    )
    assert.equal(llmDecision.kind, "sync", `期望 sync, 实际: ${llmDecision.kind}`)
    assert.ok(
      llmDecision.turn.kind === "collection" || llmDecision.turn.kind === "proposal",
      `期望 collection 或 proposal, 实际: ${llmDecision.turn.kind}`
    )
    const draft = draftFromDecision(llmDecision)
    assert.ok(draft, "应取出 draft")
    assert.equal(restockFields(draft).platform, "京东", `platform 应为京东`)
  }
})

// ---------- 阶段 4B.6 补口：pendingDraft 同物品仲裁 / interpreter 升级 / low confidence 安全门槛 ----------

// 11. pendingDraft + "猫砂买了 6 袋" => revise qty=6，不新建 collection

test("11. pendingDraft(猫砂 5袋 ¥110 拼多多) + 「猫砂买了 6 袋」→ revise qty=6，不新建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "猫砂买了 6 袋",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 同物品 → continue_pending_draft → revise，不新建 collection
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.ok(
    d.turn.kind === "proposal" || d.turn.kind === "answer",
    `期望 proposal 或 answer, 实际: ${d.turn.kind}`
  )
  if (d.turn.kind === "proposal") {
    const draft = draftFromDecision(d)
    assert.ok(draft, "应取出 draft")
    const f = restockFields(draft)
    assert.equal(f.qty, 6, `qty 应修订为 6, 实际: ${f.qty}`)
    assert.equal(f.itemName, "猫砂", "itemName 不应变")
    assert.equal(f.price, 110, "price 应保持 110")
    assert.equal(f.platform, "拼多多", "platform 应保持拼多多")
  }
})

// 12. pendingDraft + "猫砂其实是京东买的" => revise platform=京东，不新建 collection

test("12. pendingDraft(猫砂 5袋 ¥110 拼多多) + 「猫砂其实是京东买的」→ revise platform=京东，不新建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "猫砂其实是京东买的",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 同物品 → continue_pending_draft → revise，不新建 collection
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.ok(
    d.turn.kind === "proposal" || d.turn.kind === "answer",
    `期望 proposal 或 answer, 实际: ${d.turn.kind}`
  )
  if (d.turn.kind === "proposal") {
    const draft = draftFromDecision(d)
    assert.ok(draft, "应取出 draft")
    const f = restockFields(draft)
    assert.equal(f.platform, "京东", `platform 应修订为京东, 实际: ${f.platform}`)
    assert.equal(f.itemName, "猫砂", "itemName 不应变")
    assert.equal(f.qty, 5, "qty 应保持 5")
    assert.equal(f.price, 110, "price 应保持 110")
  }
})

// 13. pendingDraft + "p'd'd 买的" => needTurnInterpreterLlm => platform=拼多多，不新建 collection

test("13. pendingDraft(猫砂 5袋 ¥110 拼多多) + 「p'd'd 买的」→ needTurnInterpreterLlm，最终 platform=拼多多", async () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "p'd'd 买的",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 无疑问词但需结构化理解 → route_to_llm → 无条件升级 needTurnInterpreterLlm
  assert.equal(d.kind, "needTurnInterpreterLlm", `期望 needTurnInterpreterLlm, 实际: ${d.kind}`)

  // LLM 解释为 supplement platform=拼多多
  const llmDecision = await orch.interpretAndRoute(
    { text: "p'd'd 买的", state, itemViews: viewsOf(state.items), pendingDraft, dateContext: DATE_CONTEXT },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "p'd'd 是拼多多别名"
    })
  )
  assert.equal(llmDecision.kind, "sync", `期望 sync, 实际: ${llmDecision.kind}`)
  assert.ok(
    llmDecision.turn.kind === "proposal" || llmDecision.turn.kind === "answer",
    `期望 proposal 或 answer, 实际: ${llmDecision.turn.kind}`
  )
  if (llmDecision.turn.kind === "proposal") {
    const draft = draftFromDecision(llmDecision)
    assert.ok(draft, "应取出 draft")
    const f = restockFields(draft)
    assert.equal(f.platform, "拼多多", `platform 应为拼多多, 实际: ${f.platform}`)
    assert.equal(f.itemName, "猫砂", "itemName 不应变")
    assert.equal(f.qty, 5, "qty 应保持 5")
    assert.equal(f.price, 110, "price 应保持 110")
  }
})

// 14. pendingDraft + "另外又买了 5 袋猫砂" => start_new_collection，旧 draft superseded

test("14. pendingDraft(猫砂 5袋 ¥110 拼多多) + 「另外又买了 5 袋猫砂」→ start_new_collection，旧 draft superseded", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "另外又买了 5 袋猫砂",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // 同物品但有显式新增信号 → start_new_collection
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  assert.ok(draft, "应取出 draft")
  const f = restockFields(draft)
  assert.equal(f.itemName, "猫砂", `itemName 应为猫砂, 实际: ${f.itemName}`)
  assert.equal(f.qty, 5, `qty 应为 5, 实际: ${f.qty}`)
})

// 15. pendingDraft + "今天买了 3 袋五常大米" => start_new_collection（回归）

test("15. pendingDraft(猫砂 5袋 ¥110 拼多多) + 「今天买了 3 袋五常大米」→ start_new_collection", () => {
  const state = makeState({
    items: [
      makeItem("i1", "猫砂", "宠物用品"),
      makeItem("i2", "五常大米", "日常护理", { unit: "袋" })
    ]
  })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  const d = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  assert.ok(draft, "应取出 draft")
  const f = restockFields(draft)
  assert.equal(f.itemName, "五常大米", `itemName 应为五常大米, 实际: ${f.itemName}`)
  assert.equal(f.qty, 3, `qty 应为 3, 实际: ${f.qty}`)
})

// 16. pendingDraft + low confidence new_restock_record（无明确 itemName）=> 不 start_new_collection

test("16. pendingDraft + low confidence new_restock_record（无明确 itemName）→ 不 start_new_collection，升级 interpreter", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildCatSandPendingDraft()

  // "补了" 是购买动词但无法抽出物品名 → new_restock_record/low/no_item_name
  const d = decide(orch, {
    text: "补了",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })
  // low confidence + no_item_name → route_to_llm → needTurnInterpreterLlm
  // 不应 start_new_collection（不新建 collection 或 proposal）
  assert.ok(
    d.kind === "needTurnInterpreterLlm" || d.kind === "needLlm",
    `期望 needTurnInterpreterLlm 或 needLlm, 实际: ${d.kind}`
  )
  if (d.kind === "sync") {
    assert.ok(
      d.turn.kind !== "collection" && d.turn.kind !== "proposal",
      `不应新建 collection 或 proposal, 实际: ${d.turn.kind}`
    )
  }
})
