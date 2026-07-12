// Demo State 一键恢复共享核心逻辑
//
// 被 scripts/demo-reset.mjs（终端命令）和 electron/main.js（IPC handler）共同复用。
// 不依赖 React、Electron 或任何运行时环境，仅做纯计算和文件操作。
//
// 核心流程：
// 1. 从当前 state 提取需要保留的运行配置（API Key、模型、通知设置）
// 2. 调用 createDemoState() 生成标准 Demo 数据
// 3. 将保留的配置合并回 Demo State
// 4. 设置 updatedAt = Date.now() 确保 reconcileState 时 Demo State 胜出
// 5. 备份当前 state 到 demo-backups/ 目录（保留最近 3 份）

import fs from "node:fs"
import path from "node:path"
import { createDemoState, DEMO_ASSERTIONS } from "./demo-household-seed.mjs"

const MAX_BACKUPS = 3

/**
 * 从当前 state 中提取需要保留的运行配置。
 *
 * 保留的字段：
 * - aiApiKey：用户的 API Key
 * - aiChatModel：问答模型
 * - aiOrderModel：订单识别模型
 * - aiModel：旧版兼容模型
 * - notificationEnabled：通知开关
 * - reminderIntervalHours：提醒间隔
 * - quietStart / quietEnd：免打扰时段
 *
 * 不保留的字段（使用 Demo 默认值）：
 * - monthlyBudget：Demo 场景固定 800
 * - aiOrderMode：Demo 场景固定 accurate
 * - lastChatSessionAt：清空，进入新会话
 *
 * @param {object|null} currentState - 当前的 AppState
 * @returns {object} 需要保留的 settings 子集
 */
export function extractPreservedSettings(currentState) {
  if (!currentState || !currentState.settings) return {}
  const s = currentState.settings
  const preserved = {}
  // API Key 和模型配置
  if (s.aiApiKey) preserved.aiApiKey = s.aiApiKey
  if (s.aiChatModel) preserved.aiChatModel = s.aiChatModel
  if (s.aiOrderModel) preserved.aiOrderModel = s.aiOrderModel
  if (s.aiModel) preserved.aiModel = s.aiModel
  // 通知设置
  if (typeof s.notificationEnabled === "boolean") preserved.notificationEnabled = s.notificationEnabled
  if (typeof s.reminderIntervalHours === "number" && Number.isFinite(s.reminderIntervalHours)) {
    preserved.reminderIntervalHours = s.reminderIntervalHours
  }
  if (s.quietStart) preserved.quietStart = s.quietStart
  if (s.quietEnd) preserved.quietEnd = s.quietEnd
  return preserved
}

/**
 * 将保留的配置合并到 Demo State 中。
 *
 * @param {object} demoState - createDemoState() 返回的标准 Demo State
 * @param {object} preservedSettings - extractPreservedSettings() 返回的配置子集
 * @param {number} now - 当前时间戳，用于 updatedAt
 * @returns {object} 合并后的 AppState
 */
export function mergePreservedSettings(demoState, preservedSettings, now) {
  return {
    ...demoState,
    settings: {
      ...demoState.settings,
      ...preservedSettings
    },
    // updatedAt 设为当前时间，确保 reconcileState 时 Demo State 胜出
    updatedAt: now,
    // 清除 lastAgentMutation，进入干净状态
    lastAgentMutation: undefined
  }
}

/**
 * 准备完整的 Demo Reset State。
 * 调用 createDemoState() → 提取保留配置 → 合并 → 返回。
 *
 * @param {object|null} currentState - 当前的 AppState（用于提取配置）
 * @param {number} [now=Date.now()] - 当前时间戳
 * @returns {object} 可直接写入的 Demo Reset State
 */
export function prepareDemoResetState(currentState, now = Date.now()) {
  const demoState = createDemoState()
  const preserved = extractPreservedSettings(currentState)
  return mergePreservedSettings(demoState, preserved, now)
}

