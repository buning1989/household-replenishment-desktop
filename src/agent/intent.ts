/**
 * 本地意图识别：在调用模型之前，先把用户的一句话归类成
 * confirmDraft / cancelDraft / pendingStatus / reviseDraft / writeDraft / query。
 *
 * 识别只看关键词，不依赖模型；模型只在 writeDraft 解析失败或 query 时介入。
 * 规则按表驱动，便于在测试里逐条覆盖。
 */
export type AgentLocalIntent = "confirmDraft" | "cancelDraft" | "pendingStatus" | "reviseDraft" | "writeDraft" | "query"

/**
 * 把一句话压成只含中文/字母数字的紧凑串，便于做关键词包含匹配。
 * 注意：这里不剥离「不」「别」等否定字，否定意图由词表本身区分。
 */
function compact(value: string): string {
  return value.trim().replace(/[\s，。！？、,.!?]/g, "")
}

/**
 * 意图规则表。每条规则：
 *   - needsPending：是否要求当前已有 pending 草稿才命中
 *   - matches：命中函数
 *   - intent：命中的意图
 *
 * 顺序很重要：先判 cancel/confirm/pendingStatus（短促应答），再判 revise（修订信号），
 * 最后判 writeDraft（写入意图）。query 是兜底。
 */
type IntentRule = {
  needsPending: boolean
  matches: (text: string, raw: string) => boolean
  intent: Exclude<AgentLocalIntent, "query">
}

// 确认草稿：用户对当前 pending 草稿表达「就这样定下来」。
// 注意：单字「好」太容易误命中（如「不好用」），故只保留「好的」「好吧」。
//
// 任务二：把确认词拆成两类，避免「可以帮我看下预算吗」这类含泛化词的长句被误判为确认。
//   - 明确动词（确认/保存/执行/可以了…）：不受长度限制，整句任意位置命中即算确认。
//   - 泛化应答（可以/对的/好的/好吧/ok…）：仅当整句去标点后长度 ≤ CONFIRM_CASUAL_MAX_LENGTH 才算确认。
const CONFIRM_EXPLICIT_PHRASES = [
  "确认吧", "确认创建", "确认记录", "确认补货", "确认补货单", "确认这条", "确认",
  "可以了", "就按这个", "没问题", "保存", "记上", "执行", "执行吧",
  "可以创建", "可以记录", "就这样", "按这个来"
]
const CONFIRM_CASUAL_PHRASES = ["可以", "对的", "好的", "好吧", "ok", "OK"]
const CONFIRM_CASUAL_MAX_LENGTH = 6

// 取消草稿：用户想撤回当前 pending 草稿。
// 注意「不要保存」「别记」这类否定要整词命中，避免误伤「不要保存吗」之类的询问。
const CANCEL_PHRASES = [
  "算了", "撤销", "别记", "不要保存", "取消这条", "取消", "不要了", "不用了",
  "先不", "暂不", "放弃", "别记了", "不要记", "先别记"
]

// 询问 pending 状态：用户想知道刚才那条是否已经写进去。
const PENDING_STATUS_PHRASES = [
  "记了吗", "保存了吗", "创建了吗", "刚才那条写进去了吗", "写进去了吗", "写进去了没",
  "创建了么", "创建了吗", "创建了没", "记录了吗", "记录了么", "记录了没",
  "补货单创建了吗", "创建补货单了么", "改了么", "改了吗", "成功了吗",
  "创建成功了吗", "已经创建了吗", "有创建吗", "有没有创建", "保存了么", "保存了没"
]

