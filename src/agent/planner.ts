/**
 * Planner：把用户自然语言转成 AgentPlan。
 *
 * 第一期采用「本地 parser 优先，LLM fallback 后置」策略：
 *   - 本地 parser 覆盖核心句式：建分类、添加消耗品、记录补货、修改价格/平台/周期、设置预算
 *   - 本地解析失败时返回 noPlan，由调用方决定是否交给 LLM
 *   - LLM fallback 只允许输出 AgentPlan JSON，不能直接声称已创建/已记录
 *
 * 与 drafts.ts 的关系：
 *   - 复用 drafts.ts 的解析函数（parseQty/parsePrice/parsePlatform/parseSpec 等）
 *   - 复用 buildLocalDraftFromText 处理「买了/添加」等已有句式，再把 AgentDraft 转成 AgentAction
 *   - 新增 createCategory / setMonthlyBudget / updateItem 的本地解析
 */

import {
  buildLocalDraftFromText,
  findItemMatch,
  parsePlatform,
  parseQty,
  type AgentDraft
} from "./drafts"
import type { AppState } from "../types"
import type { ChatDateContext } from "../llm/householdChat"
import {
  createAgentPlan,
  type AgentAction,
  type AgentPlan
} from "./actions"

export type BuildAgentPlanInput = {
  text: string
  state: AppState
  dateContext: ChatDateContext
  /** 当前是否有 pending plan；存在时优先按修订处理 */
  pendingPlan?: AgentPlan
}

export type BuildAgentPlanResult =
  | { kind: "plan"; plan: AgentPlan }
  | { kind: "clarification"; message: string; options?: string[] }
  | { kind: "noPlan" }

// ---------- 工具：文本清洗 ----------

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, "")
}

function cleanName(raw: string): string {
  return cleanText(raw)
    .replace(/^帮我|^请帮我|^我想|^给我/, "")
    .replace(/^(添加|新建|创建|录入|登记|加一个|加个|建一个)/, "")
    .replace(/(分类|消耗品|补货单|补货记录|吧|一下)$/g, "")
    .replace(/[，。,.!！?？]/g, "")
    .replace(/的/g, "")
    .trim()
}

// ---------- pendingPlan 修订 ----------

/**
 * 在 pendingPlan 上下文里把用户的话解读为对 plan 的修订。
 * 第一期支持：价格、平台、周期、数量、商品名、日期的修订。
 * 修订会作用到 plan 里所有相关 action（recordRestock / updateRestockRecord / createItem 的 cycleDays）。
 */
function tryRevisePendingPlan(input: BuildAgentPlanInput): AgentPlan | null {
  if (!input.pendingPlan) return null
  const plan = input.pendingPlan
  const text = input.text
  const compact = cleanText(text)

  // 纯数字 → 价格修订
  const pureNumber = compact.match(/^(\d+(?:\.\d+)?)$/)
  if (pureNumber) {
    const price = Number(pureNumber[1])
    return revisePlanActions(plan, (action) => {
      if (action.type === "recordRestock") return { ...action, price }
      if (action.type === "updateRestockRecord") return { ...action, patch: { ...action.patch, price } }
      if (action.type === "updatePurchaseOption") return { ...action, patch: { ...action.patch, price } }
      return action
    })
  }

  // 价格修订（用 compact 避免"价格改成 68"中的空格导致匹配失败）
  const priceMatch = compact.match(/(?:价格|金额).*?改成?(\d+(?:\.\d+)?)/) || compact.match(/(\d+(?:\.\d+)?)\s*[元块]/)
  if (priceMatch) {
    const price = Number(priceMatch[1])
    return revisePlanActions(plan, (action) => {
      if (action.type === "recordRestock") return { ...action, price }
      if (action.type === "updateRestockRecord") return { ...action, patch: { ...action.patch, price } }
      if (action.type === "updatePurchaseOption") return { ...action, patch: { ...action.patch, price } }
      return action
    })
  }

  // 平台修订
  const platform = parsePlatform(text)
  if (platform && /平台|商家|不是.*是/.test(compact)) {
    return revisePlanActions(plan, (action) => {
      if (action.type === "recordRestock") return { ...action, platform }
      if (action.type === "updateRestockRecord") return { ...action, patch: { ...action.patch, platform } }
      if (action.type === "updatePurchaseOption") return { ...action, patch: { ...action.patch, platform } }
      return action
    })
  }

  // 周期修订
  const cycleMatch = compact.match(/(?:周期|补货周期).*?(\d+)\s*天/)
  if (cycleMatch) {
    const cycleDays = Number(cycleMatch[1])
    return revisePlanActions(plan, (action) => {
      if (action.type === "recordRestock") return { ...action, cycleDaysPatch: cycleDays }
      if (action.type === "createItem") return { ...action, cycleDays, bufferDays: Math.min(action.bufferDays, cycleDays - 1) }
      if (action.type === "updateItem") return { ...action, cycleDays }
      return action
    })
  }

  // 数量修订
  const qty = parseQty(compact)
  if (qty.qty !== undefined) {
    return revisePlanActions(plan, (action) => {
      if (action.type === "recordRestock") return { ...action, qty: qty.qty, unit: qty.unit || action.unit }
      if (action.type === "updateRestockRecord") return { ...action, patch: { ...action.patch, qty: qty.qty } }
      return action
    })
  }

  return null
}

