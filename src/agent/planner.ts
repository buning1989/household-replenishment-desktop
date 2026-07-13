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
import { isPlanFullyExecutable, planContainsClosedActions } from "./capabilities"

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

/**
 * 转义正则元字符。把 state 里的分类名/物品名拼进 new RegExp 前必须调用，
 * 否则分类名含 ( ) + * ? [ ] { } \ | . 等字符时会抛 SyntaxError。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 清洗实体名（分类名/物品名）。
 * 与 cleanName 的区别：不剥尾部「分类/消耗品/物品」——这些可能是合法分类名的一部分
 * （如「临时分类」）。只去空白、标点、语气词。
 */
function cleanEntityName(raw: string): string {
  return cleanText(raw)
    .replace(/^帮我|^请帮我|^我想|^给我/, "")
    .replace(/^把|^这个|^一下|一下吧$/g, "")
    .replace(/[，。,.!！?？]/g, "")
    .trim()
}

/**
 * 从 state.categories 中找出出现在 text 里的分类名。
 * 优先 exact inclusion（不是正则截断），多个命中时选最长（避免「卫生间」抢走「卫生间用品」）。
 * 用于删除类 parser 的分类名提取，避免靠字符集排除导致含「下/中/里」的分类名被截断。
 */
function resolveCategoryNameFromText(text: string, state: AppState): string | null {
  const compact = cleanText(text)
  const matches: string[] = []
  for (const cat of state.categories) {
    const catCompact = cleanText(cat)
    if (catCompact && compact.includes(catCompact)) {
      matches.push(cat)
    }
  }
  if (matches.length === 0) return null
  // 选最长匹配
  matches.sort((a, b) => cleanText(b).length - cleanText(a).length)
  return matches[0]
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

// ---------- 第三期：删除类本地 parser ----------

/**
 * 删除常购商品：「删除猫砂的 pidan 豆腐猫砂常购商品」「把猫砂里的 pidan 豆腐猫砂删掉」
 * 必须明确 item + purchaseOption；匹配不明确（0 个或多个）返回 clarification。
 */
function tryParseDeletePurchaseOption(text: string, state: AppState): BuildAgentPlanResult {
  const compact = cleanText(text)
  if (!/(删除|删掉|去掉|移除)/.test(compact)) return { kind: "noPlan" }
  // 文本含「补货记录」或「分类」时交给对应 parser，避免误匹配
  if (/补货记录|分类/.test(compact)) return { kind: "noPlan" }
  // guard：含「消耗品/物品/东西」语义词时交给 tryParseDeleteItemsInCategory 处理，
  // 避免「删除卫生间的消耗品」被误当 itemName=卫生间、productName=消耗品
  if (/(消耗品|物品|东西)/.test(compact)) return { kind: "noPlan" }
  // 模式 1：「删除 X 的 Y 常购商品」「删掉 X 的 Y 常购商品」
  const m1 = compact.match(/(?:删除|删掉|去掉|移除)([^\s，。,!.！？?把的里]+?)(?:的|里的)(.+?)(?:常购商品)?$/)
  if (m1) {
    const itemName = cleanName(m1[1])
    const productName = cleanName(m1[2])
    if (!productName) return { kind: "noPlan" }
    return buildDeletePurchaseOptionPlan(itemName, productName, state, text)
  }
  // 模式 2：「把 X 里的 Y (常购商品) 删掉」
  const m2 = compact.match(/(?:把)([^\s，。,!.！？?把的里]+?)(?:的|里的)(.+?)(?:常购商品)?(?:删掉|删除|去掉|移除)/)
  if (m2) {
    const itemName = cleanName(m2[1])
    const productName = cleanName(m2[2])
    if (!productName) return { kind: "noPlan" }
    return buildDeletePurchaseOptionPlan(itemName, productName, state, text)
  }
  return { kind: "noPlan" }
}

function buildDeletePurchaseOptionPlan(itemName: string, productName: string, state: AppState, sourceText: string): BuildAgentPlanResult {
  const match = findItemMatch(state, itemName)
  if (!match.item) {
    return { kind: "clarification", message: `找不到消耗品「${itemName}」。` }
  }
  const opts = match.item.purchaseOptions.filter((o) => cleanName(o.productName) === productName)
  if (opts.length === 0) {
    return { kind: "clarification", message: `「${match.item.name}」下没有常购商品匹配「${productName}」。` }
  }
  if (opts.length > 1) {
    return { kind: "clarification", message: `「${match.item.name}」下有多个常购商品匹配「${productName}」，请明确指定。` }
  }
  return { kind: "plan", plan: createAgentPlan([{
    type: "deletePurchaseOption",
    itemId: match.item.id,
    itemName: match.item.name,
    optionId: opts[0].id,
    productName: opts[0].productName
  }], sourceText) }
}

/**
 * 阶段 4B.7 补口：指代词检测。
 *
 * 当用户说「删除这条补货记录」「删掉那次记录」「把这条记录删掉」时，
 * 提取出的 itemName 可能是「这条」「那次」等指代词，而非真实物品名。
 * 此时不应把指代词当物品名去 findItemMatch，也不应建议「帮我加」，
 * 而应直接追问用户指定物品名和日期。
 */
const DEICTIC_REFERENCE_PATTERN = /^(这条|这笔|这次|那条|那笔|那次|这条记录|这笔记录|那条记录|这次补货|那条补货|这|那)$/

function isDeicticReference(s: string): boolean {
  return DEICTIC_REFERENCE_PATTERN.test(s.trim())
}

/**
 * 删除补货记录：「删除猫砂最近一条补货记录」「删除猫砂昨天那条补货记录」「删除猫砂价格 58 的那条补货记录」
 * 无法唯一定位时返回 clarification，不生成 plan。
 */
function tryParseDeleteRestockRecord(text: string, state: AppState): BuildAgentPlanResult {
  const compact = cleanText(text)
  if (!/补货记录/.test(compact) || !/(删除|删掉|去掉|移除)/.test(compact)) return { kind: "noPlan" }
  // 提取物品名：「删除 X ...」或「把 X 的 ... 删掉」
  const m = compact.match(/(?:删除|删掉|去掉|移除|把)([^\s，。,!.！？?把的最近一条昨天前天今天价格元块那补货记录删掉]+)/)
  if (!m) return { kind: "noPlan" }
  const itemName = cleanName(m[1])
  // 阶段 4B.7 补口：指代词检测。
  //   「删除这条补货记录」「删掉那次记录」等没指定物品名，不应把「这条」当物品名，
  //   也不应建议「帮我加」。直接追问物品名和日期。
  if (isDeicticReference(itemName)) {
    return { kind: "clarification", message: "你想删除哪一条补货记录？可以告诉我物品名和日期。" }
  }
  const match = findItemMatch(state, itemName)
  if (!match.item) {
    return { kind: "clarification", message: `找不到消耗品「${itemName}」。` }
  }
  if (match.item.history.length === 0) {
    return { kind: "clarification", message: `「${match.item.name}」还没有补货记录。` }
  }
  let dateHint: string | undefined
  let price: number | undefined
  if (/最近一条|最后一条/.test(compact)) dateHint = "最近一条"
  else if (/昨天/.test(compact)) dateHint = "昨天"
  else if (/前天/.test(compact)) dateHint = "前天"
  else if (/今天/.test(compact)) dateHint = "今天"
  const priceMatch = compact.match(/价格(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*[元块]/)
  if (priceMatch) {
    price = Number(priceMatch[1] || priceMatch[2])
  }

  // 「最近一条」是位置提示而非日期匹配，不应走 matchesDateHintLocal 过滤（它会对全部记录返回 true，导致多匹配澄清）
  if ((dateHint === "最近一条" || !dateHint) && price === undefined) {
    return { kind: "plan", plan: createAgentPlan([{
      type: "deleteRestockRecord",
      itemId: match.item.id,
      itemName: match.item.name,
      dateHint: "最近一条"
    }], text) }
  }
  const matches = match.item.history.filter((e) => {
    if (dateHint && dateHint !== "最近一条" && !matchesDateHintLocal(e.at, dateHint)) return false
    if (price !== undefined && (e.price ?? 0) !== price) return false
    return true
  })
  if (matches.length === 0) {
    return { kind: "clarification", message: `「${match.item.name}」下没有匹配的补货记录。` }
  }
  if (matches.length > 1) {
    return { kind: "clarification", message: `「${match.item.name}」下有 ${matches.length} 条匹配的补货记录，请明确指定（如「价格 58 那条」）。` }
  }
  return { kind: "plan", plan: createAgentPlan([{
    type: "deleteRestockRecord",
    itemId: match.item.id,
    itemName: match.item.name,
    recordId: matches[0].id,
    dateHint,
    price
  }], text) }
}

/** 本地版 matchesDateHint，与 executor.ts 的 matchesDateHint 保持一致。 */
function matchesDateHintLocal(at: number, hint: string): boolean {
  const hintLower = hint.trim()
  if (hintLower === "最近一条") return true
  const date = new Date(at)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000))
  if (hintLower === "今天") return diffDays === 0
  if (hintLower === "昨天") return diffDays === 1
  if (hintLower === "前天") return diffDays === 2
  return false
}

