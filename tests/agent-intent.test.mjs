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

const { classifyAgentIntent, classifyBatchIntent, shouldSkipQuickAnswerForAgent } = await import("../src/agent/intent.ts")

// ---------- 表驱动：单草稿意图 ----------

const INTENT_CASES = [
  // writeDraft（无 pending 也能命中）
  { text: "我在京东买了两袋猫粮花了128，帮我记一下", hasPending: false, expect: "writeDraft" },
  { text: "下单了一箱抽纸", hasPending: false, expect: "writeDraft" },
  { text: "购入了一瓶洗发水", hasPending: false, expect: "writeDraft" },
  { text: "入手了两包猫砂", hasPending: false, expect: "writeDraft" },
  { text: "囤了几箱纸巾", hasPending: false, expect: "writeDraft" },
  { text: "续上了一袋米", hasPending: false, expect: "writeDraft" },
  { text: "补了洗衣液", hasPending: false, expect: "writeDraft" },
  { text: "补货了两袋猫粮", hasPending: false, expect: "writeDraft" },
  { text: "收货了京东的快递", hasPending: false, expect: "writeDraft" },
  { text: "快递到了", hasPending: false, expect: "writeDraft" },
  { text: "记一笔昨天买的牙膏", hasPending: false, expect: "writeDraft" },
  { text: "记录一下上次买的猫罐头", hasPending: false, expect: "writeDraft" },
  { text: "帮我管一下家里的纸巾", hasPending: false, expect: "writeDraft" },
  { text: "以后提醒我买猫粮", hasPending: false, expect: "writeDraft" },
  { text: "加入清单：垃圾袋", hasPending: false, expect: "writeDraft" },
  { text: "帮我加一个洗发水", hasPending: false, expect: "writeDraft" },

  // confirmDraft（需要 pending）
  { text: "确认吧", hasPending: true, expect: "confirmDraft" },
  { text: "确认创建", hasPending: true, expect: "confirmDraft" },
  { text: "确认记录", hasPending: true, expect: "confirmDraft" },
  { text: "可以了", hasPending: true, expect: "confirmDraft" },
  { text: "就按这个", hasPending: true, expect: "confirmDraft" },
  { text: "没问题", hasPending: true, expect: "confirmDraft" },
  { text: "保存", hasPending: true, expect: "confirmDraft" },
  { text: "记上", hasPending: true, expect: "confirmDraft" },
  { text: "执行", hasPending: true, expect: "confirmDraft" },
  { text: "确认吧", hasPending: false, expect: "query" },

  // cancelDraft（需要 pending）
  { text: "算了", hasPending: true, expect: "cancelDraft" },
  { text: "撤销", hasPending: true, expect: "cancelDraft" },
  { text: "别记", hasPending: true, expect: "cancelDraft" },
  { text: "不要保存", hasPending: true, expect: "cancelDraft" },
  { text: "取消这条", hasPending: true, expect: "cancelDraft" },
  { text: "取消", hasPending: true, expect: "cancelDraft" },
  { text: "算了别记", hasPending: true, expect: "cancelDraft" },

  // pendingStatus（需要 pending）
  { text: "记了吗", hasPending: true, expect: "pendingStatus" },
  { text: "保存了吗", hasPending: true, expect: "pendingStatus" },
  { text: "创建了吗", hasPending: true, expect: "pendingStatus" },
  { text: "刚才那条写进去了吗", hasPending: true, expect: "pendingStatus" },
  { text: "记了吗", hasPending: false, expect: "query" },

  // reviseDraft（需要 pending）
  { text: "不是两袋，是一袋", hasPending: true, expect: "reviseDraft" },
  { text: "改成三袋", hasPending: true, expect: "reviseDraft" },
  { text: "换成京东", hasPending: true, expect: "reviseDraft" },
  { text: "价格错了", hasPending: true, expect: "reviseDraft" },
  { text: "数量错了", hasPending: true, expect: "reviseDraft" },
  { text: "平台错了", hasPending: true, expect: "reviseDraft" },
  { text: "商品名叫皇家猫粮", hasPending: true, expect: "reviseDraft" },
  { text: "昨天买的", hasPending: true, expect: "reviseDraft" },
  { text: "前天", hasPending: true, expect: "reviseDraft" },
  { text: "放到宠物用品", hasPending: true, expect: "reviseDraft" },
  { text: "分类改成厨房", hasPending: true, expect: "reviseDraft" },
  { text: "这个不好用，下次别推荐", hasPending: true, expect: "reviseDraft" },
  { text: "猫不爱吃", hasPending: true, expect: "reviseDraft" },

  // query（兜底）
  { text: "今天优先买什么", hasPending: false, expect: "query" },
  { text: "这周要补什么", hasPending: false, expect: "query" },
  { text: "哪些信息缺失", hasPending: false, expect: "query" },
  { text: "本月预算怎么样", hasPending: false, expect: "query" }
]