/** 对 plan 里每个 action 应用修订函数，返回新 plan（不修改原 plan）。 */
function revisePlanActions(
  plan: AgentPlan,
  revise: (action: AgentAction) => AgentAction
): AgentPlan {
  return {
    ...plan,
    actions: plan.actions.map(revise),
    updatedAt: Date.now()
  }
}

// ---------- 本地 parser：建分类 ----------

function tryParseCreateCategory(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「建一个宠物用品分类」「新建分类叫宠物」「加一个分类宠物用品」
  // 捕获"分类"之前的名称（如"宠物用品"），排除"分"和"的"字
  const m1 = compact.match(/(?:建一个|新建一个|新建|加一个|创建一个|创建|建)([^\s，。,!.！？?分的]+?)分类/)
  if (m1) {
    const name = cleanName(m1[1])
    if (name && name.length > 0 && name.length <= 10) {
      return { type: "createCategory", name }
    }
  }
  // 「分类叫 XX」「分类改成 XX」（无目标物品时是建分类）
  const m2 = compact.match(/分类(?:叫|改成|改为|调整为)([^\s，。,!.！？?]+)/)
  if (m2 && !/[的把给]/.test(compact.slice(0, compact.indexOf("分类")))) {
    const name = cleanName(m2[1])
    if (name && !state.categories.some((c) => c === name)) {
      // 排除「把猫砂的分类改成 X」这类（前面有目标物品）
      return { type: "createCategory", name }
    }
  }
  return null
}

// ---------- 本地 parser：设置预算 ----------

function tryParseSetMonthlyBudget(text: string): AgentAction | null {
  const compact = cleanText(text)
  // 「这个月预算设成 500」「月预算 500」「预算改成 800 元」「每月预算 1000」
  const m = compact.match(/(?:这个月预算|月预算|每月预算|预算).*?(\d+(?:\.\d+)?)\s*(?:元|块)?/)
  if (m && /预算/.test(compact)) {
    const amount = Number(m[1])
    if (Number.isFinite(amount) && amount >= 0) {
      return { type: "setMonthlyBudget", amount }
    }
  }
  return null
}

// ---------- 本地 parser：修改消耗品字段 ----------

function tryParseUpdateItem(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「猫粮周期改成 30 天」「把猫粮的周期改成 30 天」
  const cycleMatch = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)(?:的)?(?:周期|补货周期).*?(\d+)\s*天/)
  if (cycleMatch) {
    const itemName = cleanName(cycleMatch[1])
    const cycleDays = Number(cycleMatch[2])
    const match = findItemMatch(state, itemName)
    if (match.item && cycleDays > 0) {
      return {
        type: "updateItem",
        itemId: match.item.id,
        itemName: match.item.name,
        cycleDays,
        bufferDays: Math.min(match.item.bufferDays, cycleDays - 1)
      }
    }
  }
  return null
}

