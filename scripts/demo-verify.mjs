#!/usr/bin/env node

// Demo 数据完整性验证
//
// 读取已写入的 Demo state，检查所有核心约束是否成立。
// 不修改任何数据，只读验证。
//
// 用法：npm run demo:verify

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  createDemoState,
  DEMO_REFERENCE_DATE,
  DEMO_ASSERTIONS
} from "../src/shared/demo/demo-household-seed.mjs"

const STATE_FILENAME = "reminder-state.json"
const DAY_MS = 24 * 60 * 60 * 1000

// ---- 工具函数（与 app 的纯逻辑保持一致，避免引入 .ts 依赖） ----

function startOfDay(timestamp) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addDays(timestamp, days) {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return startOfDay(date.getTime())
}

function calendarDayNumber(timestamp) {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

function differenceInDays(later, earlier) {
  return calendarDayNumber(later) - calendarDayNumber(earlier)
}

function computeItemStatus(item, now) {
  const depletionAt = Number.isFinite(item.inventoryDepletionAt)
    ? startOfDay(item.inventoryDepletionAt)
    : addDays(item.lastRestockedAt, item.cycleDays)
  const dueAt = addDays(depletionAt, -item.bufferDays)
  const daysUntilDue = differenceInDays(dueAt, now)
  const daysUntilDepletion = differenceInDays(depletionAt, now)
  const status = daysUntilDepletion <= 0
    ? "urgent"
    : daysUntilDue <= 0
      ? "warning"
      : "normal"
  return { status, daysUntilDepletion, daysUntilDue, depletionAt, dueAt }
}

// ---- 路径查找（与 demo-seed.mjs 一致） ----

function getUserDataDirs() {
  const home = os.homedir()
  const platform = process.platform
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "household-replenishment-desktop"),
      path.join(home, "Library", "Application Support", "403家庭管家")
    ]
  } else if (platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    return [
      path.join(appdata, "household-replenishment-desktop"),
      path.join(appdata, "403家庭管家")
    ]
  } else {
    return [
      path.join(home, ".config", "household-replenishment-desktop"),
      path.join(home, ".config", "403家庭管家")
    ]
  }
}

function findStateFile() {
  if (process.env.DEMO_STATE_PATH) {
    return fs.existsSync(process.env.DEMO_STATE_PATH) ? process.env.DEMO_STATE_PATH : null
  }
  const dirs = getUserDataDirs()
  for (const dir of dirs) {
    const file = path.join(dir, STATE_FILENAME)
    if (fs.existsSync(file)) return file
  }
  return null
}

// ---- 验证框架 ----

