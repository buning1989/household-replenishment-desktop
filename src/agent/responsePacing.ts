/**
 * 响应节奏层：避免本地规则命中时秒回造成机器感。
 *
 * 核心目标：建立「任务复杂度对应响应节奏」的机制。
 *   - confirm / cancel / committed：立即反馈（0-150ms）
 *   - pending draft 字段补充：300-600ms，显示「我记到这张单里。」
 *   - 身份 / 简单闲聊：300-500ms，不显示思考文案
 *   - 本地库存查询：600-900ms，显示「我看一下当前记录。」等
 *   - 价格 / 预算 / 历史分析：900-1500ms，显示「我对一下最近几次记录。」等
 *   - 订单截图识别：使用真实 loading，不额外假等待
 *   - 实时外部问题：300-500ms 后直接说明边界，不假装查询
 *
 * 本模块是纯函数，可被测试直接覆盖。
 * UI 集成（respondWithPacing）由 App.tsx 调用，不在本文件内做副作用。
 */

import type { AgentLocalIntent } from "./intent"
import type { AgentTurn } from "./orchestrator"
import { classifyConversationBoundary } from "./conversationBoundary"
import { detectQueryFactType } from "../llm/householdChat"

// ---------- 类型 ----------

/** 节奏分类：决定这一轮用多少延迟、是否显示思考文案 */
export type PacingCategory =
  | "confirmCancel" // 确认/取消/committed：立即反馈
  | "draftRevise" // pending draft 字段补充（数字、平台名、评价）
  | "identityCasual" // 身份/简单闲聊
  | "stockQuery" // 本地库存查询（本周/今天优先/缺信息）
  | "priceBudget" // 价格/预算/历史分析
  | "orderImport" // 订单截图识别（真实 loading）
  | "realtimeExternal" // 实时外部问题
  | "default" // 其他默认节奏

export type ResponseTiming = {
  /** 最小延迟毫秒数；实际耗时超过此值时不再额外等待 */
  minDelayMs: number
  /** 临时 loading 文案；为空表示只显示轻微 typing 指示器 */
  loadingText?: string
  /** 是否显示 typing 思考状态 */
  showTyping: boolean
}

/** getResponseTiming 输入参数 */
export type ResponseTimingInput = {
  /** 用户这一轮说的话 */
  text: string
  /** 本地意图分类（confirmDraft / cancelDraft / reviseDraft / writeDraft / pendingStatus / query） */
  intent: AgentLocalIntent | null
  /** orchestrator 决策出的 turn（sync 路径才有） */
  turn?: AgentTurn | null
  /** 是否处于 pending draft 上下文（用户在补充当前补货单） */
  hasPendingDraft: boolean
  /** 是否是订单截图识别流程（外层已用真实 loading） */
  isOrderImport?: boolean
}

// ---------- 节奏判定 ----------

/**
 * 根据意图、turn 和上下文，返回这一轮的响应节奏。
 *
 * 判定优先级（高 → 低）：
 *   1. confirmCancel：intent 命中 confirm/cancel，或 turn.kind 是 committed/cancelled
 *   2. orderImport：isOrderImport=true，使用真实 loading
 *   3. draftRevise：hasPendingDraft 且 intent=reviseDraft（字段补充、数字、平台名、评价）
 *   4. realtimeExternal：对话边界命中 realtimeExternal
 *   5. identityCasual：对话边界命中 identityOrMeta / casual
 *   6. priceBudget：queryFactType 命中 budget / priceAnomaly
 *   7. stockQuery：queryFactType 命中 thisWeek / nextWeek / today / missingInfo
 *   8. default：其他
 */
export function getResponseTiming(input: ResponseTimingInput): ResponseTiming {
  const category = categorizePacing(input)
  return timingForCategory(category)
}

/** 内部：把输入归到 PacingCategory */
function categorizePacing(input: ResponseTimingInput): PacingCategory {
  const { text, intent, turn, hasPendingDraft, isOrderImport } = input

  // 1. confirm / cancel / committed：立即反馈
  if (intent === "confirmDraft" || intent === "cancelDraft") return "confirmCancel"
  if (turn?.kind === "committed" || turn?.kind === "cancelled") return "confirmCancel"

  // 2. 订单截图识别：使用真实 loading
  if (isOrderImport) return "orderImport"

  // 3. pending draft 字段补充
  if (hasPendingDraft && intent === "reviseDraft") return "draftRevise"

  // 4-7. 按对话边界 / queryFactType 分类
  const boundary = classifyConversationBoundary(text)
  if (boundary === "realtimeExternal") return "realtimeExternal"
  if (boundary === "identityOrMeta" || boundary === "casual") return "identityCasual"

  const queryFact = detectQueryFactType(text)
  if (queryFact === "budget" || queryFact === "priceAnomaly") return "priceBudget"
  if (queryFact === "thisWeek" || queryFact === "nextWeek" || queryFact === "today" || queryFact === "missingInfo") {
    return "stockQuery"
  }

  return "default"
}

