/**
 * AgentOrchestrator 实现：把 quick answer / local parser / clarification / batch
 * 全部收敛为内部能力，对外只输出 AgentTurn。
 *
 * 本文件是纯逻辑（除 LLM 调用由调用方在外层处理），可被测试直接覆盖。
 */

import { buildLocalClarification, buildLocalDraftFromText, parseAgentResponse, reviseAgentDraft, type AgentClarification, type AgentDraft } from "./drafts"
import { classifyAgentIntent, classifyBatchIntent, type BatchLocalIntent } from "./intent"
import {
  composeClarificationMessage,
  composeFallbackMessage,
  composePendingReminder,
  composeProposalMessage,
  composeRevisedMessage,
  composeBatchIntro,
  composeBatchRevisedMessage,
  composeCancelledMessage
} from "./responseComposer"
import type {
  AgentOrchestrator,
  AgentTurn,
  OrchestrateDecision,
  OrchestrateInput
} from "./orchestrator"

/**
 * 构造一个 AgentOrchestrator 实例。无状态，可单例使用。
 */
export function createHouseholdOrchestrator(): AgentOrchestrator {
  return {
    decide(input) {
      return decideSync(input)
    },
    normalizeLlmResponse(content, input) {
      return normalizeLlm(content, input)
    }
  }
}

/** 同步决策：本地能处理就返回 sync turn，否则返回 needLlm。 */
function decideSync(input: OrchestrateInput): OrchestrateDecision {
  const { text, state, itemViews, pendingDraft, pendingBatch, dateContext } = input

  // 1. pending batch 优先（订单导入后的批量修正）
  if (pendingBatch && pendingBatch.length > 0) {
    const batchTurn = handleBatchIntent(text, pendingBatch, state)
    if (batchTurn) return { kind: "sync", turn: batchTurn }
    // 批量意图没命中，落到下面单草稿/查询/LLM 流程
  }

  // 2. pending proposal 状态机：confirm / cancel / revise / pendingStatus
  if (pendingDraft) {
    const intent = classifyAgentIntent(text, true)
    if (intent === "confirmDraft") {
      // 调用方需要执行 commitAgentDraft 后构造 committed turn
      // orchestrator 不直接写 state，只标记需要 commit
      return { kind: "sync", turn: { kind: "proposal", message: composeProposalMessage(pendingDraft), executableDraft: pendingDraft, status: "pending" } }
    }
    if (intent === "cancelDraft") {
      return { kind: "sync", turn: { kind: "cancelled", message: composeCancelledMessage() } }
    }
    if (intent === "pendingStatus") {
      return { kind: "sync", turn: { kind: "answer", message: composePendingReminder(pendingDraft) } }
    }
    if (intent === "reviseDraft") {
      const revised = reviseAgentDraft(pendingDraft, text, state)
      if (revised) {
        return {
          kind: "sync",
          turn: { kind: "proposal", message: composeRevisedMessage(), executableDraft: revised, status: "pending" }
        }
      }
      // 修订失败：回退到 pending reminder
      return { kind: "sync", turn: { kind: "answer", message: composePendingReminder(pendingDraft) } }
    }
  }

  // 3. writeDraft 意图：先尝试本地 clarification（重复创建/歧义）
  const intent = classifyAgentIntent(text, Boolean(pendingDraft))
  if (intent === "writeDraft") {
    const clarification = buildLocalClarification(text, state)
    if (clarification) {
      return { kind: "sync", turn: clarifyToTurn(clarification) }
    }
    const localDraft = buildLocalDraftFromText(text, state)
    if (localDraft) {
      return { kind: "sync", turn: draftToProposal(localDraft) }
    }
    // 本地解析失败 → 交给 LLM
    return { kind: "needLlm", reason: "writeDraft but local parser failed" }
  }

  // 4. 查询意图与其他无法本地处理的输入：交给 LLM（任务四 A）
  //    answerHouseholdQuickly 降级为 LLM 失败兜底，由外层 App.tsx 在 LLM 调用失败时调用。
  //    buildQueryFacts 作为事实供料，由外层 askHouseholdAssistant 注入系统提示。
  return { kind: "needLlm", reason: "query intent or unmatched input" }
}

/** 把 AgentClarification 转成 AgentTurnClarification。 */
function clarifyToTurn(clarification: AgentClarification): AgentTurn {
  // 复用 composer 生成 message，但如果 clarification 自带 question（来自 LLM）也接受
  const message = clarification.question
  return {
    kind: "clarification",
    message,
    options: clarification.options,
    provisional: clarification.provisional
  }
}