// 写入意图：用户想记一笔 / 建档 / 加常购商品 / 建分类 / 设预算 / 改周期。
const WRITE_SIGNALS = [
  "买了", "买的", "下单", "购入", "入手", "囤了", "续上", "补了", "补货了", "收货了", "快递到了",
  "记一笔", "记录一下", "帮我管", "以后提醒", "加入清单", "添加", "新建", "创建",
  "录入", "登记", "帮我加", "加一个", "加个", "补货单", "补货记录",
  // AgentPlan 新能力：建分类、设预算、改周期、第二期编辑类（重命名/移动/改单位/改提醒/改常购商品/设默认）
  // 注意：用「预算设/预算改」而非「月预算」，避免「本月预算怎么样」被误判为写入
  "预算设", "预算改", "预算调成", "周期改", "周期设", "周期调成",
  // 第二期编辑类：重命名、移动、改单位、改提醒、常购商品改、设默认
  "改成", "改为", "改名为", "改叫", "重命名", "移到", "归到", "归入", "放到",
  "单位改", "单位设", "按包记", "按瓶记", "按袋记", "提前", "快用完前",
  "默认商品设", "设为默认", "设成默认",
  // 第三期删除类：删除、删掉、不再管理
  "删除", "删掉", "不再管理", "不再管"
]

// 二次确认删除：高风险 plan 第一次确认后，用户必须再次明确说「确认删除」类句式才能执行。
// 普通「确认」「好的」「可以」不能执行高风险删除。
const SECOND_CONFIRM_PHRASES = [
  "确认删除", "确定删除", "我确认删除", "我确定删除",
  "确认删掉", "确定删掉", "我确认删掉",
  "删除吧", "删掉吧", "就删除", "就删掉"
]

/**
 * 判断用户输入是否为「二次确认删除」。
 * 仅在 pendingPlan.status === "awaitingSecondConfirm" 时由 orchestrator 调用。
 * 普通「确认」「好的」「可以」不会命中。
 */
export function isSecondConfirmMatch(text: string): boolean {
  const normalized = compact(text)
  if (!normalized) return false
  return includesAny(normalized, SECOND_CONFIRM_PHRASES)
}

// 修订信号：用户想改当前 pending 草稿的某个字段。
const REVISE_KEYWORDS = [
  // 显式修订词
  "不是", "改成", "换成", "修正", "更正", "价格错了", "数量错了", "平台错了",
  "商品名叫", "买的是", "归到", "放到", "分类改成", "分类改为",
  // 字段名
  "周期", "补货周期", "平台", "商家", "数量", "价格", "金额", "评价", "日期",
  // 平台名
  "京东", "淘宝", "天猫", "拼多多", "抖音", "1688", "盒马", "山姆", "美团", "超市", "线下",
  // 单位
  "包", "瓶", "袋", "盒", "支", "卷", "件",
  // 相对日期
  "昨天", "前天", "上周", "今天",
  // 金额字
  "花了", "块", "元"
]

// 评价关键词：既触发 revise，也写入 review 字段（在 drafts.ts 里解析）。
// 任务一观察引擎的 negativeReviewRepurchase 判定复用此列表的负面子集。
export const REVIEW_KEYWORDS = ["好用", "不好用", "味道大", "猫不爱吃", "质量一般", "下次不买", "下次别买", "回购", "不回购"]

// 任务二：revise 劫持修复参数。
// 命中 REVISE_KEYWORDS 时，若整句去标点后长度 > REVISE_MAX_LENGTH，或含疑问信号，
// 不走本地修订，透传给 LLM（LLM 系统提示里已有 pendingDraft 上下文，能自行判断是修订还是闲聊）。
const REVISE_MAX_LENGTH = 15
const REVISE_INTERROGATIVE_PATTERN = /[吗？?]|怎么|什么|多少/

// 任务四 B4：纯数字（如「45」「45.5」）在 pending 草稿上下文中视为价格补充，命中修订。
// 兼容全角数字。此规则在长度/疑问防护之后，不会与任务二的防护冲突。
const PURE_NUMBER_PATTERN = /^[0-9０-９]+(?:\.[0-9０-９]+)?$/

function includesAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase))
}

