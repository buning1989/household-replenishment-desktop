// 阶段 1：turnInterpretation 单测
// 运行方式：node --test tests/turn-interpretation.test.mjs
//
// 覆盖《Agent 决策入口重构方案》第十二条「测试计划」中阶段 1 必须覆盖的场景：
//   1. 完整新补货句「今天买了 3 袋五常大米」 → new_restock_record + 完整字段
//   2. 短句平台「拼多多」 → supplement_current_collection, platform=拼多多
//   3. 短句价格「128」 → supplement_current_collection, price=128
//   4. 短句评价「不起灰」 → supplement_current_collection, review=不起灰
//   5. 显式修正「不是宠物擦脚湿巾，是五常大米」 → correct_current_collection, itemName=五常大米
//   6. 取消「算了，不用记了」 → cancel_current_task
//   7. 删除「删除卫生间下的消耗品」 → delete_request
//   8. 查询「猫砂还能用多久」 → query_inventory
//   9. 二次确认删除「确认删除」 → confirm_current_task + hasDeleteSignal
//  10. 闲聊「你好」 → smalltalk
//  11. 兜底「xyzqw」 → unknown, confidence=low
//  12. 强制保存「就这样」 → force_proposal
//
// 注意：interpretUserTurn 是纯函数，不读取 pending 状态，也不写入 state。
// 因此本文件不构造 pendingCollection；所有场景只验证「这一轮输入」被如何解释。

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

const { interpretUserTurn } = await import("../src/agent/turnInterpretation.ts")
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

function interpret(text, state = makeState(), itemViews = []) {
  return interpretUserTurn({ text, state, itemViews, dateContext: DATE_CONTEXT })
}

// ---------- 1. 完整新补货句 ----------

test("1. 「今天买了 3 袋五常大米」 → new_restock_record，含 itemName/qty/unit", () => {
  const result = interpret("今天买了 3 袋五常大米")
  assert.equal(result.intent, "new_restock_record")
  assert.equal(result.fields.itemName, "五常大米")
  assert.equal(result.fields.quantity, 3)
  assert.equal(result.fields.unit, "袋")
  assert.equal(result.signals.hasPurchaseVerb, true)
  assert.equal(result.confidence, "high")
})

test("1b. 「买了 5 袋猫砂」（已知物品） → new_restock_record，itemName=猫砂", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = interpret("今天买了 5 袋猫砂", state)
  assert.equal(result.intent, "new_restock_record")
  assert.equal(result.fields.itemName, "猫砂")
  assert.equal(result.fields.quantity, 5)
  assert.equal(result.fields.unit, "袋")
})

// ---------- 2. 短句平台 ----------

test("2. 「拼多多」 → supplement_current_collection，platform=拼多多，hasOnlyShortField=true", () => {
  const result = interpret("拼多多")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.platform, "拼多多")
  assert.equal(result.signals.hasOnlyShortField, true)
  assert.equal(result.confidence, "high")
})

// ---------- 3. 短句价格 ----------

test("3. 「128」 → supplement_current_collection，price=128", () => {
  const result = interpret("128")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.price, 128)
  assert.equal(result.signals.hasOnlyShortField, true)
})

test("3a. 「45块」 → supplement_current_collection，price=45（本地高置信，不走 LLM）", () => {
  const result = interpret("45块")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.price, 45)
  assert.equal(result.signals.hasOnlyShortField, true)
  assert.equal(result.confidence, "high")
})

test("3b. 「36元」 → supplement_current_collection，price=36", () => {
  const result = interpret("36元")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.price, 36)
})

test("3c. 「128块钱」 → supplement_current_collection，price=128", () => {
  const result = interpret("128块钱")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.price, 128)
})

test("3d. 「45.5元」 → supplement_current_collection，price=45.5", () => {
  const result = interpret("45.5元")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.price, 45.5)
})

// ---------- 4. 短句评价 ----------

