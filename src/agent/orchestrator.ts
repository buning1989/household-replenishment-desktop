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
import type { DraftCollection } from "./draftCollection"
import type { ChatMessageLink } from "../llm/householdChat"
import type { AppState } from "../types"
import type { AgentPlan } from "./actions"
import type { AllowedAction } from "./conversationContext"

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

/**
 * 补货记录采集态。
 *
 * 用户说「今天买了 5 袋猫砂」但 price/platform 等字段还没补齐时，先进入采集态：
 * 管家用自然语言基于历史/常识给参考，继续整理这条临时记录，不展示确认卡。
 *
 * - UI 只渲染普通 assistant 气泡（用 message），不渲染 AgentDraftCard / AgentPlanCard
 * - collection 内部的 draft 不直接写入 state
 * - 当 completeness = readyToConfirm 或用户明确要求保存时，转为 proposal turn
 *
 * 旧 collection 消息不需要变成卡片；转 proposal 时新增一条 proposal 消息即可。
 */
export type AgentTurnCollection = {
  kind: "collection"
  /** 给用户看的采集态文案，由 responseComposer.composeCollectionMessage 生成 */
  message: string
  /** 内部整理态草稿；UI 不直接渲染其字段，也不允许确认写入 */
  collection: DraftCollection
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
  /**
   * 403：撤销最近一次 Agent 写入（直接执行，不需二次确认）。
   * App.tsx 读取后调用 undoLastAgentMutation(state)，用返回的 message 作为回复。
   */
  | { command: "undoLastMutation" }
  /**
   * 403：修正最近一次 Agent 写入的字段（直接执行，不需二次确认）。
   * App.tsx 读取后调用 correctLastAgentMutation(state, field, value)。
   */
  | { command: "correctLastMutation"; field: "price" | "qty" | "platform" | "date"; value: number | string }
  /**
   * 403：确认当前 pendingDraft / pendingCollection 并正式写入。
   * App.tsx 读取后：
   *   - 若有 pendingDraft → 调用 confirmAgentDraft(pendingMessageIndex, nextMessages)
   *   - 否则若有 pendingCollection → 提取 collection.draft 后调用 onConfirmDraft 并标记 collection 为 superseded
   *   - 都没有时 → 返回「当前没有待确认的记录」（幂等保护）
   *
   * 设计目的：替代旧路径中 handlePendingDraftIntent 返回 { kind: "proposal", executableDraft: pendingDraft }
   * 并依赖 App.tsx 引用相等判断（turn.executableDraft === pendingDraft）的脆弱写法。
   * 该写法在 draft 经过 revise 后引用变化时会落入"修订"分支，形成确认死循环。
   */
  | { command: "draftCommit" }

/** 带 typed command 的 turn：App.tsx 读取 command 后分发到对应的处理函数。 */
export type AgentTurnPlanCommand = {
  kind: "planCommand"
  message: string
  command: AgentPlanCommand
}

/**
 * 403：管理类请求的导航 turn。
 *
 * 管理类请求（删除常购商品 / 改周期 / 改提醒 / 设预算 / 编辑历史记录等）已关闭对话执行，
 * 但不能只回复文字而不做任何页面变化。该 turn 携带 target，由 App.tsx 读取后调用
 * onOpenItem / onOpenCategory / onOpenSettings 完成真实导航。
 *
 * target.section 是可选的 section 锚点（如常购商品区域 / 补货记录区域 / 周期提醒区域 / 预算区域）。
 * 当前 UI 不强制支持精确 scroll anchor，但 App.tsx 可用于未来扩展或最低要求的"展开最相关区域"。
 *
 * 零写入约束：navigate turn 不产生 plan / executableDraft / collection / pendingDraft 变化，
 * state 数据不变。导航产生的 UI 状态变化不算业务数据写入。
 */
export type AgentTurnNavigate = {
  kind: "navigate"
  /** 给用户看的口语化导航说明，由 responseComposer 生成 */
  message: string
  /** 导航目标。未匹配到具体物品时为 undefined，App.tsx 仅展示文案不触发导航。 */
  target: NavigateTarget | undefined
}

/** 导航目标类型。 */
export type NavigateTarget =
  | { kind: "item"; itemId: string; section?: "purchaseOptions" | "history" | "cycle" }
  | { kind: "category"; category: string }
  | { kind: "settings"; section?: "budget" }

/** 统一对话回合输出。UI 只渲染这个类型，不再直接渲染 AgentDraft。 */
export type AgentTurn =
  | AgentTurnAnswer
  | AgentTurnProposal
  | AgentTurnCollection
  | AgentTurnClarification
  | AgentTurnCancelled
  | AgentTurnCommitted
  | AgentTurnProposalBatch
  | AgentTurnPlanProposal
  | AgentTurnPlanCommitted
  | AgentTurnPlanCommand
  | AgentTurnNavigate

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
  /** 当前是否有 pending 采集态（补货记录整理中，字段未补齐）；存在时优先按补充/取消/保存处理 */
  pendingCollection?: DraftCollection
  /** 当前是否有 pending 批量草稿（订单导入） */
  pendingBatch?: AgentDraft[]
  /** 当前是否有 pending AgentPlan（多动作计划）；存在时优先按修订/确认/取消处理 */
  pendingPlan?: AgentPlan
  /** 对话日期上下文 */
  dateContext: import("../llm/householdChat").ChatDateContext
  /**
   * 阶段 4B.4：当前对话焦点允许 LLM 输出的动作类型（代码级硬约束）。
   * 由 buildAgentContextPack.computeAllowedActions 计算，App.tsx 从 contextPack 传入。
   * normalizeLlm 对 draft / clarification 做代码级校验：不在 allowedActions 内的写入动作被拒绝。
   * 未提供时（旧测试兼容）不强制校验；App.tsx 真实路径始终提供。
   */
  allowedActions?: AllowedAction[]
  /**
   * 阶段 2C 复盘：dev-only 决策 trace。
   * orchestrator 在 decideSync / interpretAndRouteSync 执行过程中填充字段，
   * 调用方读取后暴露到 window.__agentLastTrace 并 console.info。
   * 不影响决策逻辑，不写入 state，纯调试用途。
   */
  trace?: import("./agentDecisionTrace").AgentDecisionTrace
}

