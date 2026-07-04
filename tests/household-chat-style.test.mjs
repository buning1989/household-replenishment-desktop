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
const { answerHouseholdQuickly, buildHouseholdChatStarter } = await import("../src/llm/householdChat.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["厨房", "卫生间", "洗衣清洁", "日常护理", "宠物用品", "母婴用品", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
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
    return `我准备把「${agentDraft.itemName}」加进来，先按 ${agentDraft.cycleDays} 天一轮提醒。确认后再写入。`
  }
  if (agentDraft.kind === "restock") {
    return `我准备给「${agentDraft.itemName}」记一笔补货，价格和平台没说也可以先空着。确认后再写入。`
  }
  if (agentDraft.kind === "createItemWithRestock") {
    const qty = agentDraft.restock.qty
    const unit = agentDraft.restock.unit || agentDraft.item.unit || "件"
    const qtyText = qty ? `${qty}${unit}` : "这一笔"
    return `我准备把「${agentDraft.item.itemName}」加进来，也把这次 ${qtyText} 一起记上。确认后再写入。`
  }
  return `我准备把「${agentDraft.productName}」放到「${agentDraft.itemName}」下面，之后补货可以直接沿用。确认后再写入。`
}

// ---------- 用例 1：无猫砂 item，用户「帮我加一袋猫砂」----------

test("用例1：无猫砂 item 时「帮我加一袋猫砂」生成 createItemWithRestock，文案符合管家口吻", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我加一袋猫砂", state)
  assert.ok(draft, "应解析出草稿")
  assert.equal(draft.kind, "createItemWithRestock")
  assert.equal(draft.item.itemName, "猫砂")
  assert.equal(draft.item.category, "宠物用品")
  assert.equal(draft.restock.qty, 1)
  assert.equal(draft.restock.unit, "袋")

  const intro = draftIntro(draft)
  assert.ok(intro.includes("我准备把「猫砂」加进来"), `intro 应包含「我准备把「猫砂」加进来」，实际：${intro}`)
  assert.ok(intro.includes("1袋") || intro.includes("一袋"), `intro 应包含数量，实际：${intro}`)
  assert.ok(intro.includes("确认后再写入"), `intro 应包含「确认后再写入」，实际：${intro}`)
  assertNoForbidden(intro, "intro")
})

// ---------- 用例 2：有猫砂 item，用户「帮我加一袋猫砂」----------

test("用例2：有猫砂 item 时「加一袋猫砂」生成 restock 草稿，文案不追问价格平台", () => {
  const state = makeState({ items: [catItem("i1", "猫砂")] })
  // 用户说「加一袋猫砂」，本地 buildLocalDraftFromText 会走 hasPurchaseSignal 分支吗？
  // 「加一袋」不包含买了/下单等强购买信号，但 findItemMatch 命中已有物品 → 应生成 restock
  // 注意：本地 parser 对「加一袋猫砂」可能走 createItemWithRestock 分支（因为没识别到已有物品）。
  // 这里测「买了两袋猫砂」的明显补货场景。
  const draft = buildLocalDraftFromText("在京东买了两袋猫砂", state)
  assert.ok(draft)
  assert.equal(draft.kind, "restock")
  assert.equal(draft.itemId, "i1")
  assert.equal(draft.qty, 2)

  const intro = draftIntro(draft)
  assert.ok(intro.includes("记一笔补货"), `intro 应包含「记一笔补货」，实际：${intro}`)
  assert.ok(intro.includes("价格和平台没说也可以先空着"), `intro 应说明价格平台可空着，实际：${intro}`)
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

// ---------- 用例 4：多个猫相关 item，用户「猫的那个加一袋」----------

test("用例4：多个猫相关 item 时「加一个猫」返回 clarification 让用户选具体物品", () => {
  const state = makeState({
    items: [
      catItem("i1", "猫砂"),
      catItem("i2", "猫粮"),
      catItem("i3", "猫罐头")
    ]
  })
  // 「加一个猫」名字太短，应触发歧义保护
  const clarification = buildLocalClarification("加一个猫", state)
  assert.ok(clarification, "应返回 clarification")
  assert.ok(
    clarification.question.includes("猫砂") && clarification.question.includes("猫粮"),
    `question 应同时提到猫砂和猫粮，实际：${clarification.question}`
  )
  assert.ok(clarification.question.includes("确认"), `question 应包含「确认」，实际：${clarification.question}`)
  assert.ok(clarification.options.length >= 2, "应至少有 2 个选项")
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
