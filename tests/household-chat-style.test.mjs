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

const { buildLocalDraftFromText, buildLocalClarification } = await import("../src/agent/drafts.ts")
const { answerHouseholdQuickly, buildChatDateContext, buildHouseholdChatStarter } = await import("../src/llm/householdChat.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["厨房", "卫生间", "洗衣清洁", "日常护理", "宠物用品", "母婴用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function catItem(id, name, category = "宠物用品", unit = "袋") {
  return {
    id, name, category, type: "learning",
    cycleDays: 14, bufferDays: 3, lastRestockedAt: 1, anchorEstimated: true,
    purchaseOptions: [], history: [], learningEnabled: true, source: "manual",
    confidence: "high", feedbackCount: 0, unit
  }
}

// 文案禁用词：message / draftIntro 中不应出现
const FORBIDDEN_PHRASES = [
  "我理解为", "我猜", "我估算", "根据模板", "根据常识",
  "待确认草稿", "确认创建", "确认记录",
  "bufferDays", "cycleDays"
]

function assertNoForbidden(text, label = "text") {
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.ok(!text.includes(phrase), `${label} 不应包含禁用词「${phrase}」，实际：${text}`)
  }
}

// 模拟 App.tsx 中的 draftIntro 逻辑（保持与源码同步）
function draftIntro(agentDraft) {
  if (agentDraft.kind === "createItem") {
    return `我先把「${agentDraft.itemName}」加进来，按 ${agentDraft.cycleDays} 天一轮帮你盯着。你要是没问题，我就先这么记下。`
  }
  if (agentDraft.kind === "restock") {
    return `「${agentDraft.itemName}」我先按这次补货记上，价格和平台没说也不影响。你要是没问题，我就这么保存。`
  }
  if (agentDraft.kind === "createItemWithRestock") {
    const qty = agentDraft.restock.qty
    const unit = agentDraft.restock.unit || agentDraft.item.unit || "件"
    const qtyText = qty ? `${qty}${unit}` : "这一笔"
    return `我先把「${agentDraft.item.itemName}」加进来，这次 ${qtyText} 也一起算作起始记录。你要是没问题，我就先这么记下。`
  }
  return `我先把「${agentDraft.productName}」放到「${agentDraft.itemName}」下面，之后你补货就能直接沿用。没问题我就保存。`
}

// ---------- 用例 1：无猫砂 item，用户「帮我加一袋猫砂」----------

test("用例1：无猫砂 item 时「帮我加一袋猫砂」生成 createItemWithRestock，文案符合管家口吻", () => {
  const state = makeState()
  const now = Date.now()
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const draft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  assert.ok(draft, "应解析出草稿")
  assert.equal(draft.kind, "createItemWithRestock")
  assert.equal(draft.item.itemName, "猫砂")
  assert.equal(draft.item.category, "宠物用品")
  assert.equal(draft.item.cycleDays, 14, "猫砂默认 14 天一轮")
  assert.equal(draft.item.bufferDays, 2, "bufferDays = min(2, cycleDays-1)")
  assert.equal(draft.item.unit, "袋")
  assert.equal(draft.restock.qty, 1)
  assert.equal(draft.restock.unit, "袋")
  assert.ok(draft.restock.restockDate !== undefined, "restockDate 应默认今天")

  const intro = draftIntro(draft)
  assert.ok(intro.includes("我先把「猫砂」加进来"), `intro 应包含「我先把「猫砂」加进来」，实际：${intro}`)
  assert.ok(intro.includes("1袋"), `intro 应包含数量 1袋，实际：${intro}`)
  assert.ok(intro.includes("你要是没问题，我就先这么记下"), `intro 应包含管家确认口吻，实际：${intro}`)
  assertNoForbidden(intro, "intro")
})

// ---------- 用例 2：有猫砂 item，用户「帮我加一袋猫砂」----------

test("用例2：有猫砂 item 时「帮我加一袋猫砂」生成 restock 草稿，不重复创建不追问", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const draft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  assert.ok(draft, "应解析出草稿")
  assert.equal(draft.kind, "restock", "应走 restock，不重复创建")
  assert.equal(draft.itemId, "i1")
  assert.equal(draft.qty, 1)
  assert.equal(draft.unit, "袋")
  assert.ok(draft.restockDate !== undefined, "restockDate 应默认今天")
  // 不应追问价格或平台
  const intro = draftIntro(draft)
  assert.ok(intro.includes("我先按这次补货记上"), `intro 应包含「我先按这次补货记上」，实际：${intro}`)
  assert.ok(intro.includes("价格和平台没说也不影响"), `intro 应说明价格平台可空着，实际：${intro}`)
  assertNoForbidden(intro, "intro")
})

