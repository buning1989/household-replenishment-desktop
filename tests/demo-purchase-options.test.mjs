// 403：比赛 Demo 常购商品数据完整性测试
//
// 运行方式：node --test tests/demo-purchase-options.test.mjs
//
// 覆盖任务文档第七节「自动化校验」：
//   1. items.length === 15
//   2. 每个物品 purchaseOptions.length >= 1
//   3. 每个商品 id/productName/unit 非空
//   4. 每个物品恰好有一个 isDefault === true 的商品
//   5. 默认商品单位与物品单位一致
//   6. 每条历史记录的 purchaseOptionId 都能在当前物品中找到
//   7. 每条历史记录的 purchaseProductName 与引用商品一致
//   8. 不存在"洗衣凝珠"
//   9. 猫砂固定记录和提醒状态不变
//  10. Demo 多次生成结果一致
//  11. 卷纸明确测试

import { test } from "node:test"
import assert from "node:assert/strict"
import { createDemoState, DEMO_ASSERTIONS, DEMO_REFERENCE_DATE } from "../src/shared/demo/demo-household-seed.mjs"

function startOfDay(timestamp) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// =====================================================================
// 1. 商品总数
// =====================================================================

test("1. items.length === 15", () => {
  const state = createDemoState()
  assert.equal(state.items.length, 15)
})

// =====================================================================
// 2. 每个物品至少有 1 个常购商品
// =====================================================================

test("2. 每个物品 purchaseOptions.length >= 1", () => {
  const state = createDemoState()
  const without = state.items.filter((item) => !item.purchaseOptions || item.purchaseOptions.length === 0)
  assert.equal(without.length, 0, `缺常购商品: ${without.map((i) => i.name).join(", ")}`)
})

// =====================================================================
// 3. 每个商品字段完整
// =====================================================================

test("3. 每个商品 id/productName/unit 非空", () => {
  const state = createDemoState()
  const invalid = []
  for (const item of state.items) {
    for (const opt of item.purchaseOptions || []) {
      if (!opt.id || !opt.productName || !opt.unit) {
        invalid.push({ item: item.name, id: opt.id, productName: opt.productName, unit: opt.unit })
      }
    }
  }
  assert.equal(invalid.length, 0, `字段不完整: ${JSON.stringify(invalid)}`)
})

// =====================================================================
// 4. 常购商品 ID 全局唯一
// =====================================================================

test("4. 常购商品 ID 全局唯一", () => {
  const state = createDemoState()
  const ids = []
  for (const item of state.items) {
    for (const opt of item.purchaseOptions || []) {
      ids.push(opt.id)
    }
  }
  const unique = new Set(ids)
  assert.equal(ids.length, unique.size, `重复 ID: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`)
})

// =====================================================================
// 5. 每个物品恰好有一个 isDefault === true
// =====================================================================

test("5. 每个物品恰好有 1 个 isDefault=true", () => {
  const state = createDemoState()
  const wrong = state.items.filter((item) => {
    const defaults = (item.purchaseOptions || []).filter((opt) => opt.isDefault === true)
    return defaults.length !== 1
  })
  assert.equal(wrong.length, 0, `异常: ${wrong.map((i) => `${i.name}(${(i.purchaseOptions || []).filter((o) => o.isDefault).length}个默认)`).join(", ")}`)
})

// =====================================================================
// 6. 默认商品单位与物品单位一致
// =====================================================================

test("6. 默认商品单位与物品单位一致", () => {
  const state = createDemoState()
  const mismatches = []
  for (const item of state.items) {
    const defaultOpt = (item.purchaseOptions || []).find((opt) => opt.isDefault)
    if (defaultOpt && defaultOpt.unit !== item.unit) {
      mismatches.push({ item: item.name, itemUnit: item.unit, optUnit: defaultOpt.unit })
    }
  }
  assert.equal(mismatches.length, 0, `不一致: ${JSON.stringify(mismatches)}`)
})

// =====================================================================
// 7. 每条历史记录的 purchaseOptionId 都能在当前物品中找到
// =====================================================================

