/**
 * DraftCollection：补货记录采集态。
 *
 * 设计目标：
 *   1. 用户说「今天买了 5 袋猫砂」时，不立刻甩确认卡，而是先进入采集态：
 *      基于历史/常识主动整理出一条临时补货记录，用自然语言继续补齐字段。
 *   2. DraftCollection 是内部整理态，不直接写入 state，也不展示确认卡。
 *   3. 只有 completeness = readyToConfirm，或用户明确说「就这样 / 先保存 / 直接记下」，
 *      才转为 proposal，走原有的 confirm → commit 链路。
 *
 * 字段分级（与任务规范对齐）：
 *   required（缺失必须继续问）：itemName、qty、unit、restockDate
 *   quality（缺失允许最多追问 1-2 轮，可带「未补全」标记 proposal）：price、platform
 *   quality 非阻塞（追踪但不卡 readyToConfirm）：purchaseProductName、规格含量
 *   experience（不主动强问，自然表达时收入）：review
 *
 * 本模块是纯函数，可被测试直接覆盖。不调用 LLM，不修改 state。
 */

import { reviseAgentDraft, extractReviewText, type AgentDraft, type RestockDraftDetails } from "./drafts"
import type { AppState } from "../types"

export type DraftCompleteness =
  | "missingRequiredFields"
  | "missingQualityFields"
  | "readyToConfirm"

export type DraftCollection = {
  kind: "draftCollection"
  draft: AgentDraft
  requiredMissingSlots: string[]
  qualityMissingSlots: string[]
  inferredSuggestions: import("./recordInference").FieldSuggestion[]
  turns: number
  completeness: DraftCompleteness
  updatedAt: number
}

/** 用户明确要求直接保存的信号（跳过质量字段追问，直接转 proposal）。 */
const FORCE_PROPOSAL_PATTERNS = [
  /就这样/,
  /先保存/,
  /直接记下/,
  /不用问/,
  /不用再问/,
  /帮我保存/,
  /保存吧/,
  /就这么记/,
  /先这样/,
  /确认吧/,
  /可以了$/,
  /就这样记/,
  /先记上/
]

/** 用户取消当前 collection 的信号。 */
const CANCEL_COLLECTION_PATTERNS = [
  /算了/,
  /不记了/,
  /不要了/,
  /取消/,
  /作废/,
  /先不记/,
  /别记了/
]

export function isForceProposalSignal(text: string): boolean {
  const compact = text.trim().replace(/\s+/g, "")
  return FORCE_PROPOSAL_PATTERNS.some((pattern) => pattern.test(compact))
}

export function isCancelCollectionSignal(text: string): boolean {
  const compact = text.trim().replace(/\s+/g, "")
  // 「不记得也可以」之类的迁就话术不应触发取消
  if (/不记得|没关系|先空着/.test(compact)) return false
  return CANCEL_COLLECTION_PATTERNS.some((pattern) => pattern.test(compact))
}

/** 取出 restock 类草稿的可变字段引用（restock 或 createItemWithRestock.restock）。 */
function getRestockDetails(draft: AgentDraft): RestockDraftDetails | null {
  if (draft.kind === "restock") {
    const { kind: _k, itemId: _i, itemName: _n, ...rest } = draft
    void _k; void _i; void _n
    return rest
  }
  if (draft.kind === "createItemWithRestock") return draft.restock
  return null
}

/** 取出当前 collection 草稿对应的物品名（用于 review 提取时去除前缀）。 */
function getItemNameFromDraft(draft: AgentDraft): string | undefined {
  if (draft.kind === "restock") return draft.itemName
  if (draft.kind === "createItemWithRestock") return draft.item.itemName
  return undefined
}

/**
 * 在 collection 采集态场景下，应用用户补充输入到草稿。
 *
 * 与 reviseAgentDraft 的差异：评价字段使用 extractReviewText 保留用户原文，
 * 而非 parseReview 压缩成短评关键词。其他字段沿用 reviseAgentDraft 逻辑。
 */
function applyCollectionRevision(
  draft: AgentDraft,
  text: string,
  state: AppState
): AgentDraft | null {
  const revised = reviseAgentDraft(draft, text, state)
  if (!revised) return null

  // 评价字段：用 extractReviewText 覆盖，保留原文
  const itemName = getItemNameFromDraft(revised)
  const reviewText = extractReviewText(text, itemName)
  if (reviewText) {
    if (revised.kind === "restock") {
      return { ...revised, review: reviewText }
    }
    if (revised.kind === "createItemWithRestock") {
      return { ...revised, restock: { ...revised.restock, review: reviewText } }
    }
  }
  return revised
}

/** 判断 restock 类草稿是否涉及采集（只有补货类才进采集态）。 */
export function isCollectableDraft(draft: AgentDraft): boolean {
  return draft.kind === "restock" || draft.kind === "createItemWithRestock"
}

/**
 * 计算缺失字段。
 *   required: itemName / qty / unit / restockDate
 *   quality (阻塞 readyToConfirm): price / platform
 *   quality (非阻塞，仅记录): purchaseProductName / 规格
 */