// ---------- 用例 3：有猫砂 item，用户「帮我加一个猫砂」----------

test("用例3：有猫砂 item 时「帮我加一个猫砂」返回 clarification，不生成 createItem draft", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  const clarification = buildLocalClarification("帮我加一个猫砂", state)
  assert.ok(clarification, "应返回 clarification")
  assert.ok(clarification.question.includes("猫砂已经在管了"), `question 应包含「猫砂已经在管了」，实际：${clarification.question}`)
  assert.ok(clarification.options.length >= 2, "应至少有 2 个选项")
  assert.ok(clarification.options.some((o) => o.label.includes("补货")), "选项应包含补货")
  assert.ok(clarification.options.some((o) => o.label.includes("提醒") || o.label.includes("节奏")), "选项应包含改提醒节奏")
  // 不应同时生成 createItem 草稿
  const draft = buildLocalDraftFromText("帮我加一个猫砂", state)
  if (draft) {
    assert.notEqual(draft.kind, "createItem", "不应生成 createItem 草稿（会重复创建）")
  }
})

// ---------- 用例 4：多个猫相关 item，用户「加一个猫」----------

test("用例4：多个猫相关 item 时「加一个猫」返回 clarification 让用户选具体物品", () => {
  const state = makeState({
    items: [
      catItem("i1", "猫砂"),
      catItem("i2", "猫粮"),
      catItem("i3", "猫罐头")
    ]
  })
  const clarification = buildLocalClarification("加一个猫", state)
  assert.ok(clarification, "应返回 clarification")
  assert.ok(
    clarification.question.includes("猫砂") && clarification.question.includes("猫粮"),
    `question 应同时提到猫砂和猫粮，实际：${clarification.question}`
  )
  assert.ok(clarification.question.includes("确认"), `question 应包含「确认」，实际：${clarification.question}`)
  assert.ok(clarification.options.length >= 2, "应至少有 2 个选项")
})

// ---------- 用例 5：这周查询严格区分 overdue 和 upcoming ----------