test("7. 每条历史记录的 purchaseOptionId 都能在当前物品中找到", () => {
  const state = createDemoState()
  const orphans = []
  for (const item of state.items) {
    const optionIds = new Set((item.purchaseOptions || []).map((opt) => opt.id))
    for (const event of item.history || []) {
      if (!event.purchaseOptionId || !optionIds.has(event.purchaseOptionId)) {
        orphans.push({ item: item.name, eventId: event.id, optionId: event.purchaseOptionId })
      }
    }
  }
  assert.equal(orphans.length, 0, `孤立记录: ${JSON.stringify(orphans)}`)
})

// =====================================================================
// 8. 每条历史记录的 purchaseProductName 与引用商品一致
// =====================================================================

test("8. 每条历史记录的 purchaseProductName 与引用商品一致", () => {
  const state = createDemoState()
  const mismatches = []
  for (const item of state.items) {
    const optionMap = new Map((item.purchaseOptions || []).map((opt) => [opt.id, opt.productName]))
    for (const event of item.history || []) {
      if (event.purchaseOptionId && event.purchaseProductName) {
        const expected = optionMap.get(event.purchaseOptionId)
        if (expected && expected !== event.purchaseProductName) {
          mismatches.push({ item: item.name, eventId: event.id, expected, actual: event.purchaseProductName })
        }
      }
    }
  }
  assert.equal(mismatches.length, 0, `不一致: ${JSON.stringify(mismatches)}`)
})

// =====================================================================
// 9. 不存在"洗衣凝珠"
// =====================================================================

test("9. 不存在洗衣凝珠", () => {
  const state = createDemoState()
  const found = state.items.filter((item) => item.name === "洗衣凝珠")
  assert.equal(found.length, 0)
})

// =====================================================================
// 10. 猫砂固定记录不变
// =====================================================================

test("10. 猫砂最近补货记录不变（2026-07-03, 2袋, ¥68）", () => {
  const state = createDemoState()
  const catLitter = state.items.find((item) => item.name === "猫砂")
  assert.ok(catLitter)
  const sorted = [...catLitter.history].sort((a, b) => a.at - b.at)
  const latest = sorted[sorted.length - 1]
  assert.equal(startOfDay(latest.at), DEMO_ASSERTIONS.catLitterLatestRestock.date)
  assert.equal(latest.qty, DEMO_ASSERTIONS.catLitterLatestRestock.qty)
  assert.equal(latest.price, DEMO_ASSERTIONS.catLitterLatestRestock.price)
})

// =====================================================================
// 11. Demo 多次生成结果一致（确定性）
// =====================================================================

test("11. Demo 多次生成结果一致", () => {
  const state1 = createDemoState()
  const state2 = createDemoState()
  // 比较关键数据（忽略 updatedAt 可能的差异，虽然 Demo 中也是固定的）
  assert.equal(state1.items.length, state2.items.length)
  for (let i = 0; i < state1.items.length; i++) {
    assert.equal(state1.items[i].id, state2.items[i].id)
    assert.equal(state1.items[i].name, state2.items[i].name)
    assert.equal(state1.items[i].purchaseOptions.length, state2.items[i].purchaseOptions.length)
    assert.equal(state1.items[i].history.length, state2.items[i].history.length)
  }
})

// =====================================================================
// 12. 卷纸明确测试
// =====================================================================

test("12.1. 卷纸至少有 1 个常购商品", () => {
  const state = createDemoState()
  const tp = state.items.find((item) => item.name === "卷纸")
  assert.ok(tp)
  assert.ok(tp.purchaseOptions.length >= 1, `实际 ${tp.purchaseOptions.length} 个`)
})

test("12.2. 卷纸默认商品名称包含'卷纸'", () => {
  const state = createDemoState()
  const tp = state.items.find((item) => item.name === "卷纸")
  const defaultOpt = tp.purchaseOptions.find((opt) => opt.isDefault)
  assert.ok(defaultOpt)
  assert.ok(defaultOpt.productName.includes("卷纸"), `实际: ${defaultOpt.productName}`)
})

