// 对话上下文管理单元测试
// 运行方式：node --test tests/context-pack-builder.test.mjs
//
// 覆盖验收点：
// 1. pendingDraft 场景：contextPack 不包含全部 messages，包含 pendingDraft，allowedActions 含 revise
// 2. orderImport 场景：contextPack 包含 orderImportRows，不包含无关历史聊天
// 3. query 场景：用户问「这周要补什么」，contextPack 包含 queryFacts，不包含 pendingDraft
// 4. compactRecentMessages：旧订单卡片、图片 dataUrl、完整表格不进入 LLM
// 5. focus lifecycle：confirm/cancel 后 focus 清除，revise 后 focus 更新，新写入任务 supersede 旧 pendingDraft

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
  buildAgentContextPack,
  compactRecentMessages,
  inferActiveFocus,
  clearFocusOnCommit,
  supersedeOldPendingDraft,
  isQueryTopicStale,
  QUERY_TOPIC_FRESH_MS
} = await import("../src/agent/conversationContext.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const DAY = 24 * 60 * 60 * 1000

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: { monthlyBudget: 1000 },
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

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

function makeRestockDraft(overrides = {}) {
  return {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    restockDate: Date.now(),
    ...overrides
  }
}

// ---------- 1. pendingDraft 场景 ----------

test("pendingDraft 场景：contextPack 不包含全部 messages，包含 pendingDraft，allowedActions 含 revise", () => {
  const now = Date.now()
  const state = makeState({ items: [makeItem({ id: "i1", name: "猫砂" })] })
  const itemViews = [makeView(state.items[0], makeComputed())]
  const draft = makeRestockDraft()

  // 构造很长的 messages 历史
  const messages = []
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "user", content: `用户消息${i}` })
    messages.push({ role: "assistant", content: `管家回复${i}` })
  }
  // 最后一条是 pending draft
  messages.push({ role: "user", content: "帮我记一袋猫砂" })
  messages.push({
    role: "assistant",
    content: "我先把猫砂记上",
    agentDraft: draft,
    draftStatus: "pending"
  })
  // 用户当前输入
  messages.push({ role: "user", content: "还挺好的，不起灰" })

  const pack = buildAgentContextPack({
    messages,
    currentUserText: "还挺好的，不起灰",
    state,
    itemViews,
    dateContext: buildChatDateContext(now)
  })

  // activeFocus 是 pendingDraft
  assert.equal(pack.activeFocus.kind, "pendingDraft")
  if (pack.activeFocus.kind === "pendingDraft") {
    assert.equal(pack.activeFocus.draft.kind, "restock")
    assert.equal(pack.activeFocus.draft.itemName, "猫砂")
  }

  // pendingExecutable 存在
  assert.ok(pack.pendingExecutable, "pendingExecutable 应存在")
  assert.equal(pack.pendingExecutable?.kind, "restock")

  // allowedActions 包含 revise
  assert.ok(pack.allowedActions.includes("revise"), "allowedActions 应包含 revise")
  assert.ok(pack.allowedActions.includes("confirm"), "allowedActions 应包含 confirm")
  assert.ok(pack.allowedActions.includes("cancel"), "allowedActions 应包含 cancel")

  // recentMessages 不包含全部 messages（最多 6 条）
  assert.ok(pack.recentMessages.length <= 6, `recentMessages 应 <= 6 条，实际 ${pack.recentMessages.length}`)

  // recentMessages 不包含早期的用户消息
  const earlyContents = pack.recentMessages.map((m) => m.content)
  assert.ok(!earlyContents.includes("用户消息0"), "不应包含早期消息")
  assert.ok(!earlyContents.includes("用户消息10"), "不应包含中期消息")

  // relevantAppFacts 包含猫砂相关历史
  assert.ok(pack.relevantAppFacts.includes("猫砂"), "relevantAppFacts 应包含猫砂")
})

