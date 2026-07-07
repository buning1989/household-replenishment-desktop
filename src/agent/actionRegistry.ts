/**
 * ActionRegistry：每个 AgentAction 的元信息、校验、摘要集中表。
 *
 * 设计目标：
 *   1. 集中定义每个 action 的风险等级、必填字段、校验规则、给确认卡展示的摘要文案。
 *   2. validate 返回 errors（阻断执行）和 warnings（提示但不阻断）。
 *   3. summarize 输出管家口吻的单行摘要，供 AgentPlanCard 展示。
 *   4. 不修改 state，不调用 domain 写入函数；纯函数。
 *
 * 与 executor 的关系：
 *   - registry.validate 在 plan 生成时调用，提前拦截畸形 action
 *   - executor.applyAgentAction 在执行时仍会做运行时检查（target 是否存在、是否重复）
 *   - 两者职责分离：registry 管「能不能生成 plan」，executor 管「能不能写入 state」
 */

import type { AppState, ReplenishmentItem } from "../types"
import type { AgentAction, AgentActionRisk, AgentActionType } from "./actions"

export type ActionValidationResult = {
  /** true 表示可执行；false 表示存在 errors，不应进入 plan */
  ok: boolean
  /** 阻断性错误：action 畸形，不应展示给用户确认 */
  errors: string[]
  /** 提示性警告：可执行但需用户留意（如目标物品不存在、可能重复） */
  warnings: string[]
}

export type ActionDefinition<T extends AgentAction = AgentAction> = {
  type: T["type"]
  risk: AgentActionRisk
  /** 必填字段名（顶层字段）。用于 plan 生成时快速校验。 */
  requiredFields: string[]
  /** 校验：返回 errors + warnings。errors 阻断，warnings 仅提示。 */
  validate: (action: T, state: AppState) => ActionValidationResult
  /** 摘要：给 AgentPlanCard 展示的单行文案，管家口吻。 */
  summarize: (action: T, state: AppState) => string
}

// ---------- 工具函数 ----------

function norm(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN")
}

function findItemByName(items: ReplenishmentItem[], name: string): ReplenishmentItem | undefined {
  const lowered = norm(name)
  if (!lowered) return undefined
  return items.find((item) => norm(item.name) === lowered)
}

function findItemById(items: ReplenishmentItem[], id: string): ReplenishmentItem | undefined {
  return items.find((item) => item.id === id)
}

/** 按 itemId 优先、itemName 兜底查找目标物品。 */
function resolveTargetItem(
  action: { itemId?: string; itemName?: string },
  state: AppState
): ReplenishmentItem | undefined {
  if (action.itemId) {
    const byId = findItemById(state.items, action.itemId)
    if (byId) return byId
  }
  if (action.itemName) {
    return findItemByName(state.items, action.itemName)
  }
  return undefined
}

// ---------- 单个 action 的 definition ----------

const createCategoryDef: ActionDefinition<Extract<AgentAction, { type: "createCategory" }>> = {
  type: "createCategory",
  risk: "low",
  requiredFields: ["name"],
  validate(action, state) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!action.name.trim()) {
      errors.push("分类名不能为空")
    } else if (state.categories.some((c) => norm(c) === norm(action.name))) {
      warnings.push(`分类「${action.name}」已存在`)
    }
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    return `新建分类：${action.name}`
  }
}

const createItemDef: ActionDefinition<Extract<AgentAction, { type: "createItem" }>> = {
  type: "createItem",
  risk: "low",
  requiredFields: ["name", "category", "cycleDays", "bufferDays", "unit"],
  validate(action, state) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!action.name.trim()) errors.push("消耗品名不能为空")
    if (!action.category.trim()) errors.push("分类不能为空")
    if (!Number.isFinite(action.cycleDays) || action.cycleDays <= 0) errors.push("周期必须为正数")
    if (!Number.isFinite(action.bufferDays) || action.bufferDays < 0) errors.push("缓冲天数不能为负")
    if (action.cycleDays > 0 && action.bufferDays >= action.cycleDays) {
      warnings.push("缓冲天数应小于周期，已自动收紧")
    }
    // 同名物品已存在
    if (action.name.trim() && findItemByName(state.items, action.name)) {
      warnings.push(`消耗品「${action.name}」已存在，将跳过创建`)
    }
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    const parts = [`添加消耗品：${action.name}`]
    parts.push(`分类 ${action.category}`)
    parts.push(`周期 ${action.cycleDays} 天`)
    if (action.addPurchaseOption?.productName) {
      parts.push(`常购商品 ${action.addPurchaseOption.productName}`)
    }
    return parts.join(" · ")
  }
}