test("12.3. 卷纸两条历史记录均关联到默认商品", () => {
  const state = createDemoState()
  const tp = state.items.find((item) => item.name === "卷纸")
  const defaultOpt = tp.purchaseOptions.find((opt) => opt.isDefault)
  assert.equal(tp.history.length, 2)
  for (const event of tp.history) {
    assert.equal(event.purchaseOptionId, defaultOpt.id, `记录 ${event.id} 未关联默认商品`)
  }
})

test("12.4. 卷纸默认商品名称为'维达蓝色经典卷纸 4 层 10 卷'", () => {
  const state = createDemoState()
  const tp = state.items.find((item) => item.name === "卷纸")
  const defaultOpt = tp.purchaseOptions.find((opt) => opt.isDefault)
  assert.equal(defaultOpt.productName, "维达蓝色经典卷纸 4 层 10 卷")
})

// =====================================================================
// 13. 15 个常购商品清单核对
// =====================================================================

test("13. 15 个常购商品清单核对", () => {
  const state = createDemoState()
  const expected = [
    { item: "猫砂", productName: "pidan 豆腐猫砂 2.4kg" },
    { item: "洗衣液", productName: "蓝月亮深层洁净洗衣液 3kg" },
    { item: "宠物擦脚湿巾", productName: "小佩宠物湿巾 80 抽" },
    { item: "抽纸", productName: "维达超韧抽纸 3 层 100 抽 × 12 包" },
    { item: "垃圾袋", productName: "妙洁加厚垃圾袋 30 只" },
    { item: "猫粮", productName: "皇家室内成猫粮 2kg" },
    { item: "卷纸", productName: "维达蓝色经典卷纸 4 层 10 卷" },
    { item: "厨房纸", productName: "心相印厨房纸 2 卷" },
    { item: "洗洁精", productName: "立白洗洁精 1.1kg" },
    { item: "洗手液", productName: "威露士泡沫洗手液 300ml" },
    { item: "牙膏", productName: "云南白药牙膏 120g" },
    { item: "洗发水", productName: "海飞丝去屑洗发水 750ml" },
    { item: "沐浴露", productName: "舒肤佳沐浴露 720ml" },
    { item: "大米", productName: "十月稻田五常大米 5kg" },
    { item: "保鲜袋", productName: "妙洁中号保鲜袋 100 只" },
  ]
  for (const { item: name, productName } of expected) {
    const item = state.items.find((i) => i.name === name)
    assert.ok(item, `消耗品 ${name} 不存在`)
    const defaultOpt = item.purchaseOptions.find((opt) => opt.isDefault)
    assert.ok(defaultOpt, `${name} 无默认常购商品`)
    assert.equal(defaultOpt.productName, productName, `${name} 商品名不符: 期望 ${productName}, 实际 ${defaultOpt.productName}`)
  }
})

// =====================================================================
// 14. 历史记录关联数量统计
// =====================================================================

test("14. 所有历史记录均关联到常购商品", () => {
  const state = createDemoState()
  let total = 0
  let linked = 0
  for (const item of state.items) {
    const optionIds = new Set((item.purchaseOptions || []).map((opt) => opt.id))
    for (const event of item.history || []) {
      total++
      if (event.purchaseOptionId && optionIds.has(event.purchaseOptionId)) {
        linked++
      }
    }
  }
  assert.equal(linked, total, `仅 ${linked}/${total} 条记录关联到常购商品`)
})

// =====================================================================
// 15. 历史记录 purchasePricingMode 为 spec
// =====================================================================

test("15. 所有历史记录 purchasePricingMode 为 spec", () => {
  const state = createDemoState()
  const wrong = []
  for (const item of state.items) {
    for (const event of item.history || []) {
      if (event.purchasePricingMode !== "spec") {
        wrong.push({ item: item.name, eventId: event.id, mode: event.purchasePricingMode })
      }
    }
  }
  assert.equal(wrong.length, 0, `非 spec 模式: ${JSON.stringify(wrong)}`)
})