let passCount = 0
let failCount = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passCount++
  } else {
    failCount++
    failures.push({ label, detail: detail || "" })
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

// ---- 主流程 ----

const stateFile = findStateFile()

if (!stateFile) {
  console.error("")
  console.error("[demo:verify] 未找到 reminder-state.json。")
  console.error("[demo:verify] 请先运行: npm run demo:seed")
  console.error("")
  process.exit(1)
}

let state
try {
  const raw = fs.readFileSync(stateFile, "utf8")
  state = JSON.parse(raw)
} catch (error) {
  console.error("")
  console.error("[demo:verify] 读取或解析失败:", error.message)
  console.error(`[demo:verify] 文件位置: ${stateFile}`)
  process.exit(1)
}

console.log("")
console.log(`[demo:verify] 验证文件: ${stateFile}`)
console.log(`[demo:verify] 参考日期: 2026-07-12 (DEMO_REFERENCE_DATE)`)
console.log("")

const now = DEMO_REFERENCE_DATE
const items = Array.isArray(state.items) ? state.items : []
const historyCount = items.reduce((sum, item) => sum + (Array.isArray(item.history) ? item.history.length : 0), 0)

// ---- 1. 商品总数 ----
check(
  `商品总数 = ${DEMO_ASSERTIONS.itemCount}（实际 ${items.length}）`,
  items.length === DEMO_ASSERTIONS.itemCount,
  `期望 ${DEMO_ASSERTIONS.itemCount}，实际 ${items.length}`
)

// ---- 2. 补货记录总数 ----
check(
  `补货记录总数在 ${DEMO_ASSERTIONS.minHistoryCount}-${DEMO_ASSERTIONS.maxHistoryCount} 范围内（实际 ${historyCount}）`,
  historyCount >= DEMO_ASSERTIONS.minHistoryCount && historyCount <= DEMO_ASSERTIONS.maxHistoryCount,
  `实际 ${historyCount} 条`
)

// ---- 3. 分类数量 ----
check(
  `分类数量 = ${DEMO_ASSERTIONS.categoryCount}（实际 ${state.categories?.length}）`,
  Array.isArray(state.categories) && state.categories.length === DEMO_ASSERTIONS.categoryCount,
  `期望 ${DEMO_ASSERTIONS.categoryCount}，实际 ${state.categories?.length}`
)

// ---- 4. 核心商品存在且唯一 ----
for (const expected of DEMO_ASSERTIONS.requiredItems) {
  const matches = items.filter((item) => item.name === expected.name)
  check(
    `商品"${expected.name}"存在且唯一（实际 ${matches.length} 个）`,
    matches.length === 1,
    `期望 1 个，实际 ${matches.length} 个`
  )
  if (matches.length === 1) {
    const item = matches[0]
    check(
      `商品"${expected.name}"单位为"${expected.unit}"`,
      item.unit === expected.unit,
      `期望 ${expected.unit}，实际 ${item.unit}`
    )
    check(
      `商品"${expected.name}"分类为"${expected.category}"`,
      item.category === expected.category,
      `期望 ${expected.category}，实际 ${item.category}`
    )
  }
}

// ---- 5. 禁止商品不存在 ----
for (const forbidden of DEMO_ASSERTIONS.forbiddenItems) {
  const matches = items.filter((item) => item.name === forbidden)
  check(
    `商品"${forbidden}"不存在（实际 ${matches.length} 个）`,
    matches.length === 0,
    `期望不存在，实际找到 ${matches.length} 个`
  )
}

// ---- 6. 猫砂最近补货记录 ----
const catLitter = items.find((item) => item.name === "猫砂")
if (catLitter) {
  const sortedHistory = [...catLitter.history].sort((a, b) => a.at - b.at)
  const latest = sortedHistory[sortedHistory.length - 1]
  const expected = DEMO_ASSERTIONS.catLitterLatestRestock

  check(
    `猫砂最近补货日期为 2026-07-03`,
    latest && startOfDay(latest.at) === expected.date,
    `期望 ${expected.date}，实际 ${latest ? startOfDay(latest.at) : "无记录"}`
  )
  check(
    `猫砂最近补货数量为 ${expected.qty} 袋`,
    latest && latest.qty === expected.qty,
    `期望 ${expected.qty}，实际 ${latest ? latest.qty : "无"}`
  )
  check(
    `猫砂最近补货金额为 ${expected.price} 元`,
    latest && latest.price === expected.price,
    `期望 ${expected.price}，实际 ${latest ? latest.price : "无"}`
  )
  check(
    `猫砂 lastRestockedAt 与最近补货记录一致`,
    startOfDay(catLitter.lastRestockedAt) === expected.date,
    `期望 ${expected.date}，实际 ${startOfDay(catLitter.lastRestockedAt)}`
  )

  // ---- 7. 猫砂预计剩余天数 ----
  const computed = computeItemStatus(catLitter, now)
  check(
    `猫砂预计剩余天数在 ${DEMO_ASSERTIONS.catLitterRemainingRange.min}-${DEMO_ASSERTIONS.catLitterRemainingRange.max} 范围内（实际 ${computed.daysUntilDepletion} 天）`,
    computed.daysUntilDepletion >= DEMO_ASSERTIONS.catLitterRemainingRange.min &&
    computed.daysUntilDepletion <= DEMO_ASSERTIONS.catLitterRemainingRange.max,
    `实际剩余 ${computed.daysUntilDepletion} 天`
  )

  // ---- 8. 猫砂状态为 warning ----
  check(
    `猫砂状态为 warning（即将需要关注）`,
    computed.status === DEMO_ASSERTIONS.catLitterStatus,
    `期望 ${DEMO_ASSERTIONS.catLitterStatus}，实际 ${computed.status}`
  )

  // ---- 9. 猫砂至少 3 条历史记录 ----
  check(
    `猫砂至少 3 条历史记录（实际 ${sortedHistory.length} 条）`,
    sortedHistory.length >= 3,
    `实际 ${sortedHistory.length} 条`
  )
}

// ---- 10. 不存在重复商品 ----
const nameCounts = {}
for (const item of items) {
  nameCounts[item.name] = (nameCounts[item.name] || 0) + 1
}
const duplicates = Object.entries(nameCounts).filter(([_, count]) => count > 1)
check(
  `不存在重复商品名`,
  duplicates.length === 0,
  duplicates.length ? `重复: ${duplicates.map(([name, count]) => `${name}(${count})`).join(", ")}` : ""
)

// ---- 11. 不存在未来补货记录 ----
function formatLocalDate(timestamp) {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const futureRecords = []
for (const item of items) {
  for (const event of item.history || []) {
    if (startOfDay(event.at) > now) {
      futureRecords.push({ item: item.name, date: formatLocalDate(event.at) })
    }
  }
}
check(
  `不存在未来补货记录`,
  futureRecords.length === 0,
  futureRecords.length ? `未来记录: ${futureRecords.map((r) => `${r.item}@${r.date}`).join(", ")}` : ""
)

// ---- 12. 不存在孤立补货记录 ----
// 所有补货记录的 purchaseOptionId 都能关联到商品的 purchaseOptions
const orphanRecords = []
for (const item of items) {
  const optionIds = new Set((item.purchaseOptions || []).map((opt) => opt.id))
  for (const event of item.history || []) {
    if (event.purchaseOptionId && !optionIds.has(event.purchaseOptionId)) {
      orphanRecords.push({ item: item.name, eventId: event.id, optionId: event.purchaseOptionId })
    }
  }
}
check(
  `所有补货记录的 purchaseOptionId 均能关联到商品`,
  orphanRecords.length === 0,
  orphanRecords.length ? `孤立记录: ${orphanRecords.map((r) => `${r.item}/${r.optionId}`).join(", ")}` : ""
)

// ---- 13. 同一商品补货日期按时间顺序排列 ----
let unsortedItems = []
for (const item of items) {
  const dates = (item.history || []).map((e) => e.at)
  const sorted = [...dates].sort((a, b) => a - b)
  if (JSON.stringify(dates) !== JSON.stringify(sorted)) {
    unsortedItems.push(item.name)
  }
}
check(
  `所有商品补货记录按时间升序排列`,
  unsortedItems.length === 0,
  unsortedItems.length ? `未排序: ${unsortedItems.join(", ")}` : ""
)

// ---- 14. 所有补货记录均能关联到商品 ----
// 已通过遍历 items.history 隐式验证（没有独立的补货记录表）

// ---- 15. 补货记录不早于商品创建时间 ----
const earlyRecords = []
for (const item of items) {
  const createdAt = startOfDay(item.createdAt)
  for (const event of item.history || []) {
    if (startOfDay(event.at) < createdAt) {
      earlyRecords.push({ item: item.name, eventDate: formatLocalDate(event.at), createdDate: formatLocalDate(createdAt) })
    }
  }
}
check(
  `补货记录不早于商品创建时间`,
  earlyRecords.length === 0,
  earlyRecords.length ? `过早记录: ${earlyRecords.map((r) => `${r.item}@${r.eventDate}<${r.createdDate}`).join(", ")}` : ""
)

// ---- 16. 家庭档案存在 ----
check(
  `家庭档案已填写`,
  state.householdProfile !== null && typeof state.householdProfile === "object",
  `实际: ${state.householdProfile}`
)
if (state.householdProfile) {
  check(`家庭人数 = 3`, state.householdProfile.residentCount === 3, `实际 ${state.householdProfile.residentCount}`)
  check(`儿童情况 = schoolAge`, state.householdProfile.children === "schoolAge", `实际 ${state.householdProfile.children}`)
  check(`宠物 = cat`, state.householdProfile.pets === "cat", `实际 ${state.householdProfile.pets}`)
}

// ---- 17. 洗衣液存在（支持"已存在"识别） ----
const detergent = items.find((item) => item.name === "洗衣液")
check(
  `洗衣液存在（支持"帮我加个消耗品叫洗衣液"识别为已存在）`,
  !!detergent,
  ""
)

// ---- 18. 状态差异覆盖 ----
const statusDistribution = {}
for (const item of items) {
  const { status } = computeItemStatus(item, now)
  statusDistribution[status] = (statusDistribution[status] || 0) + 1
}
check(
  `存在 warning 状态商品（即将需要补货）`,
  (statusDistribution.warning || 0) > 0,
  `分布: ${JSON.stringify(statusDistribution)}`
)
check(
  `存在 normal 状态商品（库存正常）`,
  (statusDistribution.normal || 0) > 0,
  `分布: ${JSON.stringify(statusDistribution)}`
)

// ---- 19. 最近刚补货商品 ----
const recentlyRestocked = items.filter((item) => {
  const daysSinceRestock = differenceInDays(now, startOfDay(item.lastRestockedAt))
  return daysSinceRestock >= 0 && daysSinceRestock <= 5
})
check(
  `存在最近 5 天内刚补货的商品（实际 ${recentlyRestocked.length} 个）`,
  recentlyRestocked.length > 0,
  recentlyRestocked.length ? `刚补货: ${recentlyRestocked.map((i) => i.name).join(", ")}` : "无"
)

// ---- 20. 历史数据较少的商品存在 ----
const sparseItems = items.filter((item) => (item.history || []).length === 1)
check(
  `存在仅 1 条历史记录的商品（展示系统还在学习周期）`,
  sparseItems.length > 0,
  sparseItems.length ? `稀疏商品: ${sparseItems.map((i) => i.name).join(", ")}` : "无"
)

// ---- 汇总 ----

console.log("")
console.log(`[demo:verify] 通过: ${passCount}`)
console.log(`[demo:verify] 失败: ${failCount}`)

if (failCount > 0) {
  console.error("")
  console.error("[demo:verify] 验证失败！请检查上述 FAIL 项。")
  console.error("")
  process.exit(1)
}

console.log("")
console.log("[demo:verify] 全部验证通过。")
console.log("")

// ---- 输出商品概览 ----

console.log("[demo:verify] 商品概览:")
console.log("")
for (const item of items) {
  const { status, daysUntilDepletion } = computeItemStatus(item, now)
  const statusLabel = status === "urgent" ? "急需补货" : status === "warning" ? "快用完" : "充足"
  const histCount = (item.history || []).length
  const latestDate = item.history?.[item.history.length - 1]?.at
  const latestDateStr = latestDate ? formatLocalDate(latestDate) : "无"
  console.log(
    `  ${item.name.padEnd(8)} | ${item.category.padEnd(6)} | ${item.unit.padEnd(2)} | ${statusLabel.padEnd(4)} | 剩余${daysUntilDepletion}天 | ${histCount}条记录 | 最近补货 ${latestDateStr}`
  )
}
console.log("")