test("agent-intent: 表驱动单草稿意图分类", () => {
  for (const { text, hasPending, expect: expected } of INTENT_CASES) {
    const actual = classifyAgentIntent(text, hasPending)
    assert.equal(actual, expected, `text="${text}" hasPending=${hasPending}: 期望 ${expected}，实际 ${actual}`)
  }
})

test("agent-intent: shouldSkipQuickAnswerForAgent 仅在 writeDraft 时跳过", () => {
  assert.equal(shouldSkipQuickAnswerForAgent("买了两袋猫粮"), true)
  assert.equal(shouldSkipQuickAnswerForAgent("今天优先买什么"), false)
  assert.equal(shouldSkipQuickAnswerForAgent("帮我加一个洗发水"), true)
})

// ---------- 任务二：误确认 / 修订劫持修复 ----------

test("任务二验收: 有 pending 时「可以帮我看下预算吗」不是 confirmDraft", () => {
  // 含泛化词「可以」但整句长度 > 6，不应触发确认；含疑问信号「吗」也不应触发 revise
  assert.notEqual(classifyAgentIntent("可以帮我看下预算吗", true), "confirmDraft")
})

test("任务二验收: 「今天天气怎么样」不是 reviseDraft", () => {
  // 含 REVISE_KEYWORDS「今天」，但含疑问信号「怎么」，应透传给 LLM
  assert.notEqual(classifyAgentIntent("今天天气怎么样", true), "reviseDraft")
})

test("任务二验收: 「可以」单独仍是 confirmDraft", () => {
  assert.equal(classifyAgentIntent("可以", true), "confirmDraft")
})

test("任务二: 泛化应答 ≤ 6 字符命中 confirm", () => {
  assert.equal(classifyAgentIntent("可以", true), "confirmDraft")
  assert.equal(classifyAgentIntent("对的", true), "confirmDraft")
  assert.equal(classifyAgentIntent("好的", true), "confirmDraft")
  assert.equal(classifyAgentIntent("好吧", true), "confirmDraft")
  assert.equal(classifyAgentIntent("ok", true), "confirmDraft")
  assert.equal(classifyAgentIntent("OK", true), "confirmDraft")
})

test("任务二: 泛化应答 > 6 字符不命中 confirm", () => {
  assert.notEqual(classifyAgentIntent("可以帮我看下预算", true), "confirmDraft")
  assert.notEqual(classifyAgentIntent("对的可以帮我吗", true), "confirmDraft")
  assert.notEqual(classifyAgentIntent("好的帮我看看吧", true), "confirmDraft")
})

test("任务二: 明确动词不受长度限制", () => {
  assert.equal(classifyAgentIntent("确认吧，就这样定下来", true), "confirmDraft")
  assert.equal(classifyAgentIntent("没问题，按这个来就行", true), "confirmDraft")
  assert.equal(classifyAgentIntent("可以了，先这样记着", true), "confirmDraft")
  assert.equal(classifyAgentIntent("保存一下", true), "confirmDraft")
})

