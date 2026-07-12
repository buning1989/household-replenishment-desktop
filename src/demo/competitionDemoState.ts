// 比赛 Demo State（Web 端专用）
//
// 复用现有 src/shared/demo/demo-household-seed.mjs 的 createDemoState()，
// 不重新写第二套重复数据。
//
// Web 端规则：
// - 首次访问（localStorage 无数据）→ 自动注入比赛 Demo State
// - 已有数据 → 正常读取，不覆盖
// - "一键恢复比赛 Demo State" → 完整替换当前数据
//
// 禁止把 Demo 数据放回通用 createInitialState()，避免污染真实用户数据。

import type { AppState } from "../types"
import { isDesktopRuntime } from "../runtime/runtimeBridge"

// 复用已有的 Demo 数据生成函数（.mjs 模块，返回 any，此处做类型断言）
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs 模块无类型声明，返回结构匹配 AppState
import { createDemoState as createDemoStateRaw } from "../shared/demo/demo-household-seed.mjs"

/**
 * 比赛 Web 端 localStorage Key。
 *
 * 升级到 v2 以强制刷新已有浏览器中的旧 Demo State：
 * 旧 v1 数据缺少常购商品，已部署新 Seed 后仍会显示空卡片。
 * v2 key 让首次访问的新部署自动加载包含商品数据的新 Demo State。
 *
 * 桌面端 Key（household_replenishment_desktop_v1）保持不变，不得修改。
 * 所有比赛 Web storage key 引用必须统一使用此常量，不得重复硬编码。
 */
export const COMPETITION_WEB_STORAGE_KEY = "household_replenishment_competition_web_v2"

/**
 * 创建比赛 Demo State。
 * 复用 demo-household-seed.mjs 的 createDemoState()，
 * 确保桌面端 seed 脚本和 Web 端使用同一份数据源。
 */
export function createCompetitionDemoState(): AppState {
  const state = createDemoStateRaw() as AppState
  return {
    ...state,
    // 清除 lastAgentMutation，进入干净状态
    lastAgentMutation: undefined
  }
}

/**
 * 重置为比赛 Demo State（Web 端用）。
 *
 * 与桌面端 resetToDemoState 的区别：
 * - 不需要备份文件（Web 数据在 localStorage，刷新即重置）
 * - 不需要保留 API Key 设置（Web 端 API Key 由服务端管理）
 * - 清理当前对话中的 pending draft / pending plan / clarification 等临时状态
 *
 * 返回可直接写入 localStorage 的干净 Demo State。
 */
export function resetCompetitionDemoState(): AppState {
  const demoState = createCompetitionDemoState()
  // updatedAt 设为当前时间，确保下次加载时不会被旧 localStorage 覆盖
  return {
    ...demoState,
    updatedAt: Date.now()
  }
}

/**
 * Web 首次访问时确保比赛 Demo State 已注入。
 *
 * 如果 localStorage 中不存在比赛数据，自动写入 Demo State 并返回。
 * 如果已有数据，返回 null（由调用方正常读取）。
 *
 * 仅在 Web 运行时生效；桌面端不做任何处理。
 */
export function ensureCompetitionDemoState(): AppState | null {
  if (isDesktopRuntime) return null

  try {
    const existing = localStorage.getItem(COMPETITION_WEB_STORAGE_KEY)
    if (existing) return null // 已有数据，不覆盖

    // 首次访问：注入比赛 Demo State
    const demoState = createCompetitionDemoState()
    localStorage.setItem(COMPETITION_WEB_STORAGE_KEY, JSON.stringify(demoState))
    return demoState
  } catch {
    // localStorage 不可用（隐私模式等），返回 null 让 loadState 走兜底
    return null
  }
}

/**
 * 清理 Web localStorage 中的临时状态（对话、pending agent 状态等）。
 * 在 demo reset 时调用，确保干净的演示状态。
 */
export function clearCompetitionTempState(): void {
  if (isDesktopRuntime) return

  try {
    // 清理损坏数据备份键
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && key.startsWith(`${COMPETITION_WEB_STORAGE_KEY}_corrupt_backup_`)) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // localStorage 不可用时静默忽略
  }
}