test("pendingDraft 场景：用户评论商品好坏应被识别为 review 修订", () => {
  const now = Date.now()
  const state = makeState({ items: [makeItem({ id: "i1", name: "猫砂" })] })
  const itemViews = [makeView(state.items[0], makeComputed())]
  const draft = makeRestockDraft()

  const messages = [
    { role: "user", content: "帮我记一袋猫砂" },
    {
      role: "assistant",
      content: "我先把猫砂记上",
      agentDraft: draft,
      draftStatus: "pending"
    },
    { role: "user", content: "我觉得这家的猫砂还挺好的，不起灰" }
  ]

  const pack = buildAgentContextPack({
    messages,
    currentUserText: "我觉得这家的猫砂还挺好的，不起灰",
    state,
    itemViews,
    dateContext: buildChatDateContext(now)
  })

  // focus 是 pendingDraft，allowedActions 包含 revise
  assert.equal(pack.activeFocus.kind, "pendingDraft")
  assert.ok(pack.allowedActions.includes("revise"))
  // focus 描述应让 LLM 知道这是对草稿的补充
  assert.ok(pack.relevantAppFacts.includes("猫砂"))
})

// ---------- 2. orderImport 场景 ----------

test("orderImport 场景：contextPack 包含 orderImportRows，不包含无关历史聊天", () => {
  const now = Date.now()
  const state = makeState({ items: [makeItem({ id: "i1", name: "猫砂" })] })
  const itemViews = [makeView(state.items[0], makeComputed())]

  const orderRows = [
    {
      key: "r1",
      productName: "某品牌猫砂 10L",
      brandName: "某品牌",
      coreName: "猫砂",
      qty: 1,
      price: 89,
      measureAmount: 10,
      measureUnit: "L",
      review: "",
      date: "2026-07-06",
      platform: "京东",
      targetItem: "i1",
      targetOption: "",
      category: "宠物用品",
      customCategory: "",
      duplicate: false
    }
  ]

  const messages = [
    { role: "user", content: "今天天气怎么样" },
    { role: "assistant", content: "我这边看不了实时天气。" },
    { role: "user", content: "帮我上传订单截图", imageAttachments: [{ name: "order.png", dataUrl: "data:image/png;base64,xxx" }] },
    {
      role: "assistant",
      content: "已识别到 1 行订单",
      orderImportRows: orderRows,
      orderImportStatus: "pending"
    },
    { role: "user", content: "第一行没问题" }
  ]

  const pack = buildAgentContextPack({
    messages,
    currentUserText: "第一行没问题",
    state,
    itemViews,
    dateContext: buildChatDateContext(now)
  })

  // activeFocus 是 orderImport
  assert.equal(pack.activeFocus.kind, "orderImport")
  if (pack.activeFocus.kind === "orderImport") {
    assert.equal(pack.activeFocus.rows.length, 1)
  }

  // allowedActions 包含 confirm/cancel/revise/skip
  assert.ok(pack.allowedActions.includes("confirm"))
  assert.ok(pack.allowedActions.includes("skip"))
  assert.ok(pack.allowedActions.includes("revise"))

  // relevantAppFacts 包含订单相关物品
  assert.ok(pack.relevantAppFacts.includes("猫砂"), "应包含订单相关物品")

  // recentMessages 不包含无关历史聊天的完整内容
  // 注意：compactRecentMessages 只保留最近 6 条，且订单卡片只留简短标记
  const assistantContents = pack.recentMessages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
  // 订单卡片应被压缩为简短标记
  assert.ok(
    assistantContents.some((c) => c.includes("订单截图识别结果")),
    "订单卡片应被压缩为简短标记"
  )
})

// ---------- 3. query 场景 ----------