// ---------- 第三期补丁：统一实体识别 ----------

export type EntityMention =
  | { kind: "category"; name: string; confidence: "exact" | "alias" | "substring" }
  | { kind: "item"; itemId: string; name: string; confidence: "exact" | "synonym" | "substring" }
  | { kind: "purchaseOption"; itemId: string; itemName: string; optionId: string; productName: string }
  | { kind: "unknown"; raw: string }

/**
 * 统一实体识别：把候选名识别为 category / item / unknown。
 * 各 delete parser 共用此函数，避免把"卫生间下/卫生间中"等方位表达当成物品名。
 *
 * 优先级：
 *   1. 剥离尾部方位词（下/中/里）和结构词（消耗品/物品/分类）
 *   2. state.categories 精确命中 → category
 *   3. 分类与物品同名 → unknown（歧义，由调用方生成 clarification）
 *   4. state.items 命中 → item
 *   5. 无命中 → unknown
 */
export function resolveEntityMention(rawName: string, state: AppState): EntityMention {
  // 先剥结构词再剥方位词，循环直到稳定，避免「X 下的消耗品」残留「X 下的」
  let cleaned = cleanText(rawName)
  let prev = ""
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned
      .replace(/(这个消耗品|这个物品|这个分类|消耗品|物品|分类)$/, "")
      .replace(/[下中里]的?$/, "")
      .trim()
  }

  if (!cleaned) return { kind: "unknown", raw: cleaned }

  // 检查是否是分类
  const categoryMatch = state.categories.find((c) => cleanText(c) === cleanText(cleaned))
  if (categoryMatch) {
    // 分类与物品同名 → 歧义
    const sameNameItem = state.items.find((item) => cleanText(item.name) === cleanText(cleaned))
    if (sameNameItem) {
      return { kind: "unknown", raw: cleaned }
    }
    return { kind: "category", name: categoryMatch, confidence: "exact" }
  }

  // 检查是否是物品
  const match = findItemMatch(state, cleaned)
  if (match.item) {
    if (match.confidence === "ambiguous" && match.candidates.length > 1) {
      return { kind: "unknown", raw: cleaned }
    }
    return {
      kind: "item",
      itemId: match.item.id,
      name: match.item.name,
      confidence: match.confidence === "exact" ? "exact" : "synonym"
    }
  }

  return { kind: "unknown", raw: rawName }
}

