/**
 * 任务一（观察引擎）：管家「最近注意到」的纯逻辑模块。
 *
 * 总体原则：
 * - 全部为纯函数，便于单测；涉及日期判断一律接受 ChatDateContext 注入，禁止内部 Date.now()。
 * - 不改草稿确认制，不重构现有函数；householdChat.ts 内已有的价格异常内联逻辑
 *   保持原样，本模块导出的 detectPriceAnomaly 可供后续任务复用，本次不做迁移。
 * - 文案保持管家口吻：口语、克制、无 Markdown、无 emoji、不暴露推理过程。
 *
 * 五类观察：budgetThreshold / dueSoon / priceAnomaly / cycleDrift / negativeReviewRepurchase
 * 排序：attention 在前，同级按关联物品 dueAt 升序；调用方决定取几条。
 */

import { calculateMonthlySpend } from "../pure-logic.mjs"
import { formatPrice } from "../domain"
import { PROFILE_OPTIONS } from "../model/householdProfile"
import { REVIEW_KEYWORDS } from "./intent"
import type { AppState, HouseholdProfile, ReplenishmentItem } from "../types"
import type { ChatDateContext, HouseholdChatItemView } from "../llm/householdChat"

// ---------- 类型 ----------

export type ManagerObservation = {
  kind: "budgetThreshold" | "dueSoon" | "priceAnomaly" | "cycleDrift" | "negativeReviewRepurchase"
  severity: "info" | "attention"   // attention 类优先展示
  itemId?: string                   // 关联物品（预算类可为空）
  text: string                      // 一句口语化管家表述，可直接展示
}

// ---------- 阈值常量（提取为模块内常量，方便调整） ----------

/** 本月支出/预算 ≥ 此值时产出 info 级观察 */
export const BUDGET_INFO_THRESHOLD = 0.85
/** 本月支出/预算 ≥ 此值时升级为 attention 级观察 */
export const BUDGET_ATTENTION_THRESHOLD = 1.0
/** 多少天内到提醒点算 dueSoon */
export const DUE_SOON_DAYS = 3
/** 单价偏离均价比例阈值（0.10 = 10%） */
export const PRICE_ANOMALY_RATIO = 0.10
/** 周期漂移：实际间隔比 cycleDays 短多少比例才算漂移 */
export const CYCLE_DRIFT_RATIO = 0.20
/** 周期漂移需要连续多少次都更短 */
export const CYCLE_DRIFT_CONSECUTIVE = 2

/**
 * 负面评价关键词：REVIEW_KEYWORDS 中明确表达负面感受的子集。
 * 沿用 intent.ts 的 REVIEW_KEYWORDS，剔除正向词「好用」「回购」。
 */
export const NEGATIVE_REVIEW_KEYWORDS = REVIEW_KEYWORDS.filter(
  (keyword) => keyword !== "好用" && keyword !== "回购"
)

// ---------- 主函数 ----------

/**
 * 基于当前家庭数据和日期上下文，产出管家观察列表。
 * 调用方决定取几条（LLM 上下文至多 5 条，快捷回答至多 1 条）。
 */
export function buildManagerObservations(
  state: AppState,
  itemViews: HouseholdChatItemView[],
  dateContext: ChatDateContext
): ManagerObservation[] {
  const observations: ManagerObservation[] = []
  observations.push(...buildBudgetObservations(state, dateContext))
  observations.push(...buildDueSoonObservations(itemViews))
  observations.push(...buildPriceAnomalyObservations(itemViews))
  observations.push(...buildCycleDriftObservations(itemViews))
  observations.push(...buildNegativeReviewRepurchaseObservations(itemViews))
  return sortObservations(observations, itemViews)
}

// ---------- budgetThreshold ----------