/**
 * 任务二补丁：共享的确认匹配逻辑，供单草稿 RULES 和 classifyBatchIntent 共用。
 * 规则：
 *   1. 含疑问信号（吗/？/怎么/什么/多少）时不判为确认（如"这样记没问题吗？"）
 *   2. 明确动词不受长度限制
 *   3. 泛化应答仅当整句去标点后 ≤ CONFIRM_CASUAL_MAX_LENGTH 才命中
 */
function isConfirmMatch(text: string, raw: string): boolean {
  if (REVISE_INTERROGATIVE_PATTERN.test(raw)) return false
  if (includesAny(text, CONFIRM_EXPLICIT_PHRASES)) return true
  if (text.length <= CONFIRM_CASUAL_MAX_LENGTH && includesAny(text, CONFIRM_CASUAL_PHRASES)) return true
  return false
}

/**
 * 任务二补丁：批量场景的确认匹配逻辑，比单草稿更严格。
 * 批量场景下泛化词（可以/好的/对的）不触发 batchConfirm，只有明确动词才触发。
 * 避免"可以帮我看下预算吗"误触发批量确认。
 */
function isBatchConfirmMatch(text: string, raw: string): boolean {
  if (REVISE_INTERROGATIVE_PATTERN.test(raw)) return false
  return includesAny(text, CONFIRM_EXPLICIT_PHRASES)
}

const RULES: IntentRule[] = [
  // CANCEL 必须在 CONFIRM 之前：避免「不要保存」被「保存」误命中
  {
    needsPending: true,
    matches: (text) => includesAny(text, CANCEL_PHRASES),
    intent: "cancelDraft"
  },
  // PENDING_STATUS 必须在 CONFIRM 之前：避免「保存了吗」被「保存」误命中
  {
    needsPending: true,
    matches: (text) => includesAny(text, PENDING_STATUS_PHRASES),
    intent: "pendingStatus"
  },
  {
    needsPending: true,
    matches: (text, raw) => isConfirmMatch(text, raw),
    intent: "confirmDraft"
  },
  {
    needsPending: true,
    // 任务二：含疑问信号或整句过长时不走本地修订，透传给 LLM。
    // 任务四 B4：纯数字（如「45」）在 pending 草稿上下文中视为价格补充，命中修订。
    matches: (text, raw) => {
      if (REVISE_INTERROGATIVE_PATTERN.test(raw)) return false
      if (text.length > REVISE_MAX_LENGTH) return false
      return includesAny(text, REVISE_KEYWORDS) || includesAny(text, REVIEW_KEYWORDS) || PURE_NUMBER_PATTERN.test(text) || /[0-9０-９]+号|[0-9０-９]+月[0-9０-９]+日|20\d{2}-\d{1,2}-\d{1,2}/.test(raw)
    },
    intent: "reviseDraft"
  },
  {
    needsPending: false,
    matches: (text) => includesAny(text, WRITE_SIGNALS),
    intent: "writeDraft"
  }
]

export function classifyAgentIntent(text: string, hasPendingDraft: boolean): AgentLocalIntent {
  const normalized = compact(text)
  if (!normalized) return "query"
  for (const rule of RULES) {
    if (rule.needsPending && !hasPendingDraft) continue
    if (rule.matches(normalized, text)) return rule.intent
  }
  return "query"
}

/**
 * 写入意图会让本地 parser 先尝试出草稿；只有它返回 true 时才跳过只读快捷回答。
 */
export function shouldSkipQuickAnswerForAgent(text: string): boolean {
  return classifyAgentIntent(text, false) === "writeDraft"
}

// ---------- 批量草稿意图（订单截图导入后的对话修正） ----------

/**
 * 批量草稿场景下的本地意图。
 * - batchConfirm：确认全部待确认草稿
 * - batchCancel：取消全部
 * - batchCancelIndex：取消第 N 条（1-based）
 * - batchReviseIndex：修订第 N 条
 * - batchReviseAll：对所有待确认草稿应用同一修订（如「价格改成 59.9」无明确序号时）
 * - null：不是批量意图，交给单草稿流程或模型
 */
