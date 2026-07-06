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

/** 统一对话回合输出。UI 只渲染这个类型，不再直接渲染 AgentDraft。 */
export type AgentTurn =
  | AgentTurnAnswer
  | AgentTurnProposal
  | AgentTurnClarification
  | AgentTurnCancelled
  | AgentTurnCommitted
  | AgentTurnProposalBatch

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
 *   1. pending proposal + 用户确认 → committed（由调用方执行 commitAgentDraft 后构造）
 *   2. pending proposal + 用户取消 → cancelled
 *   3. pending proposal + 用户修订 → 新 proposal（supersede 旧的）
 *   4. pending proposal + 用户询问状态 → answer
 *   5. pending batch + 批量意图 → 批量处理（confirm/cancel/revise index/all）
 *   6. writeDraft 意图 + 本地可解析 → proposal 或 clarification
 *   7. 查询意图 + 本地可回答 → answer
 *   8. 其他 → needLlm（交给 LLM fallback）
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
