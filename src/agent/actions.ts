/**
 * AgentAction / AgentPlan：管家对话执行能力的统一类型层。
 *
 * 设计目标：
 *   1. 把产品里的核心写入操作（建分类、加消耗品、记补货、改字段、设预算）抽象成统一 Action。
 *   2. 一个用户请求可以对应多个 Action（AgentPlan），按顺序执行。
 *   3. 用户确认前只生成 plan，不写入 state；确认后由 executor 统一执行。
 *   4. UI 手动操作和对话操作后续可共用同一套 action executor。
 *   5. 与已有 AgentDraft 并存：AgentDraft 用于单条草稿的轻量场景（订单导入、通知补货），
 *      AgentPlan 用于多动作组合的对话场景（建分类+加消耗品+记补货一条龙）。
 *
 * 第一期覆盖：createCategory / createItem / updateItem / addPurchaseOption /
 *            recordRestock / updateRestockRecord / setMonthlyBudget
 * 第二期再覆盖：renameCategory / deleteCategory / moveItem / deleteItem /
 *             updatePurchaseOption / deletePurchaseOption / deleteRestockRecord /
 *             updateReminderSettings
 */

/** Action 风险等级。low：纯新增；medium：可能覆盖已有数据；high：删除/批量迁移。 */
export type AgentActionRisk = "low" | "medium" | "high"

/** AgentPlan 生命周期。pending 等待确认；confirmed 已执行；cancelled 用户取消；superseded 被新 plan 替换。 */
export type AgentPlanStatus = "pending" | "confirmed" | "cancelled" | "superseded"

// ---------- 第一期 Action 类型 ----------

/** 新建分类。state.categories 不存在时才真正写入。 */
export type CreateCategoryAction = {
  type: "createCategory"
  name: string
}

/** 新建消耗品。复用 domain.createItem 的字段集。 */
export type CreateItemAction = {
  type: "createItem"
  name: string
  category: string
  cycleDays: number
  bufferDays: number
  unit: string
  /** 可选：随物品一起建档的常购商品（如「维达超韧」） */
  addPurchaseOption?: {
    productName: string
    unit?: string
  }
}

/**
 * 修改已有消耗品的基础字段。只列可改字段，未列字段保持不变。
 * itemId 与 itemName 二选一：itemId 优先；只有 itemName 时由 executor 做匹配。
 */
export type UpdateItemAction = {
  type: "updateItem"
  itemId?: string
  itemName?: string
  /** 物品名修订（如「不是抽纸是卷纸」） */
  name?: string
  category?: string
  cycleDays?: number
  bufferDays?: number
  unit?: string
}

/**
 * 添加常购商品（PurchaseOption）。
 * 重复添加（同 productName）不会报错，由 executor 跳过。
 */
export type AddPurchaseOptionAction = {
  type: "addPurchaseOption"
  itemId?: string
  itemName: string
  productName: string
  unit?: string
}

/**
 * 记录一笔补货。复用 domain.restockItem。
 * 字段集与 RestockDraftDetails 对齐，方便 planner 复用 drafts.ts 的解析函数。
 */
export type RecordRestockAction = {
  type: "recordRestock"
  itemId?: string
  itemName: string
  qty?: number
  unit?: string
  price?: number
  platform?: string
  purchaseProductName?: string
  /** 顺便修订物品周期（如「周期改成 30 天」） */
  cycleDaysPatch?: number
  restockDate?: number
  review?: string
  purchaseMeasureAmount?: number
  purchaseMeasureUnit?: string
  /** 物品匹配置信度低时的提示，供卡片展示 */
  matchHint?: string
}

/**
 * 修改已有的补货记录（RestockEvent）。
 * 复用 domain.updateRestockRecord 的 patch 结构。
 */
export type UpdateRestockRecordAction = {
  type: "updateRestockRecord"
  itemId: string
  /** 目标补货记录的 eventId；为空时默认改最新一条 */
  eventId?: string
  patch: {
    at?: number
    qty?: number
    price?: number
    platform?: string
    review?: string
    purchaseMeasureAmount?: number
    purchaseMeasureUnit?: string
  }
}

/** 设置月预算。复用 state.settings.monthlyBudget 字段。 */
export type SetMonthlyBudgetAction = {
  type: "setMonthlyBudget"
  amount: number
}

/** 第一期 Action 联合类型。 */
export type AgentAction =
  | CreateCategoryAction
  | CreateItemAction
  | UpdateItemAction
  | AddPurchaseOptionAction
  | RecordRestockAction
  | UpdateRestockRecordAction
  | SetMonthlyBudgetAction

/** 第一期支持的所有 action type 字面量，用于 registry 类型守卫。 */
export type AgentActionType = AgentAction["type"]

/**
 * AgentPlan：一次用户请求生成的可执行计划。
 * - actions 按顺序执行；任一失败不静默吞掉，返回错误摘要
 * - 中高风险 action 必须处于 confirmed 状态才能执行
 * - sourceText 保留原始用户输入，供 UI 展示和调试
 */
export type AgentPlan = {
  id: string
  actions: AgentAction[]
  status: AgentPlanStatus
  createdAt: number
  updatedAt: number
  /** 触发这条 plan 的用户原话 */
  sourceText: string
  /** 整个 plan 的风险等级 = actions 中最高风险 */
  risk: AgentActionRisk
}

/** 构造 AgentPlan 的工厂：自动生成 id、时间戳、风险等级。 */
export function createAgentPlan(
  actions: AgentAction[],
  sourceText: string,
  now: number = Date.now()
): AgentPlan {
  const risk = computePlanRisk(actions)
  return {
    id: `plan_${now}_${Math.random().toString(36).slice(2, 8)}`,
    actions,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    sourceText,
    risk
  }
}

/** 取 actions 中最高风险作为 plan 整体风险。high > medium > low。 */
export function computePlanRisk(actions: AgentAction[]): AgentActionRisk {
  const order: AgentActionRisk[] = ["low", "medium", "high"]
  let max: AgentActionRisk = "low"
  for (const action of actions) {
    const r = actionRisk(action)
    if (order.indexOf(r) > order.indexOf(max)) max = r
  }
  return max
}

/** 单个 action 的风险等级。第一期内嵌在 actions.ts，避免与 registry 循环依赖。 */
export function actionRisk(action: AgentAction): AgentActionRisk {
  switch (action.type) {
    case "createCategory":
    case "createItem":
    case "addPurchaseOption":
    case "recordRestock":
    case "setMonthlyBudget":
      return "low"
    case "updateItem":
    case "updateRestockRecord":
      return "medium"
    default:
      return "medium"
  }
}