/**
 * 生成备份文件名。
 * @param {number} timestamp - 备份时间戳
 * @returns {string} 文件名，如 state-before-demo-reset-20260712-183000.json
 */
export function backupFileName(timestamp = Date.now()) {
  const d = new Date(timestamp)
  const pad = (n) => String(n).padStart(2, "0")
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `state-before-demo-reset-${dateStr}-${timeStr}.json`
}

/**
 * 创建当前 state 的备份，并清理旧备份（保留最近 MAX_BACKUPS 份）。
 *
 * @param {object|null} currentState - 要备份的 state
 * @param {string} backupDir - 备份目录路径
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function createBackup(currentState, backupDir) {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true })
    }
    const filename = backupFileName()
    const filepath = path.join(backupDir, filename)
    fs.writeFileSync(filepath, JSON.stringify(currentState, null, 2), "utf8")
    pruneBackups(backupDir)
    return { ok: true, path: filepath }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * 清理旧备份，只保留最近 MAX_BACKUPS 份。
 * 按文件名中的时间戳排序，删除最旧的。
 *
 * @param {string} backupDir - 备份目录路径
 */
function pruneBackups(backupDir) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith("state-before-demo-reset-") && f.endsWith(".json"))
      .sort() // 文件名包含时间戳，字典序 = 时间序
    if (files.length <= MAX_BACKUPS) return
    const toDelete = files.slice(0, files.length - MAX_BACKUPS)
    for (const f of toDelete) {
      fs.unlinkSync(path.join(backupDir, f))
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 原子写入 state 文件：先写 .tmp，校验后 rename。
 *
 * @param {string} stateFile - 目标文件路径（如 reminder-state.json）
 * @param {object} state - 要写入的 state
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function atomicWriteState(stateFile, state) {
  const tmpFile = stateFile + ".tmp"
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8")
    // 读回校验：确保 JSON 完整可解析
    const readBack = JSON.parse(fs.readFileSync(tmpFile, "utf8"))
    if (!readBack || !Array.isArray(readBack.items)) {
      throw new Error("写入校验失败：items 字段缺失")
    }
    fs.renameSync(tmpFile, stateFile)
    return { ok: true }
  } catch (error) {
    // 写入失败：清理临时文件，保留旧文件
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    return { ok: false, error: error.message }
  }
}

/**
 * 从备份目录中找到最近的备份文件路径。
 * 用于写入失败时的回滚。
 *
 * @param {string} backupDir - 备份目录路径
 * @returns {string|null} 最近的备份文件路径，或 null
 */
export function findLatestBackup(backupDir) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith("state-before-demo-reset-") && f.endsWith(".json"))
      .sort()
    if (files.length === 0) return null
    return path.join(backupDir, files[files.length - 1])
  } catch {
    return null
  }
}

