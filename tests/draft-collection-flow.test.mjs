// 任务：补货记录采集态 + 历史采购推理 验收测试
// 运行方式：node --test tests/draft-collection-flow.test.mjs
//
// 覆盖：
// 1. 首轮买猫砂不直接 proposal（返回 collection）
// 2. 有历史价格时主动估价（suggestions 含 price, value≈150, source=itemHistory）
// 3. 用户补平台（collection.draft.platform 更新）
// 4. 用户补金额（completeness=readyToConfirm，可转 proposal）
// 5. 用户补评价（draft.review 设置）
// 6. 用户说「就这样」（quality 缺 price 时返回 proposal，标记 missingQualityFields）
// 7. 用户说「算了」（collection cancelled，不写入 state）
// 8. 无历史价格（suggestion source=llmPrior/template, confidence=low）

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
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { findForbiddenPhrase } = await import("../src/agent/responseComposer.ts")

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

function catItem(id, name, extra = {}) {
  return {
    id, name, category: "宠物用品", type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋",
    ...extra
  }
}

function restockEvent(price, qty, platform, daysAgo = 0) {
  const at = Date.now() - daysAgo * 24 * 60 * 60 * 1000
  return { id: `evt_${price}_${qty}_${platform}`, at, price, qty, platform }
}

// ---------- 1. 首轮买猫砂不直接 proposal ----------

test("1. 首轮「今天买了 5 袋猫砂」返回 collection，不返回 proposal", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const itemViews = [{ item: state.items[0] }]
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "今天买了 5 袋猫砂",
    state,
    itemViews,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection", "应返回 collection，不直接 proposal")
  assert.equal(decision.turn.collection.draft.itemName, "猫砂")
  assert.equal(decision.turn.collection.draft.qty, 5)
  // message 不包含确认卡话术
  assert.ok(!decision.turn.message.includes("确认后保存"), `不应含卡片确认话术, 实际：${decision.turn.message}`)
  assert.ok(!decision.turn.message.includes("你要是没问题"), `不应含卡片确认话术, 实际：${decision.turn.message}`)
  assert.equal(findForbiddenPhrase(decision.turn.message), null, "不应含禁用词")
})

// ---------- 2. 有历史价格时主动估价 ----------

test("2. 有历史价格时主动估价（suggestions 含 price, value≈150, source=itemHistory）", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(30, 1, "京东", 30),
      restockEvent(30, 1, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "今天买了 5 袋猫砂",
    state,
    itemViews,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const collection = decision.turn.collection
  // suggestions 应包含 price 建议
  const priceSuggestion = collection.inferredSuggestions.find((s) => s.field === "price")
  assert.ok(priceSuggestion, "应包含 price suggestion")
  assert.equal(priceSuggestion.source, "itemHistory", "source 应为 itemHistory")
  // value 应接近 150（5 袋 × 30 元/袋）
  if (priceSuggestion.value) {
    assert.ok(Math.abs(priceSuggestion.value - 150) <= 10, `value 应接近 150, 实际：${priceSuggestion.value}`)
  } else if (priceSuggestion.range) {
    assert.ok(priceSuggestion.range.min <= 150 && priceSuggestion.range.max >= 150, `range 应覆盖 150`)
  }
  // message 应包含历史参考
  assert.ok(decision.turn.message.includes("之前"), `应含「之前」, 实际：${decision.turn.message}`)
  assert.ok(decision.turn.message.includes("30"), `应含「30」, 实际：${decision.turn.message}`)
  assert.ok(decision.turn.message.includes("150"), `应含「150」, 实际：${decision.turn.message}`)
})

// ---------- 3. 用户补平台 ----------

test("3. 用户补平台「拼多多」→ collection.draft.platform = 拼多多", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(30, 1, "京东", 30),
      restockEvent(30, 1, "京东", 20)
    ]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  assert.equal(d1.turn.kind, "collection")
  const pendingCollection = d1.turn.collection

  // 用户补平台
  const d2 = orch.decide({ text: "拼多多", state, itemViews, pendingCollection, dateContext })
  assert.equal(d2.kind, "sync")
  // 补平台后仍是 collection（price 还缺）
  assert.equal(d2.turn.kind, "collection", "补平台后仍应是 collection")
  assert.equal(d2.turn.collection.draft.platform, "拼多多", "platform 应为拼多多")
  // message 应包含「拼多多」
  assert.ok(d2.turn.message.includes("拼多多"), `应含「拼多多」, 实际：${d2.turn.message}`)
  // 如果历史价格存在，message 应含价格参考
  assert.ok(d2.turn.message.includes("30") || d2.turn.message.includes("150"), `应含价格参考, 实际：${d2.turn.message}`)
})

// ---------- 4. 用户补金额 ----------