/** orchestrator 同步决策结果。LLM 调用是异步的，由调用方在外层处理。 */
export type OrchestrateDecision =
  | { kind: "sync"; turn: AgentTurn }
  | { kind: "needLlm"; reason: string }
  /**
   * 阶段 2C：pendingCollection 下本地低置信解释，需要调用 LLM Turn Interpreter
   * 重新做结构化理解。调用方应调用 orchestrator.interpretAndRoute(input) 走异步路径。
   * reason 说明为什么需要 LLM 兜底。
   */
  | { kind: "needTurnInterpreterLlm"; reason: string }

/**
 * AgentOrchestrator 同步入口：根据用户输入和当前上下文，决定这一轮输出什么 AgentTurn。
 *
 * 决策优先级（高 → 低）：
 *   1. pending plan + 用户确认 → 返回 typed command 让调用方执行 commitAgentPlan
 *   2. pending plan + 用户取消 → 返回 cancelled turn
 *   3. pending plan + 用户修订 → 生成新 planProposal，旧 plan 标记 superseded
 *   4. pending plan + 用户询问状态 → answer
 *   5. pending collection + 用户补充/取消/保存 → 更新 collection / cancelled / 转 proposal
 *   6. pending proposal（旧 AgentDraft）+ 用户确认/取消/修订 → 沿用旧 proposal 流程
 *   7. pending batch + 批量意图 → 批量处理（typed command）
 *   8. 新写入意图 + 本地 planner 可解析 → planProposal
 *   9. 新写入意图 + 补货类草稿字段未齐 → collection（采集态）
 *   10. 新写入意图 + 本地 drafts 可解析 → proposal 或 clarification
 *   11. 查询意图 + 本地可回答 → answer
 *   12. 对话边界（identity/realtime/casual）→ 本地自然回应
 *   13. 其他 → needLlm（交给 LLM fallback）
 *
 * 注意：本函数是纯函数，不调用 LLM，不修改 state。
 * 调用方拿到 needLlm 时自行调用 askHouseholdAssistant，再把结果传给 normalizeLlmResponse。
 */
export type AgentOrchestrator = {
  /** 同步决策：本地能处理就返回 sync turn，否则返回 needLlm / needTurnInterpreterLlm */
  decide(input: OrchestrateInput): OrchestrateDecision
  /** 把 LLM 返回的原始内容规范化为 AgentTurn（经过本地 normalize + responseComposer） */
  normalizeLlmResponse(content: string, input: OrchestrateInput): AgentTurn | null
  /**
   * 阶段 2C：pendingCollection 下本地低置信时，调用 LLM Turn Interpreter 重新做结构化理解，
   * 再用 resolveConversationFocus 二次路由，返回最终 OrchestrateDecision。
   *
   * - LLM 解释成功且置信 → 重新走 collection 处理或 start_new_collection，返回 { kind: "sync" }
   * - LLM 解释失败 / 低置信 / unknown → 返回 { kind: "sync", turn: clarification }，
   *   询问用户是否补当前记录，禁止回复「超出家务范围」
   * - 调用方也可以直接拿 needLlm 落到常规 LLM answer 兜底
   *
   * clientOverride 供单测注入 mock client；真实运行时内部构造 desktop bridge client。
   */
  interpretAndRoute(
    input: OrchestrateInput,
    clientOverride?: import("./turnInterpreterLlm").TurnInterpreterLlmClient
  ): Promise<OrchestrateDecision>
}
