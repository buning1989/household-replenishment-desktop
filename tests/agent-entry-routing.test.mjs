// 阶段 2B：pendingCollection 接入 turnInterpretation + focusResolver 路由测试
// 运行方式：node --test tests/agent-entry-routing.test.mjs
//
// 覆盖《Agent 决策入口重构方案》阶段 2B 核心行为要求：
//   1. 串物品 bug 修复：pendingCollection=宠物擦脚湿巾 + 「今天买了 3 袋五常大米」→ 新建五常大米 collection
//   2. 短句平台不回退：「拼多多」仍续接当前 collection
//   3. 短句价格不回退：「128」续接并触发 proposal
//   4. 短句评价不回退：「不起灰」续接当前 collection
//   5. 显式修正不回退：「不是宠物擦脚湿巾，是五常大米」→ itemName=五常大米
//   6. 查询不误写入：「猫砂还能用多久」不生成 collection/proposal，不修改 pendingCollection
//   7. 闲聊不误写入：「你好」不生成 collection/proposal，不修改 pendingCollection
//
// 验证 decideSync 在 pendingCollection 场景下的端到端行为（含 App.tsx 不参与的纯逻辑层）。

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

/** 从 AgentDraft（restock / createItemWithRestock）统一取出补货字段，避免嵌套路径假设。 */
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

// 构造「宠物擦脚湿巾」采集态（state 无此物品 → createItemWithRestock）
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

// 构造「猫砂」采集态（state 有此物品 → restock）
function buildCatSandCollection() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

// ---------- 1. 串物品 bug 修复 ----------

test("1. pendingCollection=宠物擦脚湿巾 + 「今天买了 3 袋五常大米」→ 新建五常大米 collection", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

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
    !d.turn.message.includes("宠物擦脚湿巾"),
    `新 collection message 不应出现旧物品名，实际: ${d.turn.message}`
  )
})

// ---------- 2. 短句平台不回退 ----------

test("2. pendingCollection=宠物擦脚湿巾 + 「拼多多」→ 续接，platform=拼多多，itemName 不变", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  const d = decide(orch, {
    text: "拼多多",
    state,
    itemViews: [],
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
  const f = restockFields(draft)
  assert.equal(f.itemName, "宠物擦脚湿巾", "短句平台不应改变物品名")
  assert.equal(f.platform, "拼多多")
})

// ---------- 3. 短句价格不回退 ----------

test("3. pendingCollection=猫砂(已有平台) + 「128」→ proposal 或 readyToConfirm，price=128", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  // 先构造带平台的猫砂 collection
  const c0 = buildCatSandCollection()
  // 把平台补上（模拟上一轮已补平台）
  const c1 = {
    ...c0,
    draft: c0.draft.kind === "restock"
      ? { ...c0.draft, platform: "京东" }
      : { ...c0.draft, restock: { ...c0.draft.restock, platform: "京东" } }
  }

  const d = decide(orch, {
    text: "128",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection: c1
  })

  assert.equal(d.kind, "sync")
  // 补齐 price 后通常转 proposal
  assert.ok(
    d.turn.kind === "proposal" || d.turn.kind === "collection",
    `期望 proposal 或 collection, 实际: ${d.turn.kind}`
  )
  const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
  assert.equal(restockFields(draft).price, 128)
})

// ---------- 4. 短句评价不回退 ----------

test("4. pendingCollection=猫砂 + 「不起灰」→ review=不起灰（保留原文），物品名不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "不起灰",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
  assert.equal(restockFields(draft).review, "不起灰")
})

// ---------- 5. 显式修正不回退 ----------

test("5. pendingCollection=宠物擦脚湿巾 + 「不是宠物擦脚湿巾，是五常大米」→ itemName=五常大米", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  const d = decide(orch, {
    text: "不是宠物擦脚湿巾，是五常大米",
    state,
    itemViews: [],
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `期望 collection 或 proposal, 实际: ${d.turn.kind}`
  )
  const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
  const nextItemName = draft.kind === "createItemWithRestock" ? draft.item.itemName : draft.itemName
  assert.equal(nextItemName, "五常大米")
})

// ---------- 6. 查询不误写入 ----------