// ---------- 第二期：编辑类本地 parser ----------

/** 重命名分类：「把宠物用品改成猫咪用品」「宠物用品分类改名为猫咪用品」「分类「宠物用品」重命名为「猫咪用品」」 */
function tryParseRenameCategory(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「把 X 改成/改为/改叫 Y」「把 X 分类改成 Y」
  const m1 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)(?:分类)?(?:改成|改为|改名为|改叫|重命名(?:为)?)((?:[^\s，。,!.！？?])+)/)
  if (m1 && /(?:改成|改为|改名为|改叫|重命名)/.test(compact)) {
    const oldName = cleanName(m1[1])
    const newName = cleanName(m1[2])
    // oldName 必须是已有分类
    if (oldName && newName && state.categories.some((c) => c === oldName)) {
      return { type: "renameCategory", oldName, newName }
    }
  }
  return null
}

/** 移动消耗品分类：「把猫砂移到猫咪用品」「猫砂归到猫咪用品分类」「把豆腐猫砂放到宠物用品里」 */
function tryParseMoveItem(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「把 X 移到/放到/归到 Y」「X 移到/归到 Y 分类」
  const m1 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)(?:移到|放到|归到|归入|放到)([^\s，。,!.！？?分类的]+?)(?:分类|里|下)?$/)
  if (m1) {
    const itemName = cleanName(m1[1])
    const targetCategory = cleanName(m1[2])
    const match = findItemMatch(state, itemName)
    if (match.item && targetCategory) {
      return {
        type: "moveItem",
        itemId: match.item.id,
        itemName: match.item.name,
        targetCategory
      }
    }
  }
  return null
}

/** 修改单位：「猫砂单位改成袋」「洗衣液单位改成瓶」「厨房纸按包记」 */
function tryParseUpdateItemUnit(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「X 单位改成/改为 Y」—— Y 可能是多字单位（如「公斤」「毫升」），用 + 捕获
  const m1 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)(?:的)?单位(?:改成|改为|设为|设成)([^\s，。,!.！？?]+)/)
  if (m1) {
    const itemName = cleanName(m1[1])
    const unit = cleanName(m1[2])
    const match = findItemMatch(state, itemName)
    if (match.item && unit) {
      return { type: "updateItemUnit", itemId: match.item.id, itemName: match.item.name, unit }
    }
  }
  // 「X 按 Y 记」
  const m2 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)按([^\s，。,!.！？?]+?)记/)
  if (m2) {
    const itemName = cleanName(m2[1])
    const unit = cleanName(m2[2])
    const match = findItemMatch(state, itemName)
    if (match.item && unit) {
      return { type: "updateItemUnit", itemId: match.item.id, itemName: match.item.name, unit }
    }
  }
  return null
}

/** 修改提前提醒天数：「猫砂提前 5 天提醒」「洗衣液快用完前 7 天提醒」「牙膏提前 3 天提示我」 */
function tryParseUpdateItemReminder(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「X 提前 N 天提醒/提示」「X 快用完前 N 天提醒」
  const m = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)(?:快用完前|提前)(\d+)\s*天(?:提醒|提示|通知)?/)
  if (m) {
    const itemName = cleanName(m[1])
    const bufferDays = Number(m[2])
    const match = findItemMatch(state, itemName)
    if (match.item && Number.isInteger(bufferDays) && bufferDays >= 0) {
      return { type: "updateItemReminder", itemId: match.item.id, itemName: match.item.name, bufferDays }
    }
  }
  return null
}

/**
 * 修改常购商品信息：「猫砂常购商品平台改成京东」「pidan 豆腐猫砂价格改成 58」
 * 注意：常购商品 productName 可能含空格（如 "pidan 豆腐猫砂"），但 cleanText 会去空格，
 *      所以这里从原文（text 而非 compact）里提取 productName，再从 state 匹配。
 */