const updateItemDef: ActionDefinition<Extract<AgentAction, { type: "updateItem" }>> = {
  type: "updateItem",
  risk: "medium",
  requiredFields: [],
  validate(action, state) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!action.itemId && !action.itemName) {
      errors.push("必须指定 itemId 或 itemName")
    }
    if (action.cycleDays !== undefined && (!Number.isFinite(action.cycleDays) || action.cycleDays <= 0)) {
      errors.push("周期必须为正数")
    }
    if (action.bufferDays !== undefined && action.bufferDays < 0) {
      errors.push("缓冲天数不能为负")
    }
    // 目标物品不存在（仅当能解析到 itemName 时给 warning）
    if (!action.itemId && action.itemName) {
      const target = resolveTargetItem(action, state)
      if (!target) warnings.push(`找不到消耗品「${action.itemName}」，将跳过这条`)
    }
    // 至少要有一个可改字段
    const hasPatch = [action.name, action.category, action.cycleDays, action.bufferDays, action.unit].some((v) => v !== undefined)
    if (!hasPatch) warnings.push("没有指定要修改的字段")
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    const target = action.itemName || action.itemId || "目标物品"
    const changes: string[] = []
    if (action.name) changes.push(`名称改为 ${action.name}`)
    if (action.category) changes.push(`分类改为 ${action.category}`)
    if (action.cycleDays !== undefined) changes.push(`周期改为 ${action.cycleDays} 天`)
    if (action.bufferDays !== undefined) changes.push(`提前 ${action.bufferDays} 天`)
    if (action.unit) changes.push(`单位改为 ${action.unit}`)
    return `修改${target}：${changes.join("，") || "无字段变更"}`
  }
}

const addPurchaseOptionDef: ActionDefinition<Extract<AgentAction, { type: "addPurchaseOption" }>> = {
  type: "addPurchaseOption",
  risk: "low",
  requiredFields: ["itemName", "productName"],
  validate(action, state) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!action.itemName?.trim()) errors.push("物品名不能为空")
    if (!action.productName?.trim()) errors.push("常购商品名不能为空")
    if (action.itemName?.trim()) {
      const target = resolveTargetItem(action, state)
      if (!target) {
        warnings.push(`找不到消耗品「${action.itemName}」，将跳过这条`)
      } else if (target.purchaseOptions.some((opt) => norm(opt.productName) === norm(action.productName))) {
        warnings.push(`「${target.name}」下已有常购商品「${action.productName}」`)
      }
    }
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    return `添加常购商品：${action.productName}（归属 ${action.itemName}）`
  }
}

const recordRestockDef: ActionDefinition<Extract<AgentAction, { type: "recordRestock" }>> = {
  type: "recordRestock",
  risk: "low",
  requiredFields: ["itemName"],
  validate(action, state) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!action.itemName?.trim()) errors.push("物品名不能为空")
    if (action.qty !== undefined && (!Number.isFinite(action.qty) || action.qty <= 0)) {
      errors.push("数量必须为正数")
    }
    if (action.price !== undefined && (!Number.isFinite(action.price) || action.price < 0)) {
      errors.push("价格不能为负")
    }
    if (action.cycleDaysPatch !== undefined && (!Number.isFinite(action.cycleDaysPatch) || action.cycleDaysPatch <= 0)) {
      errors.push("周期必须为正数")
    }
    // 目标物品不存在：可能是 createItem + recordRestock 的组合，这里只给 warning
    if (action.itemName?.trim()) {
      const target = resolveTargetItem(action, state)
      if (!target) warnings.push(`消耗品「${action.itemName}」不存在，需先创建或合并到 createItem`)
    }
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    const parts = [`记录补货：${action.itemName}`]
    if (action.qty) parts.push(`${action.qty}${action.unit || "件"}`)
    if (action.platform) parts.push(action.platform)
    if (action.price !== undefined) parts.push(`¥${action.price}`)
    if (action.restockDate) {
      const date = new Date(action.restockDate)
      if (Number.isFinite(date.getTime())) {
        parts.push(`${date.getMonth() + 1}月${date.getDate()}日`)
      }
    }
    if (action.cycleDaysPatch) parts.push(`周期改为 ${action.cycleDaysPatch} 天`)
    return parts.join(" · ")
  }
}