// ---------- 第三期补丁：删除分类下全部消耗品 ----------

/**
 * 删除分类下全部消耗品：
 *   「删除卫生间下的消耗品」「删除卫生间中的物品」「删除卫生间里的东西」
 *   「删除卫生间的消耗品」「清空卫生间的物品」（无方位词）
 *   「清空卫生间分类」「把卫生间里的东西都删掉」
 * 生成多个 deleteItem action（不用 deleteCategory，deleteCategory 仅删空分类）。
 *
 * 识别策略：优先从 state.categories 匹配分类名（resolveCategoryNameFromText），
 * 不靠正则字符集排除——避免「楼下超市」「车里备货」等含方位词的分类名被截断。
 */
function tryParseDeleteItemsInCategory(text: string, state: AppState): BuildAgentPlanResult {
  const compact = cleanText(text)
  if (!/(删除|删掉|去掉|移除|清空)/.test(compact)) return { kind: "noPlan" }

  // 必须含分类范围语义词：消耗品 / 物品 / 东西 / 分类（清空 X 分类）
  const hasScopeWord = /(消耗品|物品|东西)/.test(compact)
  const hasClearCategory = /清空.*分类/.test(compact)
  if (!hasScopeWord && !hasClearCategory) return { kind: "noPlan" }

  // 优先从 state.categories 匹配分类名（exact inclusion，最长匹配）
  const categoryName = resolveCategoryNameFromText(text, state)
  if (categoryName) {
    // 验证分类名后跟语义结构：[下/中/里]的 + 消耗品/物品/东西，或 清空 X 分类
    const escaped = escapeRegExp(cleanText(categoryName))
    const hasStructure = new RegExp(`${escaped}(?:下|中|里)?的?(?:消耗品|物品|东西)`).test(compact)
      || new RegExp(`清空${escaped}(?:分类)?`).test(compact)
      || new RegExp(`(?:把)${escaped}(?:下|中|里)?的?(?:东西|消耗品|物品)`).test(compact)
    if (hasStructure) {
      return buildDeleteItemsInCategoryPlan(categoryName, state, text)
    }
  }

  // 回退正则（分类不在 state 时，返回"分类不存在"）
  // 仅保留含方位词或「清空...分类」的模式，避免误吞「把猫砂这个消耗品删掉」等单项删除句式
  // 模式 1b：「删除/清空 X 下的/中的/里的 消耗品/物品/东西」（方位词必需）
  const m1b = compact.match(/(?:删除|删掉|去掉|移除|清空)([^\s，。,!.！？?把的]+?)(?:下|中|里)的?(?:消耗品|物品|东西)/)
  if (m1b) {
    return buildDeleteItemsInCategoryPlan(cleanEntityName(m1b[1]), state, text)
  }
  // 模式 2a：「清空 X 分类」
  const m2a = compact.match(/清空([^\s，。,!.！？?把的]+?)分类/)
  if (m2a) {
    return buildDeleteItemsInCategoryPlan(cleanEntityName(m2a[1]), state, text)
  }
  // 模式 3：「把 X [下/中/里]的 东西/消耗品/物品 都删掉」（方位词+的 必需，排除「这个」防误吞单项删除）
  const m3 = compact.match(/(?:把)([^\s，。,!.！？?把这个的里下中]+?)(?:下|中|里)的(?:东西|消耗品|物品)(?:都)?(?:删掉|删除|去掉|移除)/)
  if (m3) {
    return buildDeleteItemsInCategoryPlan(cleanEntityName(m3[1]), state, text)
  }

  return { kind: "noPlan" }
}

