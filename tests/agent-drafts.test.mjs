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

const { buildLocalDraftFromText, reviseAgentDraft } = await import("../src/agent/drafts.ts")
const { classifyAgentIntent, shouldSkipQuickAnswerForAgent } = await import("../src/agent/intent.ts")
const { commitAgentDraft } = await import("../src/agent/executor.ts")
const { answerHouseholdQuickly } = await import("../src/llm/householdChat.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    onboarding: {
      completed: true,
      rerun: false,
      currentStep: 1,
      skippedProfile: false,
      skipped: false,
      managedTemplateIds: [],
      notUsedTemplateIds: [],
      deferredTemplateIds: [],
      createdTemplateIds: [],
      inventoryStatuses: {}
    },
    updatedAt: 1,
    ...overrides
  }
}

test("agent: 创建消耗品草稿确认后新增 item，未确认前只是 draft", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("帮我添加洗衣凝珠", state)

  assert.equal(draft?.kind, "createItem")
  assert.equal(state.items.length, 0)

  const result = commitAgentDraft(state, draft, 1000)
  assert.equal(result.state.items.length, 1)
  assert.equal(result.state.items[0].name, "洗衣凝珠")
  assert.equal(result.state.items[0].category, "洗衣清洁")
  assert.match(result.summary, /已创建/)
})

test("agent: 买了20包卫生纸生成创建并补货草稿，确认后写入 history", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("买了20包卫生纸，帮我创建个补货单", state)

  assert.equal(draft?.kind, "createItemWithRestock")
  assert.equal(draft.restock.qty, 20)
  assert.equal(draft.restock.unit, "包")

  const result = commitAgentDraft(state, draft, 1000)
  const item = result.state.items.find((candidate) => candidate.name === "卫生纸")
  assert.ok(item)
  assert.equal(item.history.length, 1)
  assert.equal(item.history[0].qty, 20)
  assert.equal(item.history[0].purchaseUnit, "包")
})

test("agent: 购买语境不触发快捷预算回答，价格平台数量进入补货 draft", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("我在京东买了两瓶海飞丝的洗发水，花了100块钱", state)

  assert.equal(shouldSkipQuickAnswerForAgent("我在京东买了两瓶海飞丝的洗发水，花了100块钱"), true)
  assert.equal(draft?.kind, "createItemWithRestock")
  assert.equal(draft.restock.qty, 2)
  assert.equal(draft.restock.unit, "瓶")
  assert.equal(draft.restock.price, 100)
  assert.equal(draft.restock.platform, "京东")
})

test("agent: pending 草稿修订只改 draft，不执行写入", () => {
  const state = makeState()
  const draft = buildLocalDraftFromText("我在京东买了两瓶海飞丝的洗发水，花了100块钱", state)
  const revised = reviseAgentDraft(draft, "补货周期 150 天吧")

  assert.equal(revised?.kind, "createItemWithRestock")
  assert.equal(revised.item.cycleDays, 150)
  assert.equal(state.items.length, 0)
})

test("agent: pending 状态问题由本地状态机接住", () => {
  assert.equal(classifyAgentIntent("创建补货单了么", true), "pendingStatus")
  assert.equal(classifyAgentIntent("确认创建", true), "confirmDraft")
  assert.equal(classifyAgentIntent("取消", true), "cancelDraft")
})

test("agent: 下周补货查询按未来 7 天回答，不落到今天优先", () => {
  const state = makeState()
  const answer = answerHouseholdQuickly("我问的是下周", state, [{
    item: {
      id: "item-1",
      name: "洗衣液",
      category: "洗衣清洁",
      type: "learning",
      cycleDays: 30,
      bufferDays: 2,
      lastRestockedAt: 1,
      anchorEstimated: false,
      purchaseOptions: [],
      history: [],
      createdAt: 1,
      updatedAt: 1
    },
    computed: {
      status: "warning",
      displayStatus: "warning",
      statusLabel: "快用完",
      dueAt: 1,
      depletionAt: 1,
      daysUntilDue: 5,
      daysUntilDepletion: 7,
      isDue: false,
      isSnoozed: false,
      remainingText: "还剩约 7 天",
      statusText: "快用完"
    }
  }])

  assert.match(answer, /未来 7 天/)
  assert.match(answer, /洗衣液/)
  assert.doesNotMatch(answer, /今天优先/)
})