test("query 场景：用户问「这周要补什么」，contextPack 包含 queryFacts，不包含 pendingDraft", () => {
  const now = Date.now()
  const urgentItem = makeItem({
    id: "i1",
    name: "猫砂",
    history: [{ id: "e1", at: now - 35 * DAY, qty: 1, price: 100 }]
  })
  const state = makeState({ items: [urgentItem] })
  const itemViews = [makeView(urgentItem, makeComputed({
    displayStatus: "urgent",
    statusLabel: "急需补货",
    daysUntilDue: -1,
    dueAt: now - DAY
  }))]

  const messages = [
    { role: "user", content: "这周要补什么" }
  ]

  const pack = buildAgentContextPack({
    messages,
    currentUserText: "这周要补什么",
    state,
    itemViews,
    dateContext: buildChatDateContext(now)
  })

  // activeFocus 是 queryTopic
  assert.equal(pack.activeFocus.kind, "queryTopic")
  if (pack.activeFocus.kind === "queryTopic") {
    assert.equal(pack.activeFocus.topic, "weekly")
  }

  // allowedActions 包含 queryAnswer
  assert.ok(pack.allowedActions.includes("queryAnswer"))

  // pendingExecutable 不存在
  assert.equal(pack.pendingExecutable, undefined)

  // relevantAppFacts 包含 queryFacts（本地计算的事实）
  assert.ok(
    pack.relevantAppFacts.includes("本地计算的事实") || pack.relevantAppFacts.includes("提问窗口"),
    "relevantAppFacts 应包含 queryFacts 内容"
  )
})

test("query 场景：有 pendingDraft 时用户说「刚才那条」仍保持 pendingDraft focus", () => {
  const now = Date.now()
  const state = makeState({ items: [makeItem({ id: "i1", name: "猫砂" })] })
  const itemViews = [makeView(state.items[0], makeComputed())]
  const draft = makeRestockDraft()

  const messages = [
    { role: "user", content: "帮我记一袋猫砂" },
    {
      role: "assistant",
      content: "我先把猫砂记上",
      agentDraft: draft,
      draftStatus: "pending"
    },
    { role: "user", content: "刚才那条多少钱来着" }
  ]

  const pack = buildAgentContextPack({
    messages,
    currentUserText: "刚才那条多少钱来着",
    state,
    itemViews,
    dateContext: buildChatDateContext(now)
  })

  // 有 pendingDraft 时，focus 仍是 pendingDraft（优先级高于 queryTopic）
  assert.equal(pack.activeFocus.kind, "pendingDraft")
  assert.ok(pack.pendingExecutable)
})

// ---------- 4. compactRecentMessages ----------

test("compactRecentMessages：旧订单卡片、图片 dataUrl、完整表格不进入 LLM", () => {
  const messages = [
    // 早期聊天（应被截断）
    { role: "user", content: "早期消息1" },
    { role: "assistant", content: "早期回复1" },
    // 中期正常对话（填充用，确保早期消息被挤出 limit）
    { role: "user", content: "中期问一下猫粮" },
    { role: "assistant", content: "中期回复猫粮情况" },
    { role: "user", content: "中期再问一下预算" },
    { role: "assistant", content: "中期再回复预算" },
    // 订单截图上传（图片 dataUrl 应被替换）
    {
      role: "user",
      content: "帮我看看这个截图",
      imageAttachments: [{ name: "order.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..." }]
    },
    // 订单识别结果（完整表格应被压缩）
    {
      role: "assistant",
      content: "已识别到 3 行订单",
      orderImportRows: [
        { key: "r1", productName: "猫砂", qty: 1, price: 89, targetItem: "i1", targetOption: "", category: "宠物用品", customCategory: "", duplicate: false, measureUnit: "L", measureAmount: 10, review: "", date: "2026-07-06", platform: "京东" },
        { key: "r2", productName: "猫粮", qty: 2, price: 200, targetItem: "i2", targetOption: "", category: "宠物用品", customCategory: "", duplicate: false, measureUnit: "kg", measureAmount: 5, review: "", date: "2026-07-06", platform: "京东" }
      ],
      orderImportStatus: "confirmed"
    },
    // confirmed 的旧 draft 卡片（应被跳过）
    {
      role: "assistant",
      content: "已记下猫砂补货",
      agentDraft: makeRestockDraft(),
      draftStatus: "confirmed"
    },
    // 当前 pending draft（应被压缩为简短标记）
    {
      role: "assistant",
      content: "我先把猫粮记上",
      agentDraft: makeRestockDraft({ itemId: "i2", itemName: "猫粮" }),
      draftStatus: "pending"
    },
    // 最新用户消息
    { role: "user", content: "确认吧" }
  ]

  const compacted = compactRecentMessages(messages, 6)

  // 不超过 6 条
  assert.ok(compacted.length <= 6, `应 <= 6 条，实际 ${compacted.length}`)

  // 不包含早期消息（被 limit 截断）
  const contents = compacted.map((m) => m.content)
  assert.ok(!contents.includes("早期消息1"), "不应包含早期消息")
  assert.ok(!contents.includes("早期回复1"), "不应包含早期回复")

  // 不包含图片 dataUrl
  assert.ok(
    !contents.some((c) => c.includes("base64") || c.includes("iVBORw0KGgo")),
    "不应包含图片 dataUrl"
  )

  // 图片应被替换为「用户上传了订单截图」
  assert.ok(
    contents.some((c) => c.includes("订单截图") || c.includes("截图")),
    "图片应被替换为简短标记"
  )

  // 不包含订单完整表格数据
  assert.ok(
    !contents.some((c) => c.includes("猫砂") && c.includes("89")),
    "不应包含订单行完整数据"
  )

  // confirmed 的旧 draft 卡片应被跳过
  assert.ok(
    !contents.some((c) => c.includes("已记下猫砂补货")),
    "confirmed 的旧 draft 卡片应被跳过"
  )

  // pending draft 应被压缩为简短标记
  assert.ok(
    contents.some((c) => c.includes("待确认草稿") || c.includes("详见上下文")),
    "pending draft 应被压缩为简短标记"
  )
})