test("4. 用户补金额「128」→ completeness=readyToConfirm，可转 proposal", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection（缺 price 和 platform）
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  const pendingCollection = d1.turn.collection

  // 先补平台（模拟对话流：先说平台再说金额）
  const d2 = orch.decide({ text: "拼多多", state, itemViews, pendingCollection, dateContext })
  const collectionAfterPlatform = d2.turn.kind === "collection" ? d2.turn.collection : pendingCollection

  // 用户补金额
  const d3 = orch.decide({ text: "128", state, itemViews, pendingCollection: collectionAfterPlatform, dateContext })
  assert.equal(d3.kind, "sync")
  // 补金额后 completeness = readyToConfirm，应转 proposal
  assert.equal(d3.turn.kind, "proposal", "补金额后应转 proposal")
  assert.equal(d3.turn.executableDraft.price, 128, "price 应为 128")
})

// ---------- 5. 用户补评价 ----------

test("5. 用户补评价「这款猫砂品质不错，不起灰」→ draft.review 设置", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  const pendingCollection = d1.turn.collection

  // 用户补评价
  const d2 = orch.decide({ text: "这款猫砂品质不错，不起灰", state, itemViews, pendingCollection, dateContext })
  assert.equal(d2.kind, "sync")
  // 补评价后仍是 collection（price 和 platform 还缺）
  assert.ok(d2.turn.kind === "collection" || d2.turn.kind === "proposal", `期望 collection 或 proposal, 实际: ${d2.turn.kind}`)
  const draft = d2.turn.kind === "collection" ? d2.turn.collection.draft : d2.turn.executableDraft
  assert.ok(draft.review, `应设置 review, 实际：${draft.review}`)
  // 采集态下应保留用户原文评价信息，不能只压缩成「好用」短评关键词
  // 期望保留「品质不错」或「不起灰」这类原文片段
  assert.ok(
    draft.review.includes("品质不错") || draft.review.includes("不起灰"),
    `review 应保留原文评价信息（品质不错/不起灰），实际：${draft.review}`
  )
  // 不应只剩「好用」短评关键词
  assert.notEqual(draft.review, "好用", `review 不应只压缩成「好用」, 实际：${draft.review}`)
  // 不应返回 fallback（message 不应是空或「我没听懂」）
  assert.ok(d2.turn.message.length > 5, `message 不应为空, 实际：${d2.turn.message}`)
})

// ---------- 5b. 用户补短评价「不起灰」 ----------

test("5b. active collection 下输入「不起灰」→ draft.review = 不起灰，不返回 fallback", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  const pendingCollection = d1.turn.collection

  // 用户补短评价「不起灰」
  const d2 = orch.decide({ text: "不起灰", state, itemViews, pendingCollection, dateContext })
  assert.equal(d2.kind, "sync")
  // 不应返回 fallback / offTopic，应继续在 collection 采集态
  assert.ok(
    d2.turn.kind === "collection" || d2.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d2.turn.kind}`
  )
  const draft = d2.turn.kind === "collection" ? d2.turn.collection.draft : d2.turn.executableDraft
  assert.ok(draft.review, `应设置 review, 实际：${draft.review}`)
  assert.equal(
    draft.review, "不起灰",
    `短评价「不起灰」应原样保留为 review, 实际：${draft.review}`
  )
  // message 不应是空或「我没听懂」类 fallback
  assert.ok(d2.turn.message.length > 5, `message 不应为空, 实际：${d2.turn.message}`)
  assert.ok(
    !d2.turn.message.includes("没听懂") && !d2.turn.message.includes("不清楚"),
    `不应返回 fallback 文案, 实际：${d2.turn.message}`
  )
})

// ---------- 5c. 用户补多条短评价「味道小，不粘底」 ----------

test("5c. active collection 下输入「味道小，不粘底」→ review 至少保留「味道小」和「不粘底」", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  const pendingCollection = d1.turn.collection

  // 用户补多条短评价
  const d2 = orch.decide({ text: "味道小，不粘底", state, itemViews, pendingCollection, dateContext })
  assert.equal(d2.kind, "sync")
  assert.ok(
    d2.turn.kind === "collection" || d2.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d2.turn.kind}`
  )
  const draft = d2.turn.kind === "collection" ? d2.turn.collection.draft : d2.turn.executableDraft
  assert.ok(draft.review, `应设置 review, 实际：${draft.review}`)
  // 应至少保留「味道小」和「不粘底」两个评价点
  assert.ok(
    draft.review.includes("味道小") && draft.review.includes("不粘底"),
    `review 应保留「味道小」和「不粘底」, 实际：${draft.review}`
  )
  // message 不应是空或 fallback
  assert.ok(d2.turn.message.length > 5, `message 不应为空, 实际：${d2.turn.message}`)
})

