#!/usr/bin/env node

// Demo Reset 终端命令
//
// 一键恢复比赛 Demo State。
// 复用 src/shared/demo/demo-reset-core.mjs 的核心逻辑。
//
// 用法：npm run demo:reset
//
// 注意：终端命令负责写入主进程 state 文件。
// 如果 Electron 应用正在运行，Renderer 的 localStorage 可能仍是旧状态。
// 建议在应用未运行时使用此命令，或使用设置页内的"恢复比赛演示数据"按钮。

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { performDemoReset } from "../src/shared/demo/demo-reset-core.mjs"

const STATE_FILENAME = "reminder-state.json"
const BACKUP_DIR_NAME = "demo-backups"

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
    return process.env.DEMO_STATE_PATH
  }
  const dirs = getUserDataDirs()
  for (const dir of dirs) {
    const file = path.join(dir, STATE_FILENAME)
    if (fs.existsSync(file)) return file
  }
  return path.join(dirs[0], STATE_FILENAME)
}

function findUserDataDir() {
  if (process.env.DEMO_STATE_PATH) {
    return path.dirname(process.env.DEMO_STATE_PATH)
  }
  const dirs = getUserDataDirs()
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return dir
  }
  return dirs[0]
}

function loadExistingState(file) {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---- 主流程 ----

console.log("Demo reset started")

const stateFile = findStateFile()
const userDataDir = findUserDataDir()
const backupDir = path.join(userDataDir, BACKUP_DIR_NAME)
const currentState = loadExistingState(stateFile)

const result = performDemoReset(currentState, stateFile, backupDir)

if (!result.ok) {
  console.error(`恢复失败: ${result.error}`)
  if (result.rolledBack) {
    console.error("已自动回滚到最近备份。")
  } else {
    console.error("未能自动回滚，原数据已保留。")
  }
  process.exit(1)
}

console.log("Backup created")
console.log(`  ${result.backupPath}`)
console.log("Main state written")
console.log(`  ${stateFile}`)

const itemCount = result.state.items.length
const historyCount = result.state.items.reduce((sum, item) => sum + item.history.length, 0)

console.log("Demo state verified")
console.log(`${itemCount} items`)
console.log(`${historyCount} restock records`)

// 检查是否保留了 API Key
if (currentState?.settings?.aiApiKey && result.state.settings.aiApiKey) {
  console.log("API Key preserved")
}

console.log("")
console.log("Demo reset completed")
console.log("")

// 如果应用正在运行，提示用户
if (currentState && currentState.items && currentState.items.length > 0) {
  console.log("提示：如果应用正在运行，请在设置页点击「恢复比赛演示数据」按钮，")
  console.log("      或重启应用以使 Renderer 同步加载 Demo 数据。")
}
