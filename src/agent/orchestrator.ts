/**
 * AgentOrchestrator：家庭管家对话的统一决策层。
 *
 * 设计目标：
 *   1. 所有用户输入必须先进入 orchestrator，再决定 UI 渲染什么。
 *   2. quick answer / local parser / LLM 都只是 orchestrator 的内部能力，
 *      不允许直接决定最终 UI 文案。最终文案由 responseComposer 生成。
 *   3. AgentDraft 只作为 proposal 内部的 executableDraft，不直接等于用户可见卡片。
 *   4. UI 只渲染 AgentTurn，不再渲染 AgentDraft 字段表。
 *
 * 状态机：
 *   answer        只读查询回答（含身份问题、预算、本周、今天优先等）
 *   proposal      待确认的写入方案（含 executableDraft + 摘要 + 缺失字段提示）
 *   clarification 写入对象不确定时追问（含选项 + provisional draft）
 *   cancelled     用户取消当前 pending proposal
 *   committed     用户确认后已写入 state（含结果摘要 + 跳转入口）
 *
 * 关键原则：
 *   - 价格、平台、评价、商品名等非必要字段不作为「缺失字段」暴露给用户
 *   - 只有写入对象不确定、可能重复创建、会记错物品时才追问
 *   - 所有文案由 responseComposer 统一生成，调用方不能自己拼字符串
 */

import type { AgentClarification, AgentDraft, AgentDraftStatus, OrderRow } from "./drafts"
import type { ChatMessageLink } from "../llm/householdChat"
import type { AppState } from "../types"
import type { AgentPlan } from "./actions"

/** 只读查询的回答。orchestrator 不再让 quick answer 直接吐字符串给 UI。 */
export type AgentTurnAnswer = {
  kind: "answer"
  /** 给用户看的核心一句话结论 */
  message: string
  /** 可选的次要细节（例如分组明细），UI 可折叠或省略 */
  detail?: string
}

/** 待确认的写入方案。AgentDraft 被封装在内部，UI 不直接渲染其字段表。 */
export type AgentTurnProposal = {
  kind: "proposal"
  /** 给用户看的口语化处理方案，由 responseComposer 生成 */
  message: string
  /** 内部可执行草稿；确认时由 executor 消费，UI 不直接读其字段 */
  executableDraft: AgentDraft
  /** 当前 proposal 的状态：pending 等待确认；superseded 被新 proposal 替换 */
  status: AgentDraftStatus
}

/** 写入对象不确定时的追问。用户点选项或自由输入后继续走流程。 */
export type AgentTurnClarification = {
  kind: "clarification"
  /** 口语化追问，由 responseComposer 生成 */
  message: string
  /** 可点击选项 */
  options: AgentClarification["options"]
  /** 暂存草稿；用户选完选项后由 orchestrator 组装成完整 proposal */
  provisional?: AgentDraft
}

/** 用户取消当前 pending proposal。 */
export type AgentTurnCancelled = {
  kind: "cancelled"
  message: string
}

/** 用户确认 proposal 后已写入 state。 */
export type AgentTurnCommitted = {
  kind: "committed"
  message: string
  /** 写入结果摘要，例如「已记下「猫砂」本次补货」 */
  summary: string
  /** 跳转入口：查看物品 / 查看分类 */
  links: ChatMessageLink[]
}

/**
 * 订单截图识别后的批量待确认方案。
 * drafts 是可执行的补货/创建草稿；skippedRows 是被判断为非消耗品的行；
 * uncertainRows 是多个相近匹配、需要用户选择归入哪个物品的行。
 * UI 渲染批量确认卡，不渲染完整订单表格。
 */
export type AgentTurnProposalBatch = {
  kind: "proposalBatch"
  /** 管家口吻的整理说明，由 responseComposer 生成 */
  message: string
  /** 可执行草稿；用户确认后由 commitAgentDraftBatch 消费 */
  drafts: AgentDraft[]
  /** 被跳过的非消耗品行（手机壳、数据线等），不生成草稿 */
  skippedRows?: OrderRow[]
  /** 待确认的歧义行，用户需指定归入哪个物品 */
  uncertainRows?: OrderRow[]
  /** 当前批量方案的状态：pending 等待确认 */
  status: AgentDraftStatus
}

/**
 * AgentPlan 待确认方案。
 * 一次用户请求可以生成多个动作（建分类+加消耗品+记补货），统一封装在 plan 里。
 * UI 渲染 AgentPlanCard，不直接读 actions 字段表。
 * 用户确认前不写入 state；确认后由 commitAgentPlan 执行。
 */
export type AgentTurnPlanProposal = {
  kind: "planProposal"
  /** 管家口吻的处理方案文案，由 planner.composePlanMessage 生成 */
  message: string
  /** 待确认计划；用户确认后由 commitAgentPlan 消费 */
  plan: AgentPlan
}