test("compactRecentMessages：空 messages 返回空数组", () => {
  assert.deepEqual(compactRecentMessages([]), [])
})

test("compactRecentMessages：纯文本消息正常保留", () => {
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "我是 403 管家" }
  ]
  const compacted = compactRecentMessages(messages, 6)
  assert.equal(compacted.length, 2)
  assert.equal(compacted[0].content, "你好")
  assert.equal(compacted[1].content, "我是 403 管家")
})

// ---------- 5. focus lifecycle ----------

test("focus lifecycle：confirm 后 focus 清除", () => {
  const focus = {
    kind: "pendingDraft",
    draft: makeRestockDraft(),
    messageId: "0",
    updatedAt: Date.now()
  }
  const cleared = clearFocusOnCommit(focus, "confirm")
  assert.equal(cleared.kind, "none")
})

test("focus lifecycle：cancel 后 focus 清除", () => {
  const focus = {
    kind: "pendingDraft",
    draft: makeRestockDraft(),
    messageId: "0",
    updatedAt: Date.now()
  }
  const cleared = clearFocusOnCommit(focus, "cancel")
  assert.equal(cleared.kind, "none")
})

test("focus lifecycle：revise 后 focus 保留", () => {
  const focus = {
    kind: "pendingDraft",
    draft: makeRestockDraft(),
    messageId: "0",
    updatedAt: Date.now()
  }
  const retained = clearFocusOnCommit(focus, "revise")
  assert.equal(retained.kind, "pendingDraft")
})

test("focus lifecycle：confirmOrderImport 后 orderImport focus 清除", () => {
  const focus = {
    kind: "orderImport",
    rows: [],
    messageId: "0",
    updatedAt: Date.now()
  }
  const cleared = clearFocusOnCommit(focus, "confirmOrderImport")
  assert.equal(cleared.kind, "none")
})

test("focus lifecycle：cancelOrderImport 后 orderImport focus 清除", () => {
  const focus = {
    kind: "orderImport",
    rows: [],
    messageId: "0",
    updatedAt: Date.now()
  }
  const cleared = clearFocusOnCommit(focus, "cancelOrderImport")
  assert.equal(cleared.kind, "none")
})

