/**
 * Agent 能力清单（Capability Manifest）
 *
 * 这是管家对话 Agent 的能力边界单一事实来源。所有可路由意图和可执行动作
 * 必须先在这里声明，再在 planner / orchestrator / focusResolver 中使用。
 *
 * 能力分三类：
 *   1. EXECUTABLE  —— Agent 可直接执行（写入 state）
 *   2. LOCATE_ONLY —— Agent 只负责定位/导航，不执行（UI 负责操作）
 *   3. OUT_OF_SCOPE —— 产品范围外，不处理
 *
 * 设计原则：
 *   - 录入域是 Agent 的核心能力，保持高带宽
 *   - 删除、通用历史编辑、预算、提醒、周期管理类对话入口已关闭
 *   - 对已关闭的请求，Agent 负责定位对象并导航到对应 UI，不写入数据
 *   - 周期洞察建议只能通过结构化按钮采纳，不接受自然语言修改
 */

import type { AgentActionType } from "./actions"

/** 能力分类。 */
export type CapabilityTier = "executable" | "locate_only" | "out_of_scope"

/** 单条能力声明。 */
export type CapabilitySpec = {
  /** 能力标识，对应 AgentActionType 或自定义能力名 */
  name: string
  /** 能力分类 */
  tier: CapabilityTier
  /** 人类可读说明 */
  description: string
}

/**
 * 1. EXECUTABLE —— Agent 可执行的能力
 *
 * 仅保留录入相关：创建消耗品、常购商品、补货记录、必要分类创建、
 * 当前草稿操作、订单导入、库存校准、最近一次写入的纠错与撤销、
 * 周期洞察的结构化采纳。
 */
export const EXECUTABLE_CAPABILITIES: readonly CapabilitySpec[] = [
  { name: "createItem", tier: "executable", description: "创建消耗品" },
  { name: "addPurchaseOption", tier: "executable", description: "创建常购商品" },
  { name: "recordRestock", tier: "executable", description: "创建补货记录" },
  { name: "createCategory", tier: "executable", description: "创建过程中的必要分类创建" },
  { name: "supplementCurrentDraft", tier: "executable", description: "当前草稿补充字段" },
  { name: "reviseCurrentDraft", tier: "executable", description: "当前草稿修改" },
  { name: "confirmCurrentDraft", tier: "executable", description: "确认当前草稿" },
  { name: "cancelCurrentDraft", tier: "executable", description: "取消当前草稿" },
  { name: "orderImportConfirm", tier: "executable", description: "订单识别结果确认" },
  { name: "orderImportRevise", tier: "executable", description: "订单识别结果修正" },
  { name: "calibrateInventory", tier: "executable", description: "库存状态校准（含状态报告）" },
  { name: "correctLastMutation", tier: "executable", description: "最近一次 Agent 写入的有限纠错" },
  { name: "undoLastMutation", tier: "executable", description: "最近一次 Agent 写入的撤销" },
  // 注意：adoptCycleInsight 仅通过 UI 结构化按钮触发（App.tsx applyCycleSuggestion），
  // 不走 AgentAction / AgentPlan 管道，不接受自然语言触发。
  // 此声明仅用于能力清单的文档完整性，不对应可执行的 AgentActionType。
  { name: "adoptCycleInsight", tier: "executable", description: "周期洞察建议的结构化采纳（仅 UI 按钮，不经对话）" }
] as const

/**
 * 2. LOCATE_ONLY —— Agent 仅定位，不执行
 *
 * 这些请求会被识别，但 Agent 只负责定位对象并导航到对应 UI，
 * 不创建 pendingPlan，不写入 state，不进入二次确认。
 */
