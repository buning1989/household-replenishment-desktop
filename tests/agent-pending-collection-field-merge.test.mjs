// 阶段 4B.5：pendingCollection 字段合并与草稿覆盖保护测试
// 运行方式：node --test tests/agent-pending-collection-field-merge.test.mjs
//
// 覆盖任务规范第八节 8 个场景：
//   1. pendingCollection 猫砂 5袋 + "pdd 买的，110" → platform=拼多多, price=110, qty=5
//   2. pendingCollection 猫砂 5袋 + "pdd买的" → platform=拼多多, qty=5
//   3. pendingCollection 猫砂 5袋 + "110" → price=110, qty=5, platform 不被清空
//   4. pendingCollection 猫砂 5袋 + "我买了5袋啊" → qty=5, unit=袋, 已有字段不丢
//   5. pendingCollection 猫砂 5袋 (ready) + "好的" → 确认保存，不走普通 query
//   6. pendingCollection 猫砂 5袋 + "今天买了 3 袋五常大米" → 开启新 collection
//   7. pendingCollection 猫砂 5袋 + LLM 返回 draft qty=1 → 不得覆盖 qty=5
//   8. pendingCollection 猫砂 5袋 + "pdd 买的啊，刚才说了" → platform=拼多多, 已有字段不清空

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
    categories: ["宠物用品", "卫生间", "日常护理", "其他"],
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

/** 构造「猫砂 5 袋」采集态（state 有猫砂物品 → restock draft）。 */
function buildCatSandCollection() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  assert.ok(draft, "应能解析出猫砂草稿")
  return createDraftCollection(draft, [], NOW)
}

/** 构造「猫砂 5 袋」采集态，并预填 platform（模拟上一轮已补平台）。 */
function buildCatSandCollectionWithPlatform(platform = "京东") {
  const c = buildCatSandCollection()
  return {
    ...c,
    draft: c.draft.kind === "restock"
      ? { ...c.draft, platform }
      : { ...c.draft, restock: { ...c.draft.restock, platform } },
    qualityMissingSlots: c.qualityMissingSlots.filter((s) => s !== "platform")
  }
}

/** 构造「猫砂 5 袋」采集态，全部字段已齐（readyToConfirm）。 */
function buildReadyCatSandCollection() {
  const c = buildCatSandCollection()
  return {
    ...c,
    draft: c.draft.kind === "restock"
      ? { ...c.draft, platform: "京东", price: 128 }
      : { ...c.draft, restock: { ...c.draft.restock, platform: "京东", price: 128 } },
    qualityMissingSlots: [],
    completeness: "readyToConfirm"
  }
}

/** 从 decision 中取出 draft（兼容 collection / proposal 两种 turn kind）。 */
function draftFromDecision(d) {
  if (d.turn.kind === "collection") return d.turn.collection.draft
  if (d.turn.kind === "proposal") return d.turn.executableDraft
  return undefined
}

// ---------- 1. "pdd 买的，110" → platform=拼多多, price=110, qty=5 ----------

test("1. pendingCollection 猫砂 5袋 + 「pdd 买的，110」→ platform=拼多多, price=110, qty=5", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "pdd 买的，110",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync", "应本地同步处理")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  assert.ok(draft, "应取出 draft")
  const f = restockFields(draft)
  assert.equal(f.platform, "拼多多", "platform 应为拼多多")
  assert.equal(f.price, 110, "price 应为 110")
  assert.equal(f.qty, 5, "qty 应保持 5，不被重置")
  assert.equal(f.unit, "袋", "unit 应保持 袋")
  assert.equal(f.itemName, "猫砂", "itemName 不应变")
  // 不应出现错误话术
  assert.ok(!d.turn.message.includes("按一袋记"), `不应含「按一袋记」, 实际: ${d.turn.message}`)
  assert.ok(!d.turn.message.includes("价格和平台先空着"), `不应含「价格和平台先空着」, 实际: ${d.turn.message}`)
})

// ---------- 2. "pdd买的" → platform=拼多多, qty=5 ----------

test("2. pendingCollection 猫砂 5袋 + 「pdd买的」→ platform=拼多多, qty保持5", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "pdd买的",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  const f = restockFields(draft)
  assert.equal(f.platform, "拼多多", "platform 应为拼多多")
  assert.equal(f.qty, 5, "qty 应保持 5")
  assert.equal(f.itemName, "猫砂", "itemName 不应变")
})

// ---------- 3. "110" → price=110, qty=5, platform 不被清空 ----------