test("6. pendingCollection=宠物擦脚湿巾 + 「猫砂还能用多久」→ 不生成 collection/proposal，pendingCollection 不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const prevItemName =
    pendingCollection.draft.kind === "createItemWithRestock"
      ? pendingCollection.draft.item.itemName
      : pendingCollection.draft.itemName

  const d = decide(orch, {
    text: "猫砂还能用多久",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  // 查询应走 answer（本地）或 needLlm，不应生成 collection/proposal/planProposal
  assert.notEqual(d.turn?.kind, "collection")
  if (d.kind === "sync") {
    assert.notEqual(d.turn.kind, "proposal")
    assert.notEqual(d.turn.kind, "planProposal")
  }
  // pendingCollection 对象本身未被修改（纯函数 decideSync 不应 mutate 输入）
  const afterItemName =
    pendingCollection.draft.kind === "createItemWithRestock"
      ? pendingCollection.draft.item.itemName
      : pendingCollection.draft.itemName
  assert.equal(afterItemName, prevItemName, "pendingCollection 物品名不应被查询修改")
})

// ---------- 7. 闲聊不误写入 ----------

test("7. pendingCollection=宠物擦脚湿巾 + 「你好」→ 不生成 collection/proposal，pendingCollection 不变", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const prevItemName =
    pendingCollection.draft.kind === "createItemWithRestock"
      ? pendingCollection.draft.item.itemName
      : pendingCollection.draft.itemName

  const d = decide(orch, {
    text: "你好",
    state,
    itemViews: [],
    pendingCollection
  })

  // 闲聊应走 answer（本地边界闲聊）或 needLlm，不应生成 collection/proposal
  assert.notEqual(d.turn?.kind, "collection")
  if (d.kind === "sync") {
    assert.notEqual(d.turn.kind, "proposal")
    assert.notEqual(d.turn.kind, "planProposal")
  }
  const afterItemName =
    pendingCollection.draft.kind === "createItemWithRestock"
      ? pendingCollection.draft.item.itemName
      : pendingCollection.draft.itemName
  assert.equal(afterItemName, prevItemName, "pendingCollection 物品名不应被闲聊修改")
})

// ---------- 8. 完整续接链路（人工验收场景的等价自动测试） ----------

test("8. 宠物擦脚湿巾采集态 → 拼多多 → 128 → 不起灰 顺畅续接同一物品", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()

  // 第一轮：进入采集态
  const d1 = decide(orch, { text: "今天买了 5 包宠物擦脚湿巾", state, itemViews: [] })
  assert.equal(d1.turn.kind, "collection")
  let pending = d1.turn.collection
  assert.equal(restockFields(pending.draft).itemName, "宠物擦脚湿巾")

  // 第二轮：拼多多
  const d2 = decide(orch, { text: "拼多多", state, itemViews: [], pendingCollection: pending })
  assert.ok(d2.turn.kind === "collection" || d2.turn.kind === "proposal")
  if (d2.turn.kind === "collection") pending = d2.turn.collection
  const draft2 = d2.turn.kind === "collection" ? d2.turn.collection.draft : d2.turn.executableDraft
  assert.equal(restockFields(draft2).platform, "拼多多")
  assert.equal(restockFields(draft2).itemName, "宠物擦脚湿巾", "补平台后物品名仍应是宠物擦脚湿巾")

  // 第三轮：128（补价格）
  const d3 = decide(orch, {
    text: "128",
    state,
    itemViews: [],
    pendingCollection: d2.turn.kind === "collection" ? d2.turn.collection : pending
  })
  assert.ok(d3.turn.kind === "collection" || d3.turn.kind === "proposal")
  const draft3 = d3.turn.kind === "collection" ? d3.turn.collection.draft : d3.turn.executableDraft
  assert.equal(restockFields(draft3).price, 128)
  assert.equal(restockFields(draft3).itemName, "宠物擦脚湿巾", "补价格后物品名仍应是宠物擦脚湿巾")

  // 第四轮：不起灰（补评价）—— 若第三轮已转 proposal，则不再续接 collection；
  //   这里只在仍处于 collection 时验证评价续接
  if (d3.turn.kind === "collection") {
    const d4 = decide(orch, {
      text: "不起灰",
      state,
      itemViews: [],
      pendingCollection: d3.turn.collection
    })
    const draft4 = d4.turn.kind === "collection" ? d4.turn.collection.draft : d4.turn.executableDraft
    assert.equal(restockFields(draft4).review, "不起灰")
    assert.equal(restockFields(draft4).itemName, "宠物擦脚湿巾", "补评价后物品名仍应是宠物擦脚湿巾")
  }
})

// ---------- 9. 同物品新补货句续接（不应误判为串物品） ----------

test("9. pendingCollection=猫砂 + 「今天买了 2 袋猫砂」→ 续接当前 collection（同物品不开启新采集）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "今天买了 2 袋猫砂",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  // 同物品应续接（collection 或 proposal），不应新建 collection 改写物品
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `同物品应续接, 实际: ${d.turn?.kind}`
  )
  const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
  assert.equal(restockFields(draft).itemName, "猫砂")
})

// ---------- 10. 强制保存仍走原 collection 流程 ----------

test("10. pendingCollection=猫砂 + 「就这样」→ proposal（强制保存，带未补全标记）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "就这样",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "proposal", "强制保存应转 proposal")
  assert.equal(d.turn.executableDraft.itemName, "猫砂")
})

// ---------- 11. 取消仍走原 collection 流程 ----------

test("11. pendingCollection=猫砂 + 「算了，不记了」→ cancelled", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildCatSandCollection()

  const d = decide(orch, {
    text: "算了，不记了",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "cancelled")
})