function buildBudgetObservations(state: AppState, dateContext: ChatDateContext): ManagerObservation[] {
  const budget = state.settings.monthlyBudget
  if (!budget || budget <= 0) return []
  const spend = calculateMonthlySpend(state.items, dateContext.now)
  const ratio = spend / budget
  if (ratio < BUDGET_INFO_THRESHOLD) return []
  const severity: ManagerObservation["severity"] = ratio >= BUDGET_ATTENTION_THRESHOLD ? "attention" : "info"
  const percent = Math.round(ratio * 100)
  const text = severity === "attention"
    ? `本月预算已经超了 ¥${formatPrice(Math.abs(spend - budget))}，接下来非急需的先别补。`
    : `本月补货花了 ¥${formatPrice(spend)}，是预算的 ${percent}%，后面非急需的先放放。`
  return [{ kind: "budgetThreshold", severity, text }]
}

// ---------- dueSoon ----------

function buildDueSoonObservations(itemViews: HouseholdChatItemView[]): ManagerObservation[] {
  const result: ManagerObservation[] = []
  for (const { item, computed } of itemViews) {
    if (computed.daysUntilDue > DUE_SOON_DAYS) continue
    const isOverdue = computed.daysUntilDue <= 0
    const severity: ManagerObservation["severity"] = isOverdue ? "attention" : "info"
    const text = isOverdue
      ? `${item.name}已经到提醒点了，${computed.remainingText}。`
      : `${item.name}大概 ${computed.daysUntilDue} 天后到提醒点，${computed.remainingText}。`
    result.push({ kind: "dueSoon", severity, itemId: item.id, text })
  }
  return result
}

// ---------- priceAnomaly ----------

export type PriceAnomalyResult = {
  ratio: number            // latestUnitPrice / avgUnitPrice（>1 偏贵，<1 偏便宜）
  latestUnitPrice: number
  avgUnitPrice: number
  direction: "expensive" | "cheap"
  pct: number              // 偏离百分比（正数）
}

/**
 * 单价偏离检测：最近一次补货单价 vs 历史均价（含本次）。
 * 与 householdChat.ts 中 answerHouseholdQuickly 的「价格异常」分支保持同口径：
 *   - 仅取 price>0 且 qty>0 的记录
 *   - 至少 2 条历史才计算
 *   - 偏离 > 10% 才返回结果
 * householdChat.ts 内的同类逻辑未来可改为复用此函数；本次任务不做重构。
 */
export function detectPriceAnomaly(item: ReplenishmentItem): PriceAnomalyResult | null {
  const priced = item.history.filter(
    (event) => Number.isFinite(event.price) && event.price! > 0 && Number.isFinite(event.qty) && event.qty! > 0
  )
  if (priced.length < 2) return null
  const latest = priced[priced.length - 1]
  const latestUnitPrice = latest.price! / latest.qty!
  const avgUnitPrice = priced.reduce((total, event) => total + event.price! / event.qty!, 0) / priced.length
  if (avgUnitPrice <= 0) return null
  const ratio = latestUnitPrice / avgUnitPrice
  if (ratio > 1 + PRICE_ANOMALY_RATIO) {
    return {
      ratio,
      latestUnitPrice,
      avgUnitPrice,
      direction: "expensive",
      pct: Math.round((ratio - 1) * 100)
    }
  }
  if (ratio < 1 - PRICE_ANOMALY_RATIO) {
    return {
      ratio,
      latestUnitPrice,
      avgUnitPrice,
      direction: "cheap",
      pct: Math.round((1 - ratio) * 100)
    }
  }
  return null
}

function buildPriceAnomalyObservations(itemViews: HouseholdChatItemView[]): ManagerObservation[] {
  const result: ManagerObservation[] = []
  for (const { item } of itemViews) {
    const anomaly = detectPriceAnomaly(item)
    if (!anomaly) continue
    const text = anomaly.direction === "expensive"
      ? `${item.name}这次单价 ¥${formatPrice(anomaly.latestUnitPrice)}，比均价 ¥${formatPrice(anomaly.avgUnitPrice)} 贵了 ${anomaly.pct}%。`
      : `${item.name}这次单价 ¥${formatPrice(anomaly.latestUnitPrice)}，比均价 ¥${formatPrice(anomaly.avgUnitPrice)} 便宜了 ${anomaly.pct}%。`
    result.push({ kind: "priceAnomaly", severity: "info", itemId: item.id, text })
  }
  return result
}