function buildDeleteItemsInCategoryPlan(categoryName: string, state: AppState, sourceText: string): BuildAgentPlanResult {
  if (!categoryName) return { kind: "noPlan" }
  const exists = state.categories.some((c) => cleanText(c) === cleanText(categoryName))
  if (!exists) {
    return { kind: "clarification", message: `分类「${categoryName}」不存在。` }
  }
  // 用原始分类名（state 中的精确值）查 items，避免 cleanText 差异导致漏匹配
  const exactCat = state.categories.find((c) => cleanText(c) === cleanText(categoryName))!
  const itemsInCategory = state.items.filter((item) => item.category === exactCat)
  if (itemsInCategory.length === 0) {
    return { kind: "clarification", message: `分类「${exactCat}」下没有消耗品。` }
  }
  const actions: AgentAction[] = itemsInCategory.map((item) => ({
    type: "deleteItem" as const,
    itemId: item.id,
    itemName: item.name
  }))
  return { kind: "plan", plan: createAgentPlan(actions, sourceText) }
}

/**
 * 删除消耗品：「删除猫砂」「把猫砂这个消耗品删掉」「不再管理猫砂」
 * 物品名匹配多个候选时返回 clarification。
 */
function tryParseDeleteItem(text: string, state: AppState): BuildAgentPlanResult {
  const compact = cleanText(text)
  if (!/(删除|删掉|去掉|移除|不再管理|不要了)/.test(compact)) return { kind: "noPlan" }
  // 「不再管理 X」「不再管 X」
  const m0 = compact.match(/不再管(?:理)?([^\s，。,!.！？?]+)/)
  if (m0) {
    const name = cleanName(m0[1])
    // 如果 name 是已有分类名，不当作 item（由 tryParseDeleteCategory 处理）
    if (name && state.categories.some((c) => cleanText(c) === cleanText(name))) {
      return { kind: "noPlan" }
    }
    return buildDeleteItemPlan(name, state, text)
  }
  // 「删除 X」「删掉 X」「去掉 X」
  // 排除字符集加入"下中里"避免"卫生间下"被当成物品名
  const m1 = compact.match(/(?:删除|删掉|去掉|移除)([^\s，。,!.！？?把的消耗品分类补货记录常购商品删掉下中里]+)/)
  if (m1) {
    if (/(分类|补货记录|常购商品)/.test(m1[1])) return { kind: "noPlan" }
    const name = cleanName(m1[1])
    // 如果 name 是已有分类名，不当作 item（由 tryParseDeleteCategory 处理）
    if (name && state.categories.some((c) => cleanText(c) === cleanText(name))) {
      return { kind: "noPlan" }
    }
    return buildDeleteItemPlan(name, state, text)
  }
  // 「把 X (这个消耗品) 删掉」
  const m2 = compact.match(/(?:把)([^\s，。,!.！？?把的消耗品分类补货记录常购商品删掉下中里]+?)(?:这个消耗品|这个物品)?(?:删掉|删除|去掉|移除)/)
  if (m2) {
    if (/(分类|补货记录|常购商品)/.test(m2[1])) return { kind: "noPlan" }
    const name = cleanName(m2[1])
    if (name && state.categories.some((c) => cleanText(c) === cleanText(name))) {
      return { kind: "noPlan" }
    }
    return buildDeleteItemPlan(name, state, text)
  }
  return { kind: "noPlan" }
}

