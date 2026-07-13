#!/usr/bin/env node

// Demo Seed 执行入口
//
// 将 Demo 家庭数据写入 Electron 的 userData/reminder-state.json。
// 仅用于空数据库：如果已有业务数据，停止并提示。
//
// 用法：npm run demo:seed

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createDemoState } from "../src/shared/demo/demo-household-seed.mjs"

const STATE_FILENAME = "reminder-state.json"

/**
 * 获取可能的 userData 目录列表（跨平台 + 开发/生产环境）。
 * 开发环境 Electron 使用 package.json 的 name 字段作为目录名；
 * 生产打包后使用 productName。
 */
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

/** 查找已存在的 state 文件，若不存在则返回第一个候选路径。
 *  支持通过 DEMO_STATE_PATH 环境变量覆盖路径，用于 CI/测试环境。
 */
function findStateFile() {
  if (process.env.DEMO_STATE_PATH) {
    return process.env.DEMO_STATE_PATH
  }
  const dirs = getUserDataDirs()
  for (const dir of dirs) {
    const file = path.join(dir, STATE_FILENAME)
    if (fs.existsSync(file)) return file
  }
  return path.join(dirs[0], STATE_FILENAME)
}

/** 尝试读取并解析现有 state */
function loadExistingState(file) {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---- 主流程 ----

const stateFile = findStateFile()
const existing = loadExistingState(stateFile)

// 安全检查：已有业务数据时停止
if (existing && Array.isArray(existing.items) && existing.items.length > 0) {
  console.error("")
  console.error("[demo:seed] 已停止：发现已有业务数据。")
  console.error(`[demo:seed] 文件位置: ${stateFile}`)
  console.error(`[demo:seed] 现有消耗品数量: ${existing.items.length}`)
  console.error("")
  console.error("[demo:seed] Demo Seed 仅用于空数据库，不会覆盖真实数据。")
  console.error("[demo:seed] 如需重置，请手动清空现有数据或使用一键恢复功能（下个任务实现）。")
  console.error("")
  process.exit(1)
}

// 确保目录存在
const dir = path.dirname(stateFile)
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true })
}

// 写入 Demo 数据
const demoState = createDemoState()
const jsonContent = JSON.stringify(demoState, null, 2)

try {
  fs.writeFileSync(stateFile, jsonContent, "utf8")
} catch (error) {
  console.error("")
  console.error("[demo:seed] 写入失败:", error.message)
  console.error(`[demo:seed] 目标路径: ${stateFile}`)
  process.exit(1)
}

const historyCount = demoState.items.reduce((sum, item) => sum + item.history.length, 0)

console.log("")
console.log("[demo:seed] Demo 数据已写入。")
console.log(`[demo:seed] 文件位置: ${stateFile}`)
console.log(`[demo:seed] 商品数量: ${demoState.items.length}`)
console.log(`[demo:seed] 补货记录: ${historyCount}`)
console.log(`[demo:seed] 分类数量: ${demoState.categories.length}`)
console.log(`[demo:seed] 家庭档案: ${demoState.householdProfile.residentCount} 人 / ${demoState.householdProfile.children} / ${demoState.householdProfile.pets}`)
console.log("")
console.log("[demo:seed] 启动应用后即可看到 Demo 数据。")
console.log("[demo:seed] 如需验证数据完整性，运行: npm run demo:verify")
console.log("")