function tryParseUpdatePurchaseOption(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 模式 1：「X 常购商品平台/价格/单位 改成 Y」—— Y 可能多字（如「京东」「淘宝」），用 + 捕获
  const m1 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)常购商品(?:的)?(平台|价格|单位|链接|计量单位|计量基准)(?:改成|改为|设为|设成)([^\s，。,!.！？?]+)/)
  if (m1) {
    const itemName = cleanName(m1[1])
    const field = m1[2]
    const value = m1[3]
    const match = findItemMatch(state, itemName)
    if (match.item) {
      const patch: Record<string, unknown> = {}
      if (field === "平台") patch.platform = value
      else if (field === "价格") {
        const price = Number(value)
        if (!Number.isFinite(price) || price < 0) return null
        patch.price = price
      }
      else if (field === "单位") patch.unit = value
      else if (field === "链接") patch.link = value
      else if (field === "计量单位") patch.measureUnit = value
      else if (field === "计量基准") {
        const amount = Number(value)
        if (!Number.isFinite(amount) || amount <= 0) return null
        patch.measureBaseAmount = amount
      }
      // 从物品下找第一个常购商品作为目标
      const firstOpt = match.item.purchaseOptions[0]
      if (!firstOpt) return null
      return {
        type: "updatePurchaseOption",
        itemId: match.item.id,
        itemName: match.item.name,
        optionId: firstOpt.id,
        productName: firstOpt.productName,
        patch: patch as { productName?: string; unit?: string; platform?: string; price?: number; link?: string; measureUnit?: string; measureBaseAmount?: number }
      }
    }
  }
  // 模式 2：「pidan 豆腐猫砂价格改成 58」（productName 在前，field 在后）
  //        需要遍历所有物品的 purchaseOptions 找匹配
  const m2 = compact.match(/^(.+?)(?:价格|平台|单位)(?:改成|改为|设为|设成)(.+)$/)
  if (m2 && !m2[1].includes("常购商品")) {
    const prodNameRaw = m2[1]
    const field2 = compact.includes("价格") ? "price" : compact.includes("平台") ? "platform" : "unit"
    const valueRaw = m2[2]
    // 遍历物品找匹配 productName 的常购商品
    for (const item of state.items) {
      const opt = item.purchaseOptions.find((o) => cleanName(o.productName) === cleanName(prodNameRaw))
      if (opt) {
        const patch: Record<string, unknown> = {}
        if (field2 === "price") {
          const price = Number(valueRaw)
          if (!Number.isFinite(price) || price < 0) return null
          patch.price = price
        } else if (field2 === "platform") {
          patch.platform = valueRaw
        } else {
          patch.unit = valueRaw
        }
        return {
          type: "updatePurchaseOption",
          itemId: item.id,
          itemName: item.name,
          optionId: opt.id,
          productName: opt.productName,
          patch: patch as { productName?: string; unit?: string; platform?: string; price?: number; link?: string; measureUnit?: string; measureBaseAmount?: number }
        }
      }
    }
  }
  return null
}

/** 设置默认常购商品：「把猫砂默认商品设成 pidan 豆腐猫砂」「把 X 设为默认」 */
function tryParseSetDefaultPurchaseOption(text: string, state: AppState): AgentAction | null {
  const compact = cleanText(text)
  // 「把 X 默认商品设成 Y」「把 Y 设为 X 的默认商品」「把猫砂默认商品设成 pidan 豆腐猫砂」
  const m1 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)默认商品(?:设成|设为|改为)([^\s，。,!.！？?]+)/)
  if (m1) {
    const itemName = cleanName(m1[1])
    const productName = cleanName(m1[2])
    const match = findItemMatch(state, itemName)
    if (match.item) {
      return {
        type: "setDefaultPurchaseOption",
        itemId: match.item.id,
        itemName: match.item.name,
        productName
      }
    }
  }
  // 「把 Y 设为 X 的默认常购商品」
  const m2 = compact.match(/(?:把)?([^\s，。,!.！？?把的]+?)(?:设为|设成)([^\s，。,!.！？?把的]+?)的默认(?:常购商品|商品)/)
  if (m2) {
    const productName = cleanName(m2[1])
    const itemName = cleanName(m2[2])
    const match = findItemMatch(state, itemName)
    if (match.item) {
      return {
        type: "setDefaultPurchaseOption",
        itemId: match.item.id,
        itemName: match.item.name,
        productName
      }
    }
  }
  return null
}