test("用例5：「这周可能要补什么」严格区分已逾期和未来 7 天，不把 6/28 当作未来", () => {
  // 构造 now = 2026-07-04 09:00 (UTC)
  const now = Date.UTC(2026, 6, 4, 9, 0, 0)
  const dateContext = buildChatDateContext(now)
  // 洗衣液 dueAt = 2026-06-28（已逾期 6 天）
  const overdueDueAt = Date.UTC(2026, 5, 28)
  // 抽纸 dueAt = 2026-07-08（未来 4 天）
  const upcomingDueAt = Date.UTC(2026, 6, 8)

  const state = makeState()
  const makeView = (item, dueAt, daysUntilDue) => ({
    item,
    computed: {
      status: daysUntilDue < 0 ? "urgent" : "warning",
      displayStatus: daysUntilDue < 0 ? "urgent" : "warning",
      statusLabel: daysUntilDue < 0 ? "急需补货" : "快用完",
      dueAt,
      depletionAt: dueAt,
      daysUntilDue,
      daysUntilDepletion: daysUntilDue,
      isDue: daysUntilDue <= 0,
      isSnoozed: false,
      remainingText: daysUntilDue < 0 ? `已用完 ${-daysUntilDue} 天` : `还剩约 ${daysUntilDue} 天`,
      statusText: daysUntilDue < 0 ? "急需补货" : "快用完"
    }
  })
  const views = [
    makeView({ id: "i1", name: "洗衣液", category: "洗衣清洁", type: "learning", cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: false, purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋" }, overdueDueAt, -6),
    makeView({ id: "i2", name: "抽纸", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 2, lastRestockedAt: 1, anchorEstimated: false, purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "包" }, upcomingDueAt, 4)
  ]

  const answer = answerHouseholdQuickly("这周可能要补什么", state, views, dateContext)
  assert.ok(answer, "应有回答")
  // 应包含「先处理已经到点的」+ 洗衣液（overdue）
  assert.ok(answer.includes("先处理已经到点的"), `应区分 overdue，实际：${answer}`)
  assert.ok(answer.includes("洗衣液"), `应提到洗衣液，实际：${answer}`)
  // 应包含「接下来 7 天」+ 抽纸（upcoming）
  assert.ok(answer.includes("接下来 7 天"), `应区分 upcoming，实际：${answer}`)
  assert.ok(answer.includes("抽纸"), `应提到抽纸，实际：${answer}`)
  // 不应出现「未来 7 天有 X 项」旧报表口吻
  assert.ok(!answer.includes("未来 7 天有"), `不应再出现「未来 7 天有 X 项」旧口吻，实际：${answer}`)
  // 不应把 6/28 作为未来分组的标题
  assert.ok(!/^[^\n]*6\/28[^\n]*$/m.test(answer), `不应把 6/28 当作未来分组标题，实际：${answer}`)
  assertNoForbidden(answer, "这周查询回答")
})

// ---------- 用例 6：「你是谁」返回短句，不长篇介绍 ----------

test("用例6：「你是谁」返回短句管家口吻，不长篇介绍", () => {
  const state = makeState()
  const answer = answerHouseholdQuickly("你是谁", state, [], buildChatDateContext(Date.UTC(2026, 6, 4)))
  assert.ok(answer, "应有回答")
  assert.ok(answer.includes("403 家庭管家"), `应包含「403 家庭管家」，实际：${answer}`)
  assert.ok(answer.includes("帮你盯着家里的消耗品"), `应包含管家职责，实际：${answer}`)
  // 不超过两句话：以句号/问号/感叹号分句，应 ≤ 2
  const sentences = answer.split(/[。？！]/).filter((s) => s.trim().length > 0)
  assert.ok(sentences.length <= 2, `应不超过两句话，实际 ${sentences.length} 句：${answer}`)
  // 不应出现长篇能力介绍
  assert.ok(!answer.includes("当前家里有"), `不应说「当前家里有」，实际：${answer}`)
  assert.ok(!answer.includes("我专门帮"), `不应说「我专门帮」，实际：${answer}`)
  assert.ok(!answer.includes("我的工作方式"), `不应说「我的工作方式」，实际：${answer}`)
  assertNoForbidden(answer, "身份回答")
})

// ---------- 文案禁用词全量校验 ----------

test("文案约束：所有 draft kind 的 draftIntro 都不含禁用词", () => {
  const samples = [
    { kind: "createItem", itemName: "洗发水", category: "日常护理", cycleDays: 30, bufferDays: 2, unit: "瓶" },
    { kind: "restock", itemName: "猫砂", qty: 1, unit: "袋" },
    { kind: "createItemWithRestock", item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 3, unit: "袋" }, restock: { qty: 1, unit: "袋" } },
    { kind: "addPurchaseOption", itemName: "卷纸", productName: "维达超韧", unit: "卷" }
  ]
  for (const draft of samples) {
    const intro = draftIntro(draft)
    assertNoForbidden(intro, `${draft.kind} intro`)
  }
})

// ---------- starter 文案应是管家口吻 ----------

test("starter 文案：空状态用管家口吻引导用户开口", () => {
  const emptyStarter = buildHouseholdChatStarter([])
  assert.ok(emptyStarter.includes("咱们") || emptyStarter.includes("跟我说"), `空状态 starter 应口语化，实际：${emptyStarter}`)
  assert.ok(!emptyStarter.includes("请添加"), `空状态 starter 不应像系统提示，实际：${emptyStarter}`)
})

test("starter 文案：有 urgent 时提示今天优先买什么", () => {
  const item = catItem("i1", "猫砂")
  item.lastRestockedAt = 1
  const views = [{
    item,
    computed: {
      status: "urgent", displayStatus: "urgent", statusLabel: "急需补货",
      dueAt: 1, depletionAt: 1, daysUntilDue: 0, daysUntilDepletion: 0,
      isDue: true, isSnoozed: false,
      remainingText: "已用完", statusText: "急需补货"
    }
  }]
  const starter = buildHouseholdChatStarter(views)
  assert.ok(starter.includes("急需补货"), `应提示急需补货，实际：${starter}`)
  assert.ok(starter.includes("今天优先"), `应引导今天优先看，实际：${starter}`)
})

// ---------- answerHouseholdQuickly 文案不应出现禁用词 ----------

test("answerHouseholdQuickly 文案：预算回答不含禁用词", () => {
  const state = makeState({ settings: { monthlyBudget: 500 } })
  const answer = answerHouseholdQuickly("本月预算怎么样", state, [])
  assert.ok(answer)
  assertNoForbidden(answer, "预算回答")
})

test("answerHouseholdQuickly 文案：今天优先买什么不含禁用词", () => {
  const state = makeState()
  const item = catItem("i1", "猫砂")
  const views = [{
    item,
    computed: {
      status: "urgent", displayStatus: "urgent", statusLabel: "急需补货",
      dueAt: 1, depletionAt: 1, daysUntilDue: 0, daysUntilDepletion: 0,
      isDue: true, isSnoozed: false,
      remainingText: "已用完", statusText: "急需补货"
    }
  }]
  const answer = answerHouseholdQuickly("今天优先买什么", state, views)
  assert.ok(answer)
  assertNoForbidden(answer, "今天优先回答")
})