/** AgentPlan 确认后已写入 state。 */
export type AgentTurnPlanCommitted = {
  kind: "planCommitted"
  /** 写入结果摘要 + 跳转入口提示，由 responseComposer 生成 */
  message: string
  /** 写入结果摘要，例如「已记下「猫砂」本次补货」 */
  summary: string
  /** 跳转入口：查看物品 / 查看分类 */
  links: ChatMessageLink[]
}

/**
 * Typed Command：用于替代旧的 __BATCH_CONFIRM__ 等魔法字符串。
 *
 * 当用户输入是确认/取消/修订意图但执行需要由 App.tsx 完成（因为涉及 state 写入或数组操作）时，
 * orchestrator 返回一个 planCommand turn，由 App.tsx 读取 command 字段分发。
 *
 * - planConfirm：确认 pending plan，调用方应执行 commitAgentPlan
 * - planAwaitingSecondConfirm：高风险 plan 第一次确认，调用方应把 plan 状态推进到 awaitingSecondConfirm（不执行写入）
 * - planSecondConfirm：高风险 plan 二次确认删除，调用方应执行 commitAgentPlan
 * - planCancel：取消 pending plan
 * - batchConfirm / batchCancel / batchCancelIndex / batchReviseIndex / batchReviseAll：
 *   订单截图导入的批量操作，沿用原批量处理逻辑（confirmBatch/cancelBatch 等）
 */
export type AgentPlanCommand =
  | { command: "planConfirm" }
  | { command: "planAwaitingSecondConfirm" }
  | { command: "planSecondConfirm" }
  | { command: "planCancel" }
  | { command: "batchConfirm" }
  | { command: "batchCancel" }
  | { command: "batchCancelIndex"; index: number }
  | { command: "batchReviseIndex"; index: number }
  | { command: "batchReviseAll" }

/** 带 typed command 的 turn：App.tsx 读取 command 后分发到对应的处理函数。 */
export type AgentTurnPlanCommand = {
  kind: "planCommand"
  message: string
  command: AgentPlanCommand
}

/** 统一对话回合输出。UI 只渲染这个类型，不再直接渲染 AgentDraft。 */
export type AgentTurn =
  | AgentTurnAnswer
  | AgentTurnProposal
  | AgentTurnClarification
  | AgentTurnCancelled
  | AgentTurnCommitted
  | AgentTurnProposalBatch
  | AgentTurnPlanProposal
  | AgentTurnPlanCommitted
  | AgentTurnPlanCommand

/** orchestrator 处理用户输入时需要的上下文。 */
export type OrchestrateInput = {
  /** 用户这一轮说的话 */
  text: string
  /** 当前应用状态 */
  state: AppState
  /** 物品视图（含 computed 状态），用于查询类回答 */
  itemViews: import("../llm/householdChat").HouseholdChatItemView[]
  /** 当前是否有 pending proposal（上一轮生成的待确认草稿） */
  pendingDraft?: AgentDraft
  /** 当前是否有 pending 批量草稿（订单导入） */
  pendingBatch?: AgentDraft[]
  /** 当前是否有 pending AgentPlan（多动作计划）；存在时优先按修订/确认/取消处理 */
  pendingPlan?: AgentPlan
  /** 对话日期上下文 */
  dateContext: import("../llm/householdChat").ChatDateContext
}

/** orchestrator 同步决策结果。LLM 调用是异步的，由调用方在外层处理。 */
export type OrchestrateDecision =
  | { kind: "sync"; turn: AgentTurn }
  | { kind: "needLlm"; reason: string }

/**
 * AgentOrchestrator 同步入口：根据用户输入和当前上下文，决定这一轮输出什么 AgentTurn。
 *
 * 决策优先级（高 → 低）：
 *   1. pending plan + 用户确认 → 返回 typed command 让调用方执行 commitAgentPlan
 *   2. pending plan + 用户取消 → 返回 cancelled turn
 *   3. pending plan + 用户修订 → 生成新 planProposal，旧 plan 标记 superseded
 *   4. pending plan + 用户询问状态 → answer
 *   5. pending proposal（旧 AgentDraft）+ 用户确认/取消/修订 → 沿用旧 proposal 流程
 *   6. pending batch + 批量意图 → 批量处理（typed command）
 *   7. 新写入意图 + 本地 planner 可解析 → planProposal
 *   8. 新写入意图 + 本地 drafts 可解析 → proposal 或 clarification
 *   9. 查询意图 + 本地可回答 → answer
 *   10. 对话边界（identity/realtime/casual）→ 本地自然回应
 *   11. 其他 → needLlm（交给 LLM fallback）
 *
 * 注意：本函数是纯函数，不调用 LLM，不修改 state。
 * 调用方拿到 needLlm 时自行调用 askHouseholdAssistant，再把结果传给 normalizeLlmResponse。
 */
export type AgentOrchestrator = {
  /** 同步决策：本地能处理就返回 sync turn，否则返回 needLlm */
  decide(input: OrchestrateInput): OrchestrateDecision
  /** 把 LLM 返回的原始内容规范化为 AgentTurn（经过本地 normalize + responseComposer） */
  normalizeLlmResponse(content: string, input: OrchestrateInput): AgentTurn | null
}