// ---------- 把 AgentDraft 转成 AgentAction[] ----------

function draftToActions(draft: AgentDraft, state: AppState): AgentAction[] {
  if (draft.kind === "createItem") {
    const action: AgentAction = {
      type: "createItem",
      name: draft.itemName,
      category: draft.category,
      cycleDays: draft.cycleDays,
      bufferDays: draft.bufferDays,
      unit: draft.unit
    }
    return [action]
  }
  if (draft.kind === "addPurchaseOption") {
    return [{
      type: "addPurchaseOption",
      itemId: draft.itemId,
      itemName: draft.itemName,
      productName: draft.productName,
      unit: draft.unit
    }]
  }
  if (draft.kind === "restock") {
    return [{
      type: "recordRestock",
      itemId: draft.itemId,
      itemName: draft.itemName,
      qty: draft.qty,
      unit: draft.unit,
      price: draft.price,
      platform: draft.platform,
      purchaseProductName: draft.purchaseProductName,
      cycleDaysPatch: draft.cycleDaysPatch,
      restockDate: draft.restockDate,
      review: draft.review,
      purchaseMeasureAmount: draft.purchaseMeasureAmount,
      purchaseMeasureUnit: draft.purchaseMeasureUnit,
      matchHint: draft.matchHint
    }]
  }
  // createItemWithRestock → 拆成 createItem + recordRestock + (可选)addPurchaseOption
  const actions: AgentAction[] = []
  const createItemAction: AgentAction = {
    type: "createItem",
    name: draft.item.itemName,
    category: draft.item.category,
    cycleDays: draft.item.cycleDays,
    bufferDays: draft.item.bufferDays,
    unit: draft.item.unit
  }
  if (draft.addPurchaseOption?.productName) {
    createItemAction.addPurchaseOption = {
      productName: draft.addPurchaseOption.productName,
      unit: draft.addPurchaseOption.unit
    }
  }
  actions.push(createItemAction)
  actions.push({
    type: "recordRestock",
    itemName: draft.item.itemName,
    qty: draft.restock.qty,
    unit: draft.restock.unit || draft.item.unit,
    price: draft.restock.price,
    platform: draft.restock.platform,
    purchaseProductName: draft.restock.purchaseProductName || draft.item.itemName,
    cycleDaysPatch: draft.restock.cycleDaysPatch,
    restockDate: draft.restock.restockDate,
    review: draft.restock.review,
    purchaseMeasureAmount: draft.restock.purchaseMeasureAmount,
    purchaseMeasureUnit: draft.restock.purchaseMeasureUnit,
    matchHint: draft.restock.matchHint
  })
  return actions
}

// ---------- 主入口 ----------

/**
 * 把用户输入转成 AgentPlan。
 * 优先级：
 *   1. pendingPlan 修订（价格/平台/周期/数量等）
 *   2. 建分类
 *   3. 设置预算
 *   4. 修改消耗品周期
 *   5. 复用 buildLocalDraftFromText 处理「买了/添加/常购商品」等句式
 *   6. 本地解析失败 → noPlan，由调用方决定是否交 LLM
 */