/** 内部：按 category 返回具体节奏 */
function timingForCategory(category: PacingCategory): ResponseTiming {
  switch (category) {
    case "confirmCancel":
      // 立即反馈，不显示思考
      return { minDelayMs: 0, showTyping: false }

    case "draftRevise":
      // 像在更新当前补货单
      return {
        minDelayMs: pickInclusive(300, 600),
        loadingText: "我记到这张单里。",
        showTyping: true
      }

    case "identityCasual":
      // 不秒回，但也不明显卡顿；不显示思考文案，只显示轻微 typing
      return {
        minDelayMs: pickInclusive(300, 500),
        showTyping: true
      }

    case "stockQuery":
      // 本地库存查询
      return {
        minDelayMs: pickInclusive(600, 900),
        loadingText: pickFrom(STOCK_QUERY_LOADING),
        showTyping: true
      }

    case "priceBudget":
      // 价格/预算/历史分析
      return {
        minDelayMs: pickInclusive(900, 1500),
        loadingText: pickFrom(PRICE_BUDGET_LOADING),
        showTyping: true
      }

    case "orderImport":
      // 真实 loading，不额外假等待
      return {
        minDelayMs: 0,
        loadingText: "我看一下这张订单。",
        showTyping: true
      }

    case "realtimeExternal":
      // 不假装查询，300-500ms 后直接说明边界
      return {
        minDelayMs: pickInclusive(300, 500),
        showTyping: false
      }

    case "default":
    default:
      // 默认轻微节奏
      return {
        minDelayMs: pickInclusive(200, 400),
        showTyping: true
      }
  }
}

// ---------- 文案池 ----------

const STOCK_QUERY_LOADING = [
  "我看一下当前记录。",
  "我看一下这周的提醒。",
  "我先排一下优先级。"
]

const PRICE_BUDGET_LOADING = [
  "我对一下最近几次记录。",
  "我看一下本月支出。"
]

// ---------- 工具 ----------

/** 在 [min, max] 之间取一个伪随机整数（含端点） */
function pickInclusive(min: number, max: number): number {
  if (max <= min) return min
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** 从文案池里随机取一条 */
function pickFrom(pool: string[]): string {
  if (!pool.length) return ""
  return pool[Math.floor(Math.random() * pool.length)]
}

// ---------- 节奏判定辅助：可测试的纯函数 ----------

/**
 * 只暴露 categorizePacing 的纯函数版本，便于单测断言分类正确。
 * 不暴露内部的 timingForCategory（因为含随机数，不易断言具体数值）。
 */
export function categorizePacingForTest(input: ResponseTimingInput): PacingCategory {
  return categorizePacing(input)
}

/**
 * 暴露 timingForCategory 的纯函数版本（不调用随机数），便于单测断言节奏区间。
 * 测试用：固定使用区间下界。
 */
export function timingForCategoryForTest(category: PacingCategory): ResponseTiming {
  switch (category) {
    case "confirmCancel":
      return { minDelayMs: 0, showTyping: false }
    case "draftRevise":
      return { minDelayMs: 300, loadingText: "我记到这张单里。", showTyping: true }
    case "identityCasual":
      return { minDelayMs: 300, showTyping: true }
    case "stockQuery":
      return { minDelayMs: 600, loadingText: STOCK_QUERY_LOADING[0], showTyping: true }
    case "priceBudget":
      return { minDelayMs: 900, loadingText: PRICE_BUDGET_LOADING[0], showTyping: true }
    case "orderImport":
      return { minDelayMs: 0, loadingText: "我看一下这张订单。", showTyping: true }
    case "realtimeExternal":
      return { minDelayMs: 300, showTyping: false }
    case "default":
    default:
      return { minDelayMs: 200, showTyping: true }
  }
}

/**
 * 计算还需要等待的时间。
 * 如果实际耗时已经超过 minDelayMs，返回 0（不再额外等待）。
 */
export function computeRemainingDelay(
  minDelayMs: number,
  elapsedMs: number
): number {
  if (minDelayMs <= 0) return 0
  if (elapsedMs >= minDelayMs) return 0
  return minDelayMs - elapsedMs
}