// ---------- cycleDrift ----------

/**
 * 周期漂移检测：最近连续 CYCLE_DRIFT_CONSECUTIVE 次实际补货间隔都比 cycleDays 短至少 CYCLE_DRIFT_RATIO。
 * 间隔取自 RestockEvent.intervalDays（补货时由 domain 计算并写入）。
 * 返回最短一次的偏离百分比，供文案使用。
 */
export function detectCycleDrift(item: ReplenishmentItem): { shortestDriftPct: number } | null {
  const cycleDays = item.cycleDays
  if (!cycleDays || cycleDays <= 0) return null
  const intervals = item.history
    .map((event) => event.intervalDays)
    .filter((value): value is number => Number.isFinite(value) && value! > 0)
  if (intervals.length < CYCLE_DRIFT_CONSECUTIVE) return null
  const recent = intervals.slice(-CYCLE_DRIFT_CONSECUTIVE)
  const threshold = cycleDays * (1 - CYCLE_DRIFT_RATIO)
  if (!recent.every((value) => value < threshold)) return null
  const shortest = Math.min(...recent)
  const shortestDriftPct = Math.round((1 - shortest / cycleDays) * 100)
  return { shortestDriftPct }
}

function buildCycleDriftObservations(itemViews: HouseholdChatItemView[]): ManagerObservation[] {
  const result: ManagerObservation[] = []
  for (const { item } of itemViews) {
    const drift = detectCycleDrift(item)
    if (!drift) continue
    const text = `${item.name}最近补得比设定的 ${item.cycleDays} 天周期快了不少（最短一次短了 ${drift.shortestDriftPct}%），消耗在加快，我帮你盯着点。`
    result.push({ kind: "cycleDrift", severity: "info", itemId: item.id, text })
  }
  return result
}

// ---------- negativeReviewRepurchase ----------

function buildNegativeReviewRepurchaseObservations(itemViews: HouseholdChatItemView[]): ManagerObservation[] {
  const result: ManagerObservation[] = []
  for (const { item, computed } of itemViews) {
    if (computed.displayStatus !== "urgent" && computed.displayStatus !== "warning") continue
    const latest = item.history[item.history.length - 1]
    if (!latest || !latest.review) continue
    const negativeHit = NEGATIVE_REVIEW_KEYWORDS.find((keyword) => latest.review!.includes(keyword))
    if (!negativeHit) continue
    const text = `${item.name}上次你记的是「${latest.review}」，这次又快到补货点了，要不要换个牌子试试？`
    result.push({ kind: "negativeReviewRepurchase", severity: "attention", itemId: item.id, text })
  }
  return result
}

// ---------- 排序 ----------

/**
 * 排序：attention 在前，同级按关联物品 dueAt 升序。
 * 无 itemId 的观察（如 budgetThreshold）在同级中排最后。
 */
function sortObservations(
  observations: ManagerObservation[],
  itemViews: HouseholdChatItemView[]
): ManagerObservation[] {
  const dueAtByItemId = new Map<string, number>()
  for (const { item, computed } of itemViews) {
    dueAtByItemId.set(item.id, computed.dueAt)
  }
  const dueAtFor = (obs: ManagerObservation): number => {
    if (obs.itemId && dueAtByItemId.has(obs.itemId)) return dueAtByItemId.get(obs.itemId)!
    return Number.POSITIVE_INFINITY
  }
  return [...observations].sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === "attention" ? -1 : 1
    }
    const dueA = dueAtFor(a)
    const dueB = dueAtFor(b)
    if (dueA !== dueB) return dueA - dueB
    // 同 severity 同 dueAt 时，按 kind 字母序稳定排列
    return a.kind.localeCompare(b.kind)
  })
}