export function buildAgentPlan(input: BuildAgentPlanInput): BuildAgentPlanResult {
  const { text, state, dateContext } = input

  // 1. pendingPlan 修订优先
  if (input.pendingPlan) {
    const revised = tryRevisePendingPlan(input)
    if (revised) {
      return { kind: "plan", plan: revised }
    }
    // pendingPlan 存在但本轮不是修订：交给 orchestrator 判断是 confirm/cancel/新请求
    // 这里返回 noPlan，让 orchestrator 走 confirm/cancel 检测
    return { kind: "noPlan" }
  }

  // 2. 建分类
  const categoryAction = tryParseCreateCategory(text, state)
  if (categoryAction) {
    return { kind: "plan", plan: createAgentPlan([categoryAction], text) }
  }

  // 3. 设置预算
  const budgetAction = tryParseSetMonthlyBudget(text)
  if (budgetAction) {
    return { kind: "plan", plan: createAgentPlan([budgetAction], text) }
  }

  // 4. 修改消耗品周期
  const updateAction = tryParseUpdateItem(text, state)
  if (updateAction) {
    return { kind: "plan", plan: createAgentPlan([updateAction], text) }
  }

  // 4b. 第二期编辑类：重命名分类、移动分类、改单位、改提醒、改常购商品、设默认
  const renameAction = tryParseRenameCategory(text, state)
  if (renameAction) {
    return { kind: "plan", plan: createAgentPlan([renameAction], text) }
  }
  const moveAction = tryParseMoveItem(text, state)
  if (moveAction) {
    return { kind: "plan", plan: createAgentPlan([moveAction], text) }
  }
  const unitAction = tryParseUpdateItemUnit(text, state)
  if (unitAction) {
    return { kind: "plan", plan: createAgentPlan([unitAction], text) }
  }
  const reminderAction = tryParseUpdateItemReminder(text, state)
  if (reminderAction) {
    return { kind: "plan", plan: createAgentPlan([reminderAction], text) }
  }
  const updateOptAction = tryParseUpdatePurchaseOption(text, state)
  if (updateOptAction) {
    return { kind: "plan", plan: createAgentPlan([updateOptAction], text) }
  }
  const setDefaultAction = tryParseSetDefaultPurchaseOption(text, state)
  if (setDefaultAction) {
    return { kind: "plan", plan: createAgentPlan([setDefaultAction], text) }
  }

  // 5. 复用 buildLocalDraftFromText 处理「买了/添加/常购商品」
  const draft = buildLocalDraftFromText(text, state)
  if (draft) {
    let actions = draftToActions(draft, state)
    // 后处理：从「N 天提醒一次」「周期 N 天」中提取 cycleDays，补到 createItem / recordRestock
    actions = applyCycleDaysFromText(actions, text)
    if (actions.length > 0) {
      return { kind: "plan", plan: createAgentPlan(actions, text) }
    }
  }

  // 6. 本地解析失败
  return { kind: "noPlan" }
}

/** 从「20 天提醒一次」「周期 30 天」中提取 cycleDays，补到 createItem / recordRestock action。
 *  buildLocalDraftFromText 不解析这类周期信号，这里统一后处理。 */
function applyCycleDaysFromText(actions: AgentAction[], text: string): AgentAction[] {
  const compact = cleanText(text)
  const m = compact.match(/(\d+)\s*天(?:提醒|补货|周期|一轮)/) || compact.match(/(?:周期|补货周期).*?(\d+)\s*天/)
  if (!m) return actions
  const cycleDays = Number(m[1])
  if (!Number.isFinite(cycleDays) || cycleDays <= 0) return actions
  return actions.map((action) => {
    if (action.type === "createItem") {
      return { ...action, cycleDays, bufferDays: Math.min(action.bufferDays, cycleDays - 1) }
    }
    if (action.type === "recordRestock") {
      return { ...action, cycleDaysPatch: cycleDays }
    }
    return action
  })
}

// ---------- 摘要生成（供 orchestrator/UI 使用） ----------

