import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if ((specifier.startsWith(".") || specifier.startsWith("..")) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(specifier + ".ts", context)
      }
      throw error
    }
  }
})

const { buildManagedItemsLine } = await import("../src/llm/householdChat.ts")

// ---------- 任务二：系统提示物品示例动态化 ----------

test("buildManagedItemsLine: 空物品列表返回兜底句", () => {
  assert.equal(buildManagedItemsLine([]), "这个家庭刚开始建立消耗品档案。")
})

test("buildManagedItemsLine: null/undefined 安全返回兜底句", () => {
  assert.equal(buildManagedItemsLine(null), "这个家庭刚开始建立消耗品档案。")
  assert.equal(buildManagedItemsLine(undefined), "这个家庭刚开始建立消耗品档案。")
})

test("buildManagedItemsLine: 物品名含空白被裁剪", () => {
  const items = [{ name: "  猫砂  " }, { name: "猫粮" }]
  const line = buildManagedItemsLine(items)
  assert.ok(line.includes("猫砂") && line.includes("猫粮"))
  assert.ok(!line.includes("  "))
})

test("buildManagedItemsLine: 多于 5 个物品只取前 5", () => {
  const items = ["纸巾", "洗衣液", "牙膏", "猫砂", "猫粮", "洗发水", "垃圾袋"].map((name) => ({ name }))
  const line = buildManagedItemsLine(items)
  // 前 5 个应出现，第 6/7 个不应出现
  for (const name of ["纸巾", "洗衣液", "牙膏", "猫砂", "猫粮"]) {
    assert.ok(line.includes(name), `应包含 ${name}`)
  }
  assert.ok(!line.includes("洗发水"), "不应包含第 6 个物品")
  assert.ok(!line.includes("垃圾袋"), "不应包含第 7 个物品")
})

test("buildManagedItemsLine: 正好 5 个物品全部出现", () => {
  const items = ["纸巾", "洗衣液", "牙膏", "猫砂", "猫粮"].map((name) => ({ name }))
  const line = buildManagedItemsLine(items)
  assert.equal(line, "你熟悉这个家庭已经管理的纸巾、洗衣液、牙膏、猫砂、猫粮等消耗品。")
})

test("buildManagedItemsLine: 单个物品", () => {
  const items = [{ name: "猫砂" }]
  assert.equal(buildManagedItemsLine(items), "你熟悉这个家庭已经管理的猫砂等消耗品。")
})

test("buildManagedItemsLine: 物品名为空字符串被过滤", () => {
  const items = [{ name: "" }, { name: "  " }, { name: "猫砂" }]
  const line = buildManagedItemsLine(items)
  assert.equal(line, "你熟悉这个家庭已经管理的猫砂等消耗品。")
})

test("buildManagedItemsLine: 全部物品名为空时返回兜底句", () => {
  const items = [{ name: "" }, { name: "  " }]
  assert.equal(buildManagedItemsLine(items), "这个家庭刚开始建立消耗品档案。")
})

test("buildManagedItemsLine: 用顿号分隔，末尾带「等消耗品」", () => {
  const items = [{ name: "猫砂" }, { name: "猫粮" }]
  const line = buildManagedItemsLine(items)
  assert.ok(line.includes("猫砂、猫粮"))
  assert.ok(line.endsWith("等消耗品。"))
})