export function computeMissingSlots(draft: AgentDraft): {
  requiredMissing: string[]
  qualityMissing: string[]
} {
  const details = getRestockDetails(draft)
  if (!details) return { requiredMissing: [], qualityMissing: [] }

  const requiredMissing: string[] = []
  const qualityMissing: string[] = []

  const itemName = draft.kind === "restock" ? draft.itemName : draft.kind === "createItemWithRestock" ? draft.item.itemName : ""
  if (!itemName || !itemName.trim()) requiredMissing.push("itemName")
  if (details.qty === undefined || details.qty === null || !(details.qty > 0)) requiredMissing.push("qty")
  if (!details.unit || !details.unit.trim()) requiredMissing.push("unit")
  if (details.restockDate === undefined || details.restockDate === null) requiredMissing.push("restockDate")

  // 阻塞型 quality
  if (details.price === undefined || details.price === null) qualityMissing.push("price")
  if (!details.platform || !details.platform.trim()) qualityMissing.push("platform")

  return { requiredMissing, qualityMissing }
}

/** 计算完整度等级。 */
export function computeCompleteness(draft: AgentDraft): DraftCompleteness {
  const { requiredMissing, qualityMissing } = computeMissingSlots(draft)
  if (requiredMissing.length > 0) return "missingRequiredFields"
  if (qualityMissing.length > 0) return "missingQualityFields"
  return "readyToConfirm"
}

/**
 * 构造一个 DraftCollection。
 * turns 从 1 起算（首轮产出即 1）。
 */
export function createDraftCollection(
  draft: AgentDraft,
  suggestions: import("./recordInference").FieldSuggestion[],
  now: number = Date.now()
): DraftCollection {
  const { requiredMissing, qualityMissing } = computeMissingSlots(draft)
  const completeness = computeCompleteness(draft)
  return {
    kind: "draftCollection",
    draft,
    requiredMissingSlots: requiredMissing,
    qualityMissingSlots: qualityMissing,
    inferredSuggestions: suggestions,
    turns: 1,
    completeness,
    updatedAt: now
  }
}

/**
 * 把用户补充输入应用到现有 collection 上。
 *
 * 返回：
 *   { status: "supplemented", collection } —— 字段被更新，collection 继续
 *   { status: "cancelled" }                 —— 用户取消
 *   { status: "noChange", collection }      —— 输入没命中任何字段（调用方决定是否交 LLM）
 *   { status: "forceProposal", draft }      —— 用户明确要求保存，返回可执行 draft
 */
export type ReviseCollectionResult =
  | { status: "supplemented"; collection: DraftCollection }
  | { status: "cancelled" }
  | { status: "noChange"; collection: DraftCollection }
  | { status: "forceProposal"; draft: AgentDraft }

export function reviseDraftCollection(
  collection: DraftCollection,
  text: string,
  state: AppState,
  now: number = Date.now()
): ReviseCollectionResult {
  // 1. 取消信号优先
  if (isCancelCollectionSignal(text)) return { status: "cancelled" }

  // 2. 强制保存信号：用 applyCollectionRevision 吸收本轮字段后，直接转 proposal
  if (isForceProposalSignal(text)) {
    const revised = applyCollectionRevision(collection.draft, text, state)
    const draft = revised || collection.draft
    return { status: "forceProposal", draft }
  }

  // 3. 尝试把输入当作字段补充应用到草稿
  //    使用 applyCollectionRevision：评价字段保留用户原文，而非压缩成短评关键词
  const revised = applyCollectionRevision(collection.draft, text, state)
  if (!revised) {
    // 输入没命中任何可识别字段
    return { status: "noChange", collection }
  }

  const { requiredMissing, qualityMissing } = computeMissingSlots(revised)
  const completeness = computeCompleteness(revised)
  const next: DraftCollection = {
    ...collection,
    draft: revised,
    requiredMissingSlots: requiredMissing,
    qualityMissingSlots: qualityMissing,
    completeness,
    turns: collection.turns + 1,
    updatedAt: now
  }
  return { status: "supplemented", collection: next }
}

/**
 * 判断一个新草稿是否应直接进采集态（而非立刻 proposal）。
 *
 * 规则：
 *   - 非 restock 类草稿（createItem / addPurchaseOption）不进采集态
 *   - 草稿已 readyToConfirm（required + price + platform 都齐）→ 不进采集态，直接 proposal
 *   - 用户明确 force-proposal → 不进采集态
 *   - 否则 → 进采集态
 */
export function shouldEnterCollection(draft: AgentDraft, userText: string): boolean {
  if (!isCollectableDraft(draft)) return false
  if (isForceProposalSignal(userText)) return false
  return computeCompleteness(draft) !== "readyToConfirm"
}

/**
 * 把 collection 转为可执行 draft（用于 proposal turn 的 executableDraft）。
 * 草稿本体不变，调用方拿到 draft 后走原 confirm → commit 链路。
 */
export function collectionToDraft(collection: DraftCollection): AgentDraft {
  return collection.draft
}

/** collection 是否带「未补全」标记（quality 字段仍缺失但用户要求保存时）。 */
export function hasMissingQuality(collection: DraftCollection): boolean {
  return collection.qualityMissingSlots.length > 0
}