const updateRestockRecordDef: ActionDefinition<Extract<AgentAction, { type: "updateRestockRecord" }>> = {
  type: "updateRestockRecord",
  risk: "medium",
  requiredFields: ["itemId"],
  validate(action, state) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!action.itemId?.trim()) errors.push("必须指定 itemId")
    if (action.patch.qty !== undefined && (!Number.isFinite(action.patch.qty) || action.patch.qty <= 0)) {
      errors.push("数量必须为正数")
    }
    if (action.patch.price !== undefined && (!Number.isFinite(action.patch.price) || action.patch.price < 0)) {
      errors.push("价格不能为负")
    }
    const target = action.itemId ? findItemById(state.items, action.itemId) : undefined
    if (!target) {
      warnings.push(`找不到物品 ${action.itemId}，将跳过这条`)
    } else if (action.eventId) {
      const event = target.history.find((e) => e.id === action.eventId)
      if (!event) warnings.push(`找不到补货记录 ${action.eventId}，将跳过这条`)
    }
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    const changes: string[] = []
    if (action.patch.qty !== undefined) changes.push(`数量改为 ${action.patch.qty}`)
    if (action.patch.price !== undefined) changes.push(`价格改为 ¥${action.patch.price}`)
    if (action.patch.platform) changes.push(`平台改为 ${action.patch.platform}`)
    if (action.patch.review) changes.push(`评价改为 ${action.patch.review}`)
    return `修改补货记录：${changes.join("，") || "无字段变更"}`
  }
}

const setMonthlyBudgetDef: ActionDefinition<Extract<AgentAction, { type: "setMonthlyBudget" }>> = {
  type: "setMonthlyBudget",
  risk: "low",
  requiredFields: ["amount"],
  validate(action) {
    const errors: string[] = []
    const warnings: string[] = []
    if (!Number.isFinite(action.amount) || action.amount < 0) {
      errors.push("预算必须为非负数")
    }
    if (action.amount > 100000) {
      warnings.push("预算金额偏大，请确认单位是元")
    }
    return { ok: errors.length === 0, errors, warnings }
  },
  summarize(action) {
    return `设置本月预算：¥${action.amount}`
  }
}

// ---------- Registry 表 ----------

const REGISTRY: Record<AgentActionType, ActionDefinition> = {
  createCategory: createCategoryDef as ActionDefinition,
  createItem: createItemDef as ActionDefinition,
  updateItem: updateItemDef as ActionDefinition,
  addPurchaseOption: addPurchaseOptionDef as ActionDefinition,
  recordRestock: recordRestockDef as ActionDefinition,
  updateRestockRecord: updateRestockRecordDef as ActionDefinition,
  setMonthlyBudget: setMonthlyBudgetDef as ActionDefinition
}

/** 取某个 action type 的 definition。未知 type 抛错（不应发生，类型已约束）。 */
export function getActionDefinition(type: AgentActionType): ActionDefinition {
  const def = REGISTRY[type]
  if (!def) throw new Error(`Unknown action type: ${type}`)
  return def
}

/** 校验单个 action。 */
export function validateAction(action: AgentAction, state: AppState): ActionValidationResult {
  return getActionDefinition(action.type).validate(action, state)
}

/** 校验整个 plan：聚合所有 action 的 errors/warnings。 */
export function validatePlan(actions: AgentAction[], state: AppState): {
  ok: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  actions.forEach((action, index) => {
    const result = validateAction(action, state)
    result.errors.forEach((err) => errors.push(`第 ${index + 1} 条：${err}`))
    result.warnings.forEach((warn) => warnings.push(`第 ${index + 1} 条：${warn}`))
  })
  return { ok: errors.length === 0, errors, warnings }
}

/** 生成单个 action 的摘要文案。 */
export function summarizeAction(action: AgentAction, state: AppState): string {
  return getActionDefinition(action.type).summarize(action, state)
}

/** 生成整个 plan 的多行摘要。每行一条 action。 */
export function summarizePlan(actions: AgentAction[], state: AppState): string[] {
  return actions.map((action, index) => `${index + 1}. ${summarizeAction(action, state)}`)
}