function buildDeleteItemPlan(itemName: string, state: AppState, sourceText: string): BuildAgentPlanResult {
  if (!itemName) return { kind: "noPlan" }
  const match = findItemMatch(state, itemName)
  if (match.confidence === "ambiguous" && match.candidates.length > 1) {
    return {
      kind: "clarification",
      message: `「${itemName}」可能对应：${match.candidates.join("、")}，请确认要删除哪一个。`
    }
  }
  if (!match.item) {
    return { kind: "clarification", message: `找不到消耗品「${itemName}」。` }
  }
  return { kind: "plan", plan: createAgentPlan([{
    type: "deleteItem",
    itemId: match.item.id,
    itemName: match.item.name
  }], sourceText) }
}

/**
 * 删除分类：「删除猫咪用品分类」「把猫咪用品分类删掉」「删除卫生间」（卫生间是分类时）
 * 「不再管理卫生间」「不再管理卫生间分类」也走这里。
 * 不要求文本必须含"分类"关键词——从 state.categories 匹配即可。
 * 非空分类 → clarification（不生成可确认 plan）。
 * 分类与物品同名 → clarification（歧义）。
 */
function tryParseDeleteCategory(text: string, state: AppState): BuildAgentPlanResult {
  const compact = cleanText(text)
  if (!/(删除|删掉|去掉|移除|不再管理|不再管)/.test(compact)) return { kind: "noPlan" }

  // 「删除 X 下的消耗品/物品」「删除 X 的消耗品」由 tryParseDeleteItemsInCategory 处理，这里跳过
  // 含消耗品/物品/东西语义词且非「不再管理」句式时，让位给批量删除 parser
  if (!/不再管/.test(compact) && /(消耗品|物品|东西)/.test(compact)) return { kind: "noPlan" }

  const isNoLongerManage = /不再管/.test(compact)
  const deleteVerb = isNoLongerManage
    ? "(?:不再管理|不再管)"
    : "(?:删除|删掉|去掉|移除)"

  // 优先从 state.categories 匹配分类名（escapeRegExp 防止元字符崩溃，最长匹配防止子串误判）
  const categoryName = resolveCategoryNameFromText(text, state)
  if (categoryName) {
    const escaped = escapeRegExp(cleanText(categoryName))
    // "删除卫生间" / "删除卫生间分类" / "不再管理卫生间" / "不再管理卫生间分类"
    if (new RegExp(`${deleteVerb}${escaped}(?:这个分类|分类)?$`).test(compact)) {
      return buildDeleteCategoryPlan(categoryName, state, text)
    }
    // "把卫生间删掉" / "把卫生间分类删掉"
    if (!isNoLongerManage && new RegExp(`(?:把)${escaped}(?:这个分类|分类)?(?:删掉|删除|去掉|移除)`).test(compact)) {
      return buildDeleteCategoryPlan(categoryName, state, text)
    }
  }

  // 回退到正则匹配（文本含"分类"关键词时，用于分类名不在 state.categories 中的情况）
  if (/分类/.test(compact)) {
    const m1 = compact.match(new RegExp(`${deleteVerb}([^\s，。,!.！？?把的删掉]+?)分类`))
    if (m1) {
      return buildDeleteCategoryPlan(cleanEntityName(m1[1]), state, text)
    }
    if (!isNoLongerManage) {
      const m2 = compact.match(/(?:把)([^\s，。,!.！？?把的删掉]+?)分类(?:删掉|删除|去掉|移除)/)
      if (m2) {
        return buildDeleteCategoryPlan(cleanEntityName(m2[1]), state, text)
      }
    }
  }
  return { kind: "noPlan" }
}