export const LOCATE_ONLY_CAPABILITIES: readonly CapabilitySpec[] = [
  { name: "deleteItem", tier: "locate_only", description: "删除消耗品——定位到物品详情" },
  { name: "deleteRestockRecord", tier: "locate_only", description: "删除补货记录——定位到记录列表" },
  { name: "deletePurchaseOption", tier: "locate_only", description: "删除常购商品——定位到物品详情" },
  { name: "deleteCategory", tier: "locate_only", description: "删除分类——定位到分类设置" },
  { name: "updateRestockRecord", tier: "locate_only", description: "修改任意历史补货记录——定位到记录列表" },
  { name: "updateItem", tier: "locate_only", description: "修改历史商品信息——定位到物品详情" },
  { name: "renameCategory", tier: "locate_only", description: "重命名分类——定位到分类设置" },
  { name: "moveItem", tier: "locate_only", description: "移动消耗品——定位到物品详情" },
  { name: "updateItemUnit", tier: "locate_only", description: "修改消耗品单位——定位到物品详情" },
  { name: "updateItemReminder", tier: "locate_only", description: "修改提醒规则——定位到物品详情" },
  { name: "updatePurchaseOption", tier: "locate_only", description: "修改常购商品——定位到物品详情" },
  { name: "setDefaultPurchaseOption", tier: "locate_only", description: "设默认常购商品——定位到物品详情" },
  { name: "setMonthlyBudget", tier: "locate_only", description: "设置预算——导航到设置页" },
  { name: "manageCategory", tier: "locate_only", description: "独立分类管理——导航到分类设置" },
  { name: "manageReminder", tier: "locate_only", description: "提醒规则管理——导航到设置页" },
  { name: "manageCycleManually", tier: "locate_only", description: "手动修改消耗周期——定位到物品详情" }
] as const

/**
 * 3. OUT_OF_SCOPE —— 产品范围外
 */
export const OUT_OF_SCOPE_CAPABILITIES: readonly CapabilitySpec[] = [
  { name: "generalLifeAssistant", tier: "out_of_scope", description: "通用生活助手" },
  { name: "externalTransaction", tier: "out_of_scope", description: "外部交易" },
  { name: "autoPayment", tier: "out_of_scope", description: "自动付款" },
  { name: "nonConsumableOperation", tier: "out_of_scope", description: "与消耗品管理无关的操作" }
] as const

/** 全部能力清单。 */
export const ALL_CAPABILITIES: readonly CapabilitySpec[] = [
  ...EXECUTABLE_CAPABILITIES,
  ...LOCATE_ONLY_CAPABILITIES,
  ...OUT_OF_SCOPE_CAPABILITIES
]

/** 所有可执行的 action type 集合（用于 planner 白名单）。 */
export const EXECUTABLE_ACTION_TYPES: ReadonlySet<AgentActionType> = new Set<AgentActionType>([
  "createCategory",
  "createItem",
  "addPurchaseOption",
  "recordRestock",
  "calibrateInventory"
])

/** 所有仅定位的 action type 集合（用于关闭管理类入口）。 */
export const LOCATE_ONLY_ACTION_TYPES: ReadonlySet<AgentActionType> = new Set<AgentActionType>([
  "updateItem",
  "updateRestockRecord",
  "setMonthlyBudget",
  "renameCategory",
  "moveItem",
  "updateItemUnit",
  "updateItemReminder",
  "updatePurchaseOption",
  "setDefaultPurchaseOption",
  "deletePurchaseOption",
  "deleteRestockRecord",
  "deleteItem",
  "deleteCategory"
])

/**
 * 判断一个 action type 是否属于可执行能力。
 * 录入域 action 返回 true，管理类 action 返回 false。
 */
export function isExecutableAction(type: AgentActionType): boolean {
  return EXECUTABLE_ACTION_TYPES.has(type)
}

/**
 * 判断一个 action type 是否属于仅定位能力。
 * 管理类（删除/编辑/预算/提醒/周期）返回 true。
 */
export function isLocateOnlyAction(type: AgentActionType): boolean {
  return LOCATE_ONLY_ACTION_TYPES.has(type)
}

/**
 * 判断一个 action type 是否已被关闭（不再通过对话执行）。
 * 等价于 isLocateOnlyAction，语义更清晰。
 */
export function isClosedManagementAction(type: AgentActionType): boolean {
  return LOCATE_ONLY_ACTION_TYPES.has(type)
}

/** 判断一个 plan 是否只包含可执行 action（不含管理类）。 */
export function isPlanFullyExecutable(actionTypes: AgentActionType[]): boolean {
  return actionTypes.every((type) => isExecutableAction(type))
}

/** 判断一个 plan 是否包含任何已被关闭的管理类 action。 */
export function planContainsClosedActions(actionTypes: AgentActionType[]): boolean {
  return actionTypes.some((type) => isClosedManagementAction(type))
}