/**
 * 从备份恢复 state 文件（原子写入）。
 *
 * @param {string} stateFile - 目标文件路径
 * @param {string} backupFile - 备份文件路径
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function restoreFromBackup(stateFile, backupFile) {
  try {
    const data = fs.readFileSync(backupFile, "utf8")
    const state = JSON.parse(data)
    return atomicWriteState(stateFile, state)
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * 内联验证 Demo State 的核心约束。
 * 与 demo-verify.mjs 保持一致，但不依赖外部脚本。
 *
 * @param {object} state - 要验证的 state
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyDemoState(state) {
  const errors = []

  // 商品总数
  if (!state.items || state.items.length !== DEMO_ASSERTIONS.itemCount) {
    errors.push(`商品数量应为 ${DEMO_ASSERTIONS.itemCount}，实际 ${state.items?.length ?? 0}`)
  }

  // 补货记录总数
  const historyCount = (state.items || []).reduce((sum, item) => sum + (item.history?.length || 0), 0)
  if (historyCount < DEMO_ASSERTIONS.minHistoryCount || historyCount > DEMO_ASSERTIONS.maxHistoryCount) {
    errors.push(`补货记录应在 ${DEMO_ASSERTIONS.minHistoryCount}-${DEMO_ASSERTIONS.maxHistoryCount} 范围内，实际 ${historyCount}`)
  }

  // 猫砂存在且唯一
  const catLitterItems = (state.items || []).filter((i) => i.name === "猫砂")
  if (catLitterItems.length !== 1) {
    errors.push(`猫砂应存在且唯一，实际 ${catLitterItems.length} 个`)
  }

  // 洗衣液存在且唯一
  const detergentItems = (state.items || []).filter((i) => i.name === "洗衣液")
  if (detergentItems.length !== 1) {
    errors.push(`洗衣液应存在且唯一，实际 ${detergentItems.length} 个`)
  }

  // 洗衣凝珠不存在
  const beadItems = (state.items || []).filter((i) => i.name === "洗衣凝珠")
  if (beadItems.length > 0) {
    errors.push(`洗衣凝珠应不存在，实际 ${beadItems.length} 个`)
  }

  // 核心商品存在
  for (const name of ["宠物擦脚湿巾", "抽纸", "垃圾袋"]) {
    if (!(state.items || []).some((i) => i.name === name)) {
      errors.push(`${name} 应存在`)
    }
  }

  // 猫砂最近补货记录
  if (catLitterItems.length === 1) {
    const cl = catLitterItems[0]
    const latest = (cl.history || []).slice().sort((a, b) => a.at - b.at).pop()
    const expected = DEMO_ASSERTIONS.catLitterLatestRestock
    if (!latest || latest.qty !== expected.qty || latest.price !== expected.price) {
      errors.push(`猫砂最近补货应为 ${expected.qty} 袋 / ${expected.price} 元`)
    }
  }

  // 不存在重复商品
  const names = (state.items || []).map((i) => i.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length > 0) {
    errors.push(`存在重复商品: ${dupes.join(", ")}`)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 完整的 Demo Reset 流程（用于终端脚本和 IPC handler）。
 *
 * 步骤：
 * 1. 备份当前 state
 * 2. 准备 Demo Reset State（含保留配置）
 * 3. 原子写入 state 文件
 * 4. 验证写入结果
 * 5. 失败时自动回滚
 *
 * @param {object|null} currentState - 当前 state
 * @param {string} stateFile - state 文件路径
 * @param {string} backupDir - 备份目录路径
 * @param {number} [now=Date.now()] - 当前时间戳
 * @returns {{ ok: true, state: object, backupPath: string } | { ok: false, error: string, rolledBack: boolean }}
 */
export function performDemoReset(currentState, stateFile, backupDir, now = Date.now()) {
  // 1. 备份
  const backupResult = createBackup(currentState, backupDir)
  if (!backupResult.ok) {
    return { ok: false, error: `备份失败: ${backupResult.error}`, rolledBack: false }
  }

  // 2. 准备 Demo State
  const demoState = prepareDemoResetState(currentState, now)

  // 3. 原子写入
  const writeResult = atomicWriteState(stateFile, demoState)
  if (!writeResult.ok) {
    // 写入失败：尝试回滚
    const latestBackup = findLatestBackup(backupDir)
    let rolledBack = false
    if (latestBackup) {
      const restoreResult = restoreFromBackup(stateFile, latestBackup)
      rolledBack = restoreResult.ok
    }
    return { ok: false, error: `写入失败: ${writeResult.error}`, rolledBack }
  }

  // 4. 验证
  const verification = verifyDemoState(demoState)
  if (!verification.ok) {
    // 验证失败：回滚
    const latestBackup = findLatestBackup(backupDir)
    let rolledBack = false
    if (latestBackup) {
      const restoreResult = restoreFromBackup(stateFile, latestBackup)
      rolledBack = restoreResult.ok
    }
    return { ok: false, error: `验证失败: ${verification.errors.join("; ")}`, rolledBack }
  }

  return { ok: true, state: demoState, backupPath: backupResult.path }
}