/** 把 AgentDraft 转成 AgentTurnProposal。 */
function draftToProposal(draft: AgentDraft): AgentTurn {
  return {
    kind: "proposal",
    message: composeProposalMessage(draft),
    executableDraft: draft,
    status: "pending"
  }
}

/** 处理批量意图（订单导入）。返回 null 表示不是批量意图。 */
function handleBatchIntent(text: string, pendingBatch: AgentDraft[], _state: import("../types").AppState): AgentTurn | null {
  const batchIntent = classifyBatchIntent(text)
  if (!batchIntent) return null

  // 批量意图由调用方在 App.tsx 处理（因为涉及 batchDraftStatuses 数组操作）
  // 这里只返回一个标记性 answer，告诉调用方「这是批量意图，请外层处理」
  // 真正的批量处理逻辑仍在 App.tsx 的 patchBatch/confirmBatch 等函数里
  // 但文案统一从 composer 取
  if (batchIntent.intent === "batchConfirm") {
    // 标记：调用方应执行 confirmBatch
    return { kind: "answer", message: "__BATCH_CONFIRM__" }
  }
  if (batchIntent.intent === "batchCancel") {
    return { kind: "answer", message: "__BATCH_CANCEL__" }
  }
  if (batchIntent.intent === "batchCancelIndex") {
    return { kind: "answer", message: `__BATCH_CANCEL_INDEX__:${batchIntent.index}` }
  }
  if (batchIntent.intent === "batchReviseIndex") {
    return { kind: "answer", message: `__BATCH_REVISE_INDEX__:${batchIntent.index}` }
  }
  if (batchIntent.intent === "batchReviseAll") {
    return { kind: "answer", message: "__BATCH_REVISE_ALL__" }
  }
  return null
}

/**
 * 把 LLM 返回的原始内容规范化为 AgentTurn。
 * LLM 输出经过 parseAgentResponse 后，再由 composer 重新生成文案，
 * 不直接采用 LLM 的 message 字段。
 */
function normalizeLlm(content: string, input: OrchestrateInput): AgentTurn | null {
  const parsed = parseAgentResponse(content, input.state)
  if (!parsed) return null

  if (parsed.kind === "queryAnswer") {
    return { kind: "answer", message: parsed.answer }
  }
  if (parsed.kind === "clarification") {
    return {
      kind: "clarification",
      // LLM 的 question 可以采用，但走 composer 校验是否包含禁用词
      message: parsed.clarification.question,
      options: parsed.clarification.options,
      provisional: parsed.clarification.provisional
    }
  }
  if (parsed.kind === "draft") {
    // 关键：不直接采用 LLM 的 message，由 composer 重新生成
    // 这样保证 LLM 即使文案漂移，最终用户看到的仍是统一管家口吻
    return draftToProposal(parsed.draft)
  }
  return null
}

/** 工具：判断 turn 是否是批量意图标记（供 App.tsx 处理） */
export function isBatchIntentMarker(turn: AgentTurn): BatchLocalIntent | null {
  if (turn.kind !== "answer") return null
  if (turn.message === "__BATCH_CONFIRM__") return { intent: "batchConfirm" }
  if (turn.message === "__BATCH_CANCEL__") return { intent: "batchCancel" }
  if (turn.message.startsWith("__BATCH_CANCEL_INDEX__:")) {
    const index = Number(turn.message.split(":")[1])
    return Number.isFinite(index) ? { intent: "batchCancelIndex", index } : null
  }
  if (turn.message.startsWith("__BATCH_REVISE_INDEX__:")) {
    const index = Number(turn.message.split(":")[1])
    return Number.isFinite(index) ? { intent: "batchReviseIndex", index } : null
  }
  if (turn.message === "__BATCH_REVISE_ALL__") return { intent: "batchReviseAll" }
  return null
}

/** 工具：构造 batch intro turn（订单导入确认后调用） */
export function buildBatchIntroTurn(drafts: AgentDraft[]): AgentTurn {
  return { kind: "answer", message: composeBatchIntro(drafts.length) }
}

/** 工具：构造 batch revised turn */
export function buildBatchRevisedTurn(scope: "single" | "all"): AgentTurn {
  return { kind: "answer", message: composeBatchRevisedMessage(scope) }
}

/** 工具：构造 fallback turn（LLM 失败或解析失败时） */
export function buildFallbackTurn(scenario: "no-draft" | "no-answer"): AgentTurn {
  return { kind: "answer", message: composeFallbackMessage(scenario) }
}