function buildDeleteCategoryPlan(categoryName: string, state: AppState, sourceText: string): BuildAgentPlanResult {
  if (!categoryName) return { kind: "noPlan" }
  const exactCat = state.categories.find((c) => cleanText(c) === cleanText(categoryName))
  if (!exactCat) {
    return { kind: "clarification", message: `分类「${categoryName}」不存在。` }
  }

  // 分类与物品同名 → 歧义
  const sameNameItem = state.items.find((item) => cleanText(item.name) === cleanText(exactCat))
  if (sameNameItem) {
    return {
      kind: "clarification",
      message: `「${exactCat}」既是分类也是消耗品。你是想删除分类「${exactCat}」还是消耗品「${exactCat}」？`,
      options: [`删除分类「${exactCat}」`, `删除消耗品「${exactCat}」`]
    }
  }

  const itemCount = state.items.filter((item) => item.category === exactCat).length
  if (itemCount > 0) {
    return {
      kind: "clarification",
      message: `分类「${exactCat}」下还有 ${itemCount} 个消耗品，请先移动或删除这些消耗品。`
    }
  }
  return { kind: "plan", plan: createAgentPlan([{
    type: "deleteCategory",
    categoryName: exactCat
  }], sourceText) }
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
  //    注意：仅保留对录入类 plan 的修订（补货/创建）。管理类 plan 不再生成，
  //    所以正常新会话不会进入此分支；旧 pendingPlan 兼容兜底仍保留。
  if (input.pendingPlan) {
    const revised = tryRevisePendingPlan(input)
    if (revised) {
      // 能力收缩：修订后的 plan 若包含已关闭的管理类 action，不再返回
      if (planContainsClosedActions(revised.actions.map((a) => a.type))) {
        return { kind: "noPlan" }
      }
      return { kind: "plan", plan: revised }
    }
    // pendingPlan 存在但本轮不是修订：交给 orchestrator 判断是 confirm/cancel/新请求
    // 这里返回 noPlan，让 orchestrator 走 confirm/cancel 检测
    return { kind: "noPlan" }
  }

  // 2. 建分类（录入域必要能力，保留）
  const categoryAction = tryParseCreateCategory(text, state)
  if (categoryAction) {
    return { kind: "plan", plan: createAgentPlan([categoryAction], text) }
  }

  // 能力收缩：以下管理类入口已关闭，不再通过对话生成 pendingPlan。
  //   - 设置预算（setMonthlyBudget）         → 导航到设置页
  //   - 修改消耗品周期（updateItem）          → 定位到物品详情
  //   - 重命名分类（renameCategory）         → 定位到分类设置
  //   - 移动消耗品（moveItem）               → 定位到物品详情
  //   - 改单位（updateItemUnit）             → 定位到物品详情
  //   - 改提醒（updateItemReminder）         → 定位到物品详情
  //   - 改常购商品（updatePurchaseOption）   → 定位到物品详情
  //   - 设默认常购商品（setDefaultPurchaseOption） → 定位到物品详情
  //   - 删除消耗品/分类/常购商品/补货记录    → 定位到对应详情/列表
  //
  // 这些请求由 turnInterpretation 识别为 delete_request / manage_item / manage_budget，
  // 再由 focusResolver 路由到 route_to_navigate，由 householdOrchestrator 返回导航回答。
  // 旧 tryParse* 函数保留（兼容已有测试和 executor），但不再从主链路调用。

  // 3. 复用 buildLocalDraftFromText 处理「买了/添加/常购商品」
  const draft = buildLocalDraftFromText(text, state)
  if (draft) {
    let actions = draftToActions(draft, state)
    // 后处理：从「N 天提醒一次」「周期 N 天」中提取 cycleDays，补到 createItem / recordRestock
    actions = applyCycleDaysFromText(actions, text)
    if (actions.length > 0) {
      // 能力收缩：仅保留可执行 action（createItem / addPurchaseOption / recordRestock / createCategory）
      if (isPlanFullyExecutable(actions.map((a) => a.type))) {
        return { kind: "plan", plan: createAgentPlan(actions, text) }
      }
    }
  }

  // 4. 本地解析失败
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

  // 批量删除消耗品的特殊文案（tryParseDeleteItemsInCategory 生成的 plan）
  if (plan.actions.length > 1 && plan.actions.every((a) => a.type === "deleteItem")) {
    const names = plan.actions.map((a) => a.itemName).join("、")
    return `这个操作会删除以下 ${plan.actions.length} 个消耗品及它们的补货记录、常购商品和提醒状态，需要你二次确认：\n${names}\n你要是没问题，我就按这个来。`
  }

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
    case "deletePurchaseOption": {
      const target = action.itemName || action.itemId || "目标物品"
      const which = action.productName || action.optionId || "常购商品"
      return `删除常购商品「${which}」（归属「${target}」）`
    }
    case "deleteRestockRecord": {
      const target = action.itemName || action.itemId || "目标物品"
      const which = action.recordId
        ? `记录 ${action.recordId}`
        : action.dateHint
          ? `${action.dateHint}的补货记录`
          : action.price !== undefined
            ? `价格 ¥${action.price} 的补货记录`
            : "最近一条补货记录"
      return `删除「${target}」的${which}`
    }
    case "deleteItem": {
      return `删除消耗品「${action.itemName}」（含补货记录、常购商品及提醒状态，不可撤销）`
    }
    case "deleteCategory": {
      return `删除分类「${action.categoryName}」`
    }
    case "calibrateInventory": {
      const daysText = action.remainingDays === 0
        ? "已用完"
        : `还能用 ${action.remainingDays} 天`
      return `更新「${action.itemName}」的库存状态：${daysText}`
    }
    default:
      return "（未实现的动作）"
  }
}

// 暴露给测试和外部使用的工具
export { draftToActions, summarizeActionLocal }