test("任务二: revise 含疑问信号透传 LLM", () => {
  assert.notEqual(classifyAgentIntent("价格改成多少", true), "reviseDraft")
  assert.notEqual(classifyAgentIntent("换成什么平台", true), "reviseDraft")
  assert.notEqual(classifyAgentIntent("京东可以吗", true), "reviseDraft")
  assert.notEqual(classifyAgentIntent("怎么改价格", true), "reviseDraft")
})

test("任务二: revise 整句 > 15 字符透传 LLM", () => {
  // 含 REVISE_KEYWORDS 但整句过长，透传给 LLM
  assert.notEqual(classifyAgentIntent("不是两袋是一袋请帮我改成两袋谢谢", true), "reviseDraft")
})

test("任务二: revise 正常短句仍命中", () => {
  // 确保修复不破坏既有 revise 用例
  assert.equal(classifyAgentIntent("不是两袋，是一袋", true), "reviseDraft")
  assert.equal(classifyAgentIntent("改成三袋", true), "reviseDraft")
  assert.equal(classifyAgentIntent("换成京东", true), "reviseDraft")
  assert.equal(classifyAgentIntent("昨天买的", true), "reviseDraft")
  assert.equal(classifyAgentIntent("这个不好用，下次别推荐", true), "reviseDraft")
})

test("任务二: 无 pending 时泛化词不命中 confirm", () => {
  assert.equal(classifyAgentIntent("可以", false), "query")
  assert.equal(classifyAgentIntent("好的", false), "query")
})

// ---------- 表驱动：批量草稿意图 ----------

const BATCH_CASES = [
  { text: "全部确认", expect: "batchConfirm" },
  { text: "确认全部", expect: "batchConfirm" },
  { text: "批量确认", expect: "batchConfirm" },
  { text: "都确认", expect: "batchConfirm" },
  { text: "确认吧", expect: "batchConfirm" },
  { text: "可以了", expect: "batchConfirm" },
  { text: "保存", expect: "batchConfirm" },
  { text: "全部取消", expect: "batchCancel" },
  { text: "取消全部", expect: "batchCancel" },
  { text: "都不要了", expect: "batchCancel" },
  { text: "全部跳过", expect: "batchCancel" },
  { text: "第二个跳过", expect: "batchCancelIndex", index: 1 },
  { text: "第二个取消", expect: "batchCancelIndex", index: 1 },
  { text: "第一个不要", expect: "batchCancelIndex", index: 0 },
  { text: "第三条算了", expect: "batchCancelIndex", index: 2 },
  { text: "第一个归到猫罐头", expect: "batchReviseIndex", index: 0 },
  { text: "第二个价格改成59.9", expect: "batchReviseIndex", index: 1 },
  { text: "第一个改成京东", expect: "batchReviseIndex", index: 0 },
  { text: "价格都改成59.9", expect: "batchReviseAll" },
  { text: "全部日期改成昨天", expect: "batchReviseAll" }
]

test("agent-intent: 表驱动批量草稿意图分类", () => {
  for (const { text, expect: expected, index } of BATCH_CASES) {
    const result = classifyBatchIntent(text)
    assert.ok(result, `text="${text}": 期望非 null 结果`)
    assert.equal(result.intent, expected, `text="${text}": 期望 ${expected}，实际 ${result.intent}`)
    if (index !== undefined) {
      assert.equal(result.index, index, `text="${text}": 期望 index=${index}，实际 index=${result.index}`)
    }
  }
})

test("agent-intent: 非批量意图返回 null", () => {
  assert.equal(classifyBatchIntent("今天优先买什么"), null)
  assert.equal(classifyBatchIntent(""), null)
})

test("agent-intent: 序号解析覆盖中文与阿拉伯数字", () => {
  assert.equal(classifyBatchIntent("第一个跳过").index, 0)
  assert.equal(classifyBatchIntent("第1个跳过").index, 0)
  assert.equal(classifyBatchIntent("第5个跳过").index, 4)
  assert.equal(classifyBatchIntent("第十个跳过").index, 9)
})