export type BatchLocalIntent =
  | { intent: "batchConfirm" }
  | { intent: "batchCancel" }
  | { intent: "batchCancelIndex"; index: number }
  | { intent: "batchReviseIndex"; index: number }
  | { intent: "batchReviseAll" }

const ORDINAL_MAP: Record<string, number> = {
  "第一": 1, "第二": 2, "第三": 3, "第四": 4, "第五": 5, "第六": 6, "第七": 7, "第八": 8, "第九": 9, "第十": 10,
  "第1": 1, "第2": 2, "第3": 3, "第4": 4, "第5": 5, "第6": 6, "第7": 7, "第8": 8, "第9": 9, "第10": 10
}

const BATCH_CONFIRM_PHRASES = ["全部确认", "确认全部", "批量确认", "都确认", "都记上", "全部保存", "全部执行", "确认所有", "都保存"]
const BATCH_CANCEL_PHRASES = ["全部取消", "取消全部", "都不要了", "全部跳过", "都跳过", "全部算了", "批量取消"]
const BATCH_CANCEL_INDEX_VERBS = ["跳过", "取消", "不要", "算了", "别记", "去掉", "剔除"]

/**
 * 解析「第N个」「第N条」「第N项」「第N行」。返回 1-based 序号；解析不到返回 undefined。
 */
function parseOrdinal(text: string): number | undefined {
  for (const key of Object.keys(ORDINAL_MAP)) {
    if (text.includes(key)) {
      // 兼容「第N个/条/项/行/条记录」
      const rest = text.slice(text.indexOf(key) + key.length)
      if (/^(?:个|条|项|行|条记录|项记录)?/.test(rest)) return ORDINAL_MAP[key]
    }
  }
  return undefined
}

/**
 * 在存在待确认批量草稿时，把用户的一句话归类为批量意图。
 * 优先级：batchConfirm > batchCancel(全部) > batchCancelIndex > batchReviseIndex > batchReviseAll。
 *
 * 注意：单条确认词（如「确认吧」）在批量场景下也当作 batchConfirm，
 * 由调用方决定是确认全部还是仅确认最后一条。
 */
export function classifyBatchIntent(text: string): BatchLocalIntent | null {
  const normalized = compact(text)
  if (!normalized) return null

  if (includesAny(normalized, BATCH_CONFIRM_PHRASES)) return { intent: "batchConfirm" }
  // 任务二补丁：单条确认词在批量场景下也视作确认全部，但需通过 isBatchConfirmMatch 检查（疑问信号防护 + 仅明确动词）
  if (isBatchConfirmMatch(normalized, text)) return { intent: "batchConfirm" }

  if (includesAny(normalized, BATCH_CANCEL_PHRASES)) return { intent: "batchCancel" }

  const ordinal = parseOrdinal(normalized)
  if (ordinal !== undefined) {
    // 「第N个跳过/取消/不要」
    if (includesAny(normalized, BATCH_CANCEL_INDEX_VERBS)) {
      return { intent: "batchCancelIndex", index: ordinal - 1 }
    }
    // 「第N个XXX」且包含修订信号 → 修订第N条
    if (includesAny(normalized, REVISE_KEYWORDS) || includesAny(normalized, REVIEW_KEYWORDS)) {
      return { intent: "batchReviseIndex", index: ordinal - 1 }
    }
    // 「第N个」单独出现，且后续无明确动作 → 默认按修订处理（让上层用整句去 revise）
    return { intent: "batchReviseIndex", index: ordinal - 1 }
  }

  // 无序号但有修订信号 → 应用到全部待确认草稿（如「价格都改成59.9」「日期改成昨天」）
  // 这里只在明确含「都」「全部」+ 修订信号时才返回 batchReviseAll，避免误吞单草稿修订
  if ((normalized.includes("都") || normalized.includes("全部")) &&
      (includesAny(normalized, REVISE_KEYWORDS) || includesAny(normalized, REVIEW_KEYWORDS))) {
    return { intent: "batchReviseAll" }
  }

  return null
}