test("4. 「不起灰」 → supplement_current_collection，review=不起灰（保留原文）", () => {
  const result = interpret("不起灰")
  assert.equal(result.intent, "supplement_current_collection")
  assert.equal(result.fields.review, "不起灰")
  assert.equal(result.signals.hasOnlyShortField, true)
})

// ---------- 5. 显式修正 ----------

test("5. 「不是宠物擦脚湿巾，是五常大米」 → correct_current_collection，itemName=五常大米", () => {
  const result = interpret("不是宠物擦脚湿巾，是五常大米")
  assert.equal(result.intent, "correct_current_collection")
  assert.equal(result.fields.itemName, "五常大米")
  assert.equal(result.signals.hasExplicitCorrection, true)
  assert.equal(result.confidence, "high")
})

// ---------- 6. 取消 ----------

test("6. 「算了，不用记了」 → cancel_current_task", () => {
  const result = interpret("算了，不用记了")
  assert.equal(result.intent, "cancel_current_task")
  assert.equal(result.signals.hasCancelSignal, true)
  assert.equal(result.confidence, "high")
})

// ---------- 7. 删除请求 ----------

test("7. 「删除卫生间下的消耗品」 → delete_request", () => {
  const result = interpret("删除卫生间下的消耗品")
  assert.equal(result.intent, "delete_request")
  assert.equal(result.signals.hasDeleteSignal, true)
  assert.equal(result.confidence, "high")
})

test("7b. 「删除猫砂」 → delete_request（不能被物品名带入 new_restock）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = interpret("删除猫砂", state)
  assert.equal(result.intent, "delete_request")
  assert.equal(result.signals.hasDeleteSignal, true)
})

// ---------- 8. 查询 ----------

test("8. 「猫砂还能用多久」 → query_inventory", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = interpret("猫砂还能用多久", state)
  assert.equal(result.intent, "query_inventory")
})

// ---------- 9. 二次确认删除短语 ----------

test("9. 「确认删除」 → confirm_current_task，hasDeleteSignal=true", () => {
  const result = interpret("确认删除")
  assert.equal(result.intent, "confirm_current_task")
  assert.equal(result.signals.hasDeleteSignal, true)
  assert.equal(result.signals.hasConfirmSignal, true)
})

// ---------- 10. 闲聊 / 问候 ----------

test("10. 「你好」 → smalltalk", () => {
  const result = interpret("你好")
  assert.equal(result.intent, "smalltalk")
})

test("10b. 「你是谁」 → smalltalk", () => {
  const result = interpret("你是谁")
  assert.equal(result.intent, "smalltalk")
})

// ---------- 11. 兜底 ----------

test("11. 无法归类的输入「xyzqw」 → unknown，confidence=low", () => {
  const result = interpret("xyzqw")
  assert.equal(result.intent, "unknown")
  assert.equal(result.confidence, "low")
})

// ---------- 12. 强制保存 ----------

test("12. 「就这样」 → force_proposal", () => {
  const result = interpret("就这样")
  assert.equal(result.intent, "force_proposal")
  assert.equal(result.confidence, "high")
})

// ---------- 13. 空输入 ----------

test("13. 空输入 → unknown，confidence=low，reason 提示空输入", () => {
  const result = interpret("")
  assert.equal(result.intent, "unknown")
  assert.equal(result.confidence, "low")
  assert.match(result.reason, /空/)
})

// ---------- 14. 确认信号（普通「确认」） ----------

test("14. 「确认」 → confirm_current_task", () => {
  const result = interpret("确认")
  assert.equal(result.intent, "confirm_current_task")
  assert.equal(result.signals.hasConfirmSignal, true)
})

// ---------- 15. 预算管理 ----------

test("15. 「把月预算设成 800」 → manage_budget", () => {
  const result = interpret("把月预算设成 800")
  assert.equal(result.intent, "manage_budget")
})

// ---------- 16. 物品管理 ----------

test("16. 「帮我添加洗衣凝珠」 → manage_item", () => {
  const result = interpret("帮我添加洗衣凝珠")
  assert.equal(result.intent, "manage_item")
})