test("3. pendingCollection 猫砂 5袋(已有平台) + 「110」→ price=110, qty=5, platform 不被清空", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollectionWithPlatform("京东")

  const d = decide(orch, {
    text: "110",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  const f = restockFields(draft)
  assert.equal(f.price, 110, "price 应为 110")
  assert.equal(f.qty, 5, "qty 应保持 5")
  assert.equal(f.platform, "京东", "platform 不应被清空")
  assert.equal(f.itemName, "猫砂", "itemName 不应变")
})

// ---------- 4. "我买了5袋啊" → qty=5, unit=袋, 已有字段不丢 ----------

test("4. pendingCollection 猫砂 5袋 + 「我买了5袋啊」→ qty=5, unit=袋, 已有字段不丢", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  // 先构造已有平台和价格的 collection
  const pendingCollection = buildCatSandCollectionWithPlatform("京东")
  // 再补上 price
  const cWithPrice = {
    ...pendingCollection,
    draft: pendingCollection.draft.kind === "restock"
      ? { ...pendingCollection.draft, price: 110 }
      : { ...pendingCollection.draft, restock: { ...pendingCollection.draft.restock, price: 110 } },
    qualityMissingSlots: []
  }

  const d = decide(orch, {
    text: "我买了5袋啊",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection: cWithPrice
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  const f = restockFields(draft)
  assert.equal(f.qty, 5, "qty 应为 5")
  assert.equal(f.unit, "袋", "unit 应为 袋")
  assert.equal(f.platform, "京东", "已有 platform 不应丢")
  assert.equal(f.price, 110, "已有 price 不应丢")
  assert.equal(f.itemName, "猫砂", "itemName 不应变")
})

// ---------- 5. "好的" (readyToConfirm) → 确认保存，不走普通 query ----------

test("5. pendingCollection 猫砂 5袋 (ready) + 「好的」→ 确认保存，不走普通 query", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildReadyCatSandCollection()

  const d = decide(orch, {
    text: "好的",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand", "readyToConfirm + 好的 应转 planCommand/draftCommit 确认保存")
  assert.equal(d.turn.command.command, "draftCommit")
  // 不应走普通 query 回答
  assert.notEqual(d.turn.kind, "answer", "不应走普通 query answer")
  assert.ok(
    !d.turn.message.includes("你直接说要我看哪件事"),
    `不应回复查询类话术, 实际: ${d.turn.message}`
  )
})

// ---------- 6. "今天买了 3 袋五常大米" → 开启新 collection，旧猫砂 superseded ----------

test("6. pendingCollection 猫砂 5袋 + 「今天买了 3 袋五常大米」→ 开启新 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "collection", "应新建 collection")
  const f = restockFields(d.turn.collection.draft)
  assert.equal(f.itemName, "五常大米", "新 collection 物品名应为五常大米")
  assert.equal(f.qty, 3, "新 collection qty 应为 3")
  assert.equal(f.unit, "袋", "新 collection unit 应为 袋")
  // message 不应出现旧物品名
  assert.ok(
    !d.turn.message.includes("猫砂"),
    `新 collection message 不应出现旧物品名「猫砂」, 实际: ${d.turn.message}`
  )
})

// ---------- 7. LLM 返回 draft qty=1 → 不得覆盖当前 qty=5 ----------

test("7. pendingCollection 猫砂 5袋 + LLM 返回 draft qty=1 price/platform空 → 不得覆盖 qty=5", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  // 当前 collection 已有平台和价格
  const pendingCollection = buildReadyCatSandCollection()

  // 模拟 LLM 返回一个 qty=1、price/platform 为空的 draft（ itemName 相同）
  const llmDraftJson = JSON.stringify({
    kind: "draft",
    message: "猫砂我就按一袋记，今天补上。价格和平台这次先空着。",
    draft: {
      kind: "restock",
      itemName: "猫砂",
      qty: 1,
      unit: "袋",
      restockDate: NOW
    }
  })

  const turn = orch.normalizeLlmResponse(llmDraftJson, {
    text: "好的",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection,
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应返回 turn")
  // 不应创建新 collection（itemName 相同 → 应 merge）
  // 应返回 collection 或 proposal（merge 后字段已齐 → proposal）
  assert.ok(
    turn.kind === "collection" || turn.kind === "proposal",
    `期望 collection 或 proposal（merge 结果）, 实际: ${turn.kind}`
  )
  const draft = turn.kind === "collection" ? turn.collection.draft : turn.executableDraft
  const f = restockFields(draft)
  assert.equal(f.qty, 5, "qty 不得被 LLM 的 qty=1 覆盖")
  assert.equal(f.platform, "京东", "已有 platform 不得被清空")
  assert.equal(f.price, 128, "已有 price 不得被清空")
  assert.equal(f.itemName, "猫砂", "itemName 不应变")
  // 不应出现 LLM 的错误话术
  assert.ok(
    !turn.message.includes("按一袋记"),
    `不应含「按一袋记」, 实际: ${turn.message}`
  )
  assert.ok(
    !turn.message.includes("价格和平台先空着"),
    `不应含「价格和平台先空着」, 实际: ${turn.message}`
  )
})

// ---------- 8. "pdd 买的啊，刚才说了" → platform=拼多多, 已有字段不清空 ----------

test("8. pendingCollection 猫砂 5袋 + 「pdd 买的啊，刚才说了」→ platform=拼多多, 已有字段不清空", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  // 构造已有价格但缺平台的 collection
  const c = buildCatSandCollection()
  const pendingCollection = {
    ...c,
    draft: c.draft.kind === "restock"
      ? { ...c.draft, price: 110 }
      : { ...c.draft, restock: { ...c.draft.restock, price: 110 } },
    qualityMissingSlots: ["platform"]
  }

  const d = decide(orch, {
    text: "pdd 买的啊，刚才说了",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = draftFromDecision(d)
  const f = restockFields(draft)
  assert.equal(f.platform, "拼多多", "platform 应恢复为拼多多")
  assert.equal(f.price, 110, "已有 price 不应被清空")
  assert.equal(f.qty, 5, "qty 应保持 5")
  assert.equal(f.itemName, "猫砂", "itemName 不应变")
})

// ---------- 额外回归："确认" 在 missingQualityFields 时也触发保存 ----------

test("9. pendingCollection 猫砂 5袋 (missingQualityFields) + 「确认」→ 强确认触发保存", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  // 构造缺 quality 字段的 collection（有 qty/unit/date 但缺 price/platform）
  const pendingCollection = buildCatSandCollection()
  assert.equal(pendingCollection.completeness, "missingQualityFields")

  const d = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand", "「确认」在 missingQualityFields 时应强确认转 planCommand/draftCommit")
  assert.equal(d.turn.command.command, "draftCommit")
})