/** 从 AgentPlan 生成管家口吻的处理方案文案。 */
export function composePlanMessage(plan: AgentPlan, state: AppState): string {
  if (plan.actions.length === 0) return "我准备这样处理。"
  const lines = plan.actions.map((action, index) => {
    const summary = summarizeActionLocal(action, state)
    return `${index + 1}. ${summary}`
  })
  return `我准备这样处理：\n${lines.join("\n")}\n你要是没问题，我就按这个来。`
}

function summarizeActionLocal(action: AgentAction, state: AppState): string {
  switch (action.type) {
    case "createCategory":
      return `新建分类：${action.name}`
    case "createItem": {
      const parts = [`添加消耗品「${action.name}」`]
      parts.push(`分类 ${action.category}`)
      parts.push(`周期 ${action.cycleDays} 天`)
      if (action.addPurchaseOption?.productName) {
        parts.push(`常购商品 ${action.addPurchaseOption.productName}`)
      }
      return parts.join(" · ")
    }
    case "updateItem": {
      const target = action.itemName || action.itemId || "目标物品"
      const changes: string[] = []
      if (action.cycleDays !== undefined) changes.push(`周期 ${action.cycleDays} 天`)
      if (action.bufferDays !== undefined) changes.push(`提前 ${action.bufferDays} 天`)
      if (action.category) changes.push(`分类 ${action.category}`)
      if (action.unit) changes.push(`单位 ${action.unit}`)
      return `修改「${target}」：${changes.join("，") || "无变更"}`
    }
    case "addPurchaseOption":
      return `常购商品「${action.productName}」挂到「${action.itemName}」下`
    case "recordRestock": {
      const parts = [`记一笔补货：${action.itemName}`]
      if (action.qty) parts.push(`${action.qty}${action.unit || "件"}`)
      if (action.platform) parts.push(action.platform)
      if (action.price !== undefined) parts.push(`¥${action.price}`)
      return parts.join(" · ")
    }
    case "updateRestockRecord": {
      const changes: string[] = []
      if (action.patch.price !== undefined) changes.push(`价格 ¥${action.patch.price}`)
      if (action.patch.platform) changes.push(`平台 ${action.patch.platform}`)
      return `修改补货记录：${changes.join("，") || "无变更"}`
    }
    case "setMonthlyBudget":
      return `本月预算设为 ¥${action.amount}`
    case "renameCategory":
      return `重命名分类：${action.oldName} → ${action.newName}`
    case "moveItem": {
      const target = action.itemName || action.itemId || "目标物品"
      return `把「${target}」移到分类「${action.targetCategory}」`
    }
    case "updateItemUnit": {
      const target = action.itemName || action.itemId || "目标物品"
      return `「${target}」单位改为 ${action.unit}`
    }
    case "updateItemReminder": {
      const target = action.itemName || action.itemId || "目标物品"
      return `「${target}」提前 ${action.bufferDays} 天提醒`
    }
    case "updatePurchaseOption": {
      const target = action.itemName || action.itemId || "目标物品"
      const which = action.productName || action.optionId || "常购商品"
      const changes: string[] = []
      if (action.patch.productName) changes.push(`名称 ${action.patch.productName}`)
      if (action.patch.unit) changes.push(`单位 ${action.patch.unit}`)
      if (action.patch.platform) changes.push(`平台 ${action.patch.platform}`)
      if (action.patch.price !== undefined) changes.push(`价格 ¥${action.patch.price}`)
      if (action.patch.measureUnit) changes.push(`计量单位 ${action.patch.measureUnit}`)
      if (action.patch.measureBaseAmount !== undefined) changes.push(`计量基准 ${action.patch.measureBaseAmount}`)
      return `「${target}」·「${which}」：${changes.join("，") || "无变更"}`
    }
    case "setDefaultPurchaseOption": {
      const target = action.itemName || action.itemId || "目标物品"
      const which = action.productName || action.optionId || "常购商品"
      return `把「${target}」的默认常购商品设为「${which}」`
    }
    default:
      return "（未实现的动作）"
  }
}

// 暴露给测试和外部使用的工具
export { draftToActions, summarizeActionLocal }