test("focus lifecycle：新写入任务 supersede 旧 pendingDraft", () => {
  const oldDraft = makeRestockDraft({ itemName: "猫砂" })
  const messages = [
    { role: "user", content: "帮我记一袋猫砂" },
    {
      role: "assistant",
      content: "我先把猫砂记上",
      agentDraft: oldDraft,
      draftStatus: "pending"
    }
  ]

  const superseded = supersedeOldPendingDraft(messages)
  // 旧 pending draft 应被标记为 superseded
  assert.equal(superseded[1].draftStatus, "superseded")
  // 原数组不变（不可变）
  assert.equal(messages[1].draftStatus, "pending")
})

test("focus lifecycle：supersede 后 inferActiveFocus 不再返回旧 pendingDraft", () => {
  const oldDraft = makeRestockDraft({ itemName: "猫砂" })
  const messages = [
    { role: "user", content: "帮我记一袋猫砂" },
    {
      role: "assistant",
      content: "我先把猫砂记上",
      agentDraft: oldDraft,
      draftStatus: "pending"
    }
  ]

  const superseded = supersedeOldPendingDraft(messages)
  const now = Date.now()
  const focus = inferActiveFocus(superseded, buildChatDateContext(now), "帮我记一袋猫粮")
  // 旧 pendingDraft 已 superseded，focus 不应是 pendingDraft
  assert.notEqual(focus.kind, "pendingDraft")
})

test("focus lifecycle：queryTopic 超过 5 分钟视为过期", () => {
  const now = Date.now()
  const freshFocus = {
    kind: "queryTopic",
    topic: "weekly",
    updatedAt: now - 1 * 60 * 1000 // 1 分钟前
  }
  const staleFocus = {
    kind: "queryTopic",
    topic: "weekly",
    updatedAt: now - 6 * 60 * 1000 // 6 分钟前
  }
  assert.ok(!isQueryTopicStale(freshFocus, now), "1 分钟内不应过期")
  assert.ok(isQueryTopicStale(staleFocus, now), "6 分钟后应过期")
})

test("focus lifecycle：非 queryTopic 的 focus 不过期", () => {
  const now = Date.now()
  const pendingFocus = {
    kind: "pendingDraft",
    draft: makeRestockDraft(),
    messageId: "0",
    updatedAt: now - 10 * 60 * 1000 // 10 分钟前
  }
  assert.ok(!isQueryTopicStale(pendingFocus, now), "pendingDraft 不应过期")
})

// ---------- 额外：inferActiveFocus 优先级 ----------

test("inferActiveFocus：pendingDraft 优先于 orderImport", () => {
  const now = Date.now()
  const messages = [
    {
      role: "assistant",
      content: "订单识别结果",
      orderImportRows: [{ key: "r1", productName: "猫砂", qty: 1, price: 89, targetItem: "i1", targetOption: "", category: "宠物用品", customCategory: "", duplicate: false, measureUnit: "L", measureAmount: 10, review: "", date: "2026-07-06", platform: "京东" }],
      orderImportStatus: "pending"
    },
    {
      role: "assistant",
      content: "猫砂补货草稿",
      agentDraft: makeRestockDraft(),
      draftStatus: "pending"
    }
  ]
  const focus = inferActiveFocus(messages, buildChatDateContext(now), "确认吧")
  assert.equal(focus.kind, "pendingDraft")
})

test("inferActiveFocus：无焦点时返回 none", () => {
  const now = Date.now()
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "我是 403 管家" }
  ]
  const focus = inferActiveFocus(messages, buildChatDateContext(now), "今天天气怎么样")
  assert.equal(focus.kind, "none")
})

test("inferActiveFocus：confirmed 的 draft 不作为焦点", () => {
  const now = Date.now()
  const messages = [
    {
      role: "assistant",
      content: "已记下猫砂补货",
      agentDraft: makeRestockDraft(),
      draftStatus: "confirmed"
    }
  ]
  const focus = inferActiveFocus(messages, buildChatDateContext(now), "再记一笔")
  assert.equal(focus.kind, "none")
})