// ---------- 家庭画像序列化（接入点 1 用） ----------

/**
 * 把家庭画像序列化进 LLM 上下文段落。
 * 画像为空时返回 null（调用方省略该段落）。
 * 标签复用 PROFILE_OPTIONS，避免与 householdProfile.ts 出现两套文案。
 */
export function serializeHouseholdProfile(profile: HouseholdProfile | null): string | null {
  if (!profile) return null
  const findLabel = <T>(options: { value: T; label: string }[], value: T): string =>
    options.find((option) => option.value === value)?.label ?? "未记录"
  const parts = [
    `常住人口：${findLabel(PROFILE_OPTIONS.residentCount, profile.residentCount)}`,
    `小孩：${findLabel(PROFILE_OPTIONS.children, profile.children)}`,
    `宠物：${findLabel(PROFILE_OPTIONS.pets, profile.pets)}`,
    `做饭频率：${findLabel(PROFILE_OPTIONS.cookingFrequency, profile.cookingFrequency)}`,
    `洗衣频率：${findLabel(PROFILE_OPTIONS.laundryFrequency, profile.laundryFrequency)}`,
    `住房：${findLabel(PROFILE_OPTIONS.homeSize, profile.homeSize)}`
  ]
  return `【家庭画像】\n${parts.join("；")}。`
}

// ---------- 快捷回答跨维度观察辅助（接入点 2 用） ----------

/**
 * 按偏好顺序取第一条命中的观察。供 answerHouseholdQuickly 在每类模板回答末尾追加。
 * preferences 由调用方给出，应排除当前问题同维度的 kind，避免重复。
 */
export function pickObservationByPreference(
  observations: ManagerObservation[],
  preferences: ManagerObservation["kind"][]
): ManagerObservation | null {
  for (const kind of preferences) {
    const found = observations.find((obs) => obs.kind === kind)
    if (found) return found
  }
  return null
}

// ---------- 开场简报（任务三） ----------

/**
 * 任务三：开场简报生成。
 * 触发条件：打开对话面板时，距上次会话结束超过 8 小时，或存在 attention 级观察。
 * 内容结构：问候（按时段早上/下午/晚上）+ 至多 3 条观察 + 一句收尾。
 * 不调 LLM，纯模板拼接。
 *
 * 任务四 A：新增 seenObservationKeys 参数，会话级去重。
 * 同一会话内已展示过的观察（按 kind+itemId 判等）不再出现在简报中。
 * 调用方传入 Set 引用，函数内部把新展示的观察 key 加进 Set。
 */
export function buildManagerBriefing(
  observations: ManagerObservation[],
  lastSessionAt: number | undefined,
  dateContext: ChatDateContext,
  seenObservationKeys?: Set<string>
): string | null {
  const now = dateContext.now
  // 任务四 A：先过滤已 seen 的观察，再判断 attention / 选 top 3
  const unseen = seenObservationKeys && seenObservationKeys.size > 0
    ? filterUnseenObservations(observations, seenObservationKeys)
    : observations
  const hasAttention = unseen.some((obs) => obs.severity === "attention")
  const hoursSinceLastSession = lastSessionAt ? (now - lastSessionAt) / (60 * 60 * 1000) : Infinity
  const shouldShow = hoursSinceLastSession > 8 || hasAttention
  if (!shouldShow) return null

  // 问候语：按时段
  const hour = new Date(now).getHours()
  const greeting = hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好"

  // 至多 3 条观察（已排序，attention 在前）
  const topObservations = unseen.slice(0, 3)
  if (seenObservationKeys) {
    for (const obs of topObservations) {
      seenObservationKeys.add(observationKey(obs))
    }
  }

  // 收尾
  const closing = "要处理的话跟我说一声就行"

  const parts = [greeting]
  if (topObservations.length > 0) {
    parts.push(topObservations.map((obs) => obs.text).join("；"))
  }
  parts.push(closing)

  return parts.join("，") + "。"
}