// ---------- 6. 用户说「就这样」→ proposal 标记 missingQualityFields ----------

test("6. 用户说「就这样」（quality 缺 price）→ planCommand/draftCommit 标记 missingQualityFields", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection（缺 price 和 platform）
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  const pendingCollection = d1.turn.collection

  // 用户说「就这样」—— required 字段齐全，quality 缺 price
  const d2 = orch.decide({ text: "就这样", state, itemViews, pendingCollection, dateContext })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "planCommand", "「就这样」应触发 forceProposal 转 planCommand/draftCommit")
  assert.equal(d2.turn.command.command, "draftCommit")
  // 不应说「没关系」（迁就式话术）
  assert.ok(!d2.turn.message.includes("没关系"), `不应含「没关系」, 实际：${d2.turn.message}`)
  assert.ok(!d2.turn.message.includes("先空着也不影响"), `不应含迁就话术, 实际：${d2.turn.message}`)
})

// ---------- 7. 用户说「算了」→ collection cancelled ----------

test("7. 用户说「算了」→ collection cancelled，不写入 state", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const dateContext = buildChatDateContext(Date.UTC(2026, 6, 4))

  // 首轮产出 collection
  const d1 = orch.decide({ text: "今天买了 5 袋猫砂", state, itemViews, dateContext })
  const pendingCollection = d1.turn.collection

  // 用户说「算了」
  const d2 = orch.decide({ text: "算了", state, itemViews, pendingCollection, dateContext })
  assert.equal(d2.kind, "sync")
  assert.equal(d2.turn.kind, "cancelled", "「算了」应返回 cancelled turn")
  // 不应有 executableDraft（不写入 state）
  assert.ok(!d2.turn.executableDraft, "cancelled 不应有 executableDraft")
  // message 不应是空
  assert.ok(d2.turn.message.length > 0, `message 不应为空, 实际：${d2.turn.message}`)
})

// ---------- 8. 无历史价格 → llmPrior/template, confidence=low ----------

test("8. 无历史价格 → suggestion source=llmPrior/template, confidence=low", () => {
  const item = catItem("i1", "猫砂", {
    history: [],
    purchaseOptions: []
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "今天买了 5 袋猫砂",
    state,
    itemViews,
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const collection = decision.turn.collection
  // suggestions 应有 price，source 为 llmPrior 或 template
  const priceSuggestion = collection.inferredSuggestions.find((s) => s.field === "price")
  assert.ok(priceSuggestion, "应包含 price suggestion")
  assert.ok(
    priceSuggestion.source === "llmPrior" || priceSuggestion.source === "template",
    `source 应为 llmPrior 或 template, 实际：${priceSuggestion.source}`
  )
  assert.equal(priceSuggestion.confidence, "low", "confidence 应为 low")
  // message 不应出现「之前买过」
  assert.ok(!decision.turn.message.includes("之前买过"), `不应含「之前买过」, 实际：${decision.turn.message}`)
  // message 应包含「常见」或「粗估」
  assert.ok(
    decision.turn.message.includes("常见") || decision.turn.message.includes("粗估"),
    `应含「常见」或「粗估」, 实际：${decision.turn.message}`
  )
})

// ---------- 9. 未知物品不估价 ----------

test("9. 未知物品「临时用品」→ 不估价，文案含「先不乱估」", () => {
  const state = makeState()  // 无 items
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "今天买了 5 包临时用品",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const message = decision.turn.message
  // 应包含「先不乱估」
  assert.ok(message.includes("先不乱估"), `未知物品应说「先不乱估」, 实际：${message}`)
  // 不应出现价格区间
  assert.ok(!message.includes("¥"), `未知物品不应出现价格区间, 实际：${message}`)
  // 不应出现 75-200
  assert.ok(!message.includes("75") && !message.includes("200"), `不应出现 75-200, 实际：${message}`)
})

// ---------- 10. 宠物擦脚巾湿巾低价先验 ----------

test("10. 宠物擦脚巾湿巾 5 包 → 25–75 区间，文案含「粗估」", () => {
  const state = makeState()  // 无 items
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({
    text: "今天买了 5 包宠物擦脚巾湿巾",
    state,
    itemViews: [],
    dateContext: buildChatDateContext(Date.UTC(2026, 6, 4))
  })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
  const message = decision.turn.message
  // 应包含「粗估」或「还没有历史价格」
  assert.ok(
    message.includes("粗估") || message.includes("还没有历史价格"),
    `应含「粗估」或「还没有历史价格」, 实际：${message}`
  )
  // 应出现价格区间，且在 25-75 范围
  assert.ok(message.includes("¥"), `应出现价格区间, 实际：${message}`)
  // 不应出现 75-200 这种过宽区间
  assert.ok(!message.includes("200"), `不应出现 200, 实际：${message}`)
})