// ---------- 会话级观察去重（任务四 A） ----------

/**
 * 观察的唯一键：kind + itemId（预算类无 itemId 用空串）。
 * 同一 kind+itemId 的观察在一次会话内最多展示一次。
 */
export function observationKey(obs: ManagerObservation): string {
  return `${obs.kind}|${obs.itemId ?? ""}`
}

/**
 * 过滤掉已 seen 的观察。seenKeys 为空或未传时返回原数组。
 * 纯函数：不修改入参。
 */
export function filterUnseenObservations(
  observations: ManagerObservation[],
  seenKeys: Set<string> | undefined
): ManagerObservation[] {
  if (!seenKeys || seenKeys.size === 0) return observations
  return observations.filter((obs) => !seenKeys.has(observationKey(obs)))
}

/**
 * 把展示过的观察 key 累加进 seenKeys（引用传递，原地修改）。
 * 返回 seenKeys 本身，便于链式调用。
 */
export function markObservationsSeen(
  observations: ManagerObservation[],
  seenKeys: Set<string>
): Set<string> {
  for (const obs of observations) {
    seenKeys.add(observationKey(obs))
  }
  return seenKeys
}

// ---------- 写入后观察（任务四） ----------

/**
 * 任务四（写入后观察）：commit 成功后针对本次写入的物品运行三类判定。
 *
 * 复用内部 build*Observations 函数（priceAnomaly / cycleDrift / negativeReviewRepurchase），
 * 不重新实现判定规则，不改阈值。
 *
 * 接入会话级去重：已在本会话展示过的观察（按 kind+itemId 判等）不重复返回。
 *
 * 刚补完货时物品状态为 normal，negativeReviewRepurchase 需要 urgent/warning 才会命中，
 * 因此实际只会产出 priceAnomaly / cycleDrift。这是预期行为——刚补完货时
 * 「上次评价不好又要补货」的提醒不适用。
 *
 * 返回最重要的一条（attention 优先），命中后标记为 seen。无命中返回 null。
 */
export function buildPostCommitObservation(
  item: ReplenishmentItem,
  dateContext: ChatDateContext,
  seenObservationKeys?: Set<string>
): ManagerObservation | null {
  // 构造最小 view：刚补完货，displayStatus 为 normal
  // negativeReviewRepurchase 需要 urgent/warning 才命中，这里不会误触发
  const view: HouseholdChatItemView = {
    item,
    computed: {
      status: "normal",
      displayStatus: "normal",
      statusLabel: "充足",
      dueAt: dateContext.now + 30 * 24 * 60 * 60 * 1000,
      depletionAt: dateContext.now + 30 * 24 * 60 * 60 * 1000,
      daysUntilDue: 30,
      daysUntilDepletion: 30,
      isDue: false,
      isSnoozed: false,
      remainingText: "刚补完货",
      statusText: "充足"
    }
  }

  // 复用内部判定函数，不重新实现
  const observations: ManagerObservation[] = [
    ...buildPriceAnomalyObservations([view]),
    ...buildCycleDriftObservations([view]),
    ...buildNegativeReviewRepurchaseObservations([view])
  ]

  // 会话级去重
  const unseen = filterUnseenObservations(observations, seenObservationKeys)
  if (unseen.length === 0) return null

  // 取最重要的一条（attention 优先，同级按 dueAt 升序）
  const sorted = sortObservations(unseen, [view])
  const top = sorted[0]

  // 标记为 seen，防止同会话重复
  if (seenObservationKeys) {
    seenObservationKeys.add(observationKey(top))
  }

  return top
}
