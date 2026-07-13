/**
 * 对话边界分类：判定用户输入属于哪一类话题，供 orchestrator 决定走 LLM 还是直接回 sync answer。
 *
 * 设计目标：避免「非库存问题 → 统一机械拒绝」。
 * 403 管家不是通用百科助手，但也不是只会填表的机器人：
 *   - 核心管家事务：认真处理（writeDraft / 查询 / 订单 / 预算 / 提醒）
 *   - 家庭生活相邻问题：可以回答，尽量关联到家庭管理
 *   - 闲聊 / 身份 / 用户反馈：自然回应
 *   - 实时外部信息：不编造，给出边界说明
 *
 * 本模块是纯函数，初版规则即可，不追求完美。
 * classifyConversationBoundary 只负责分类，不生成文案——文案由 responseComposer.composeBoundaryAnswer 生成。
 */

export type ConversationBoundary =
  | "coreHousehold"     // 已有 writeDraft / 查询 / 订单等逻辑判断命中
  | "adjacentHomeLife"  // 洗衣/做饭/收纳/清洁/宠物/囤货等家庭生活相邻问题
  | "identityOrMeta"    // 你是谁 / 你能做什么 / 你刚才为什么 / 你是不是 AI
  | "casual"            // 哈哈 / 好的 / 没事 / 随便聊聊 等短闲聊
  | "realtimeExternal"  // 天气 / 新闻 / 股票 / 汇率 / 限行 等需实时外部数据
  | "unsupported"       // 其他无法归类

/** 判定时统一转小写、去空格，便于关键词匹配 */
function normalize(text: string): string {
  return text.trim().toLocaleLowerCase("zh-CN")
}

/** 短闲聊/寒暄/吐槽判定：长度 ≤ 8 且命中关键词 */
const CASUAL_KEYWORDS = ["哈哈", "好的", "好吧", "行吧", "你真笨", "没事", "随便聊聊", "随便", "嗯嗯", "哦哦", "算了", "谢谢", "辛苦", "晚安", "早安", "早上好", "晚上好", "午安", "你好", " hi"]

/** 身份/元对话关键词 */
const IDENTITY_KEYWORDS = [
  "你是谁", "你是干嘛", "你能做什么", "你会做什么", "你管什么",
  "你应该回答", "你刚才为什么", "你怎么不会", "你是不是ai", "你是不是人工智能",
  "你叫什么", "你叫啥", "你是机器人", "你是模型", "你是什么模型",
  "你怎么不", "你为什么", "你怎么回答", "你刚才"
]

/** 实时外部信息关键词 */
const REALTIME_KEYWORDS = [
  "天气", "温度多少", "今天温度", "明天温度", "气温",
  "限行", "尾号", "新闻", "股票", "基金", "汇率", "金价", "油价",
  "快递到哪", "快递到哪了", "外卖", "外卖到哪",
  "实时", "今天行情", "明天行情"
]

/** 家庭生活相邻关键词 */
const ADJACENT_KEYWORDS = [
  "洗衣", "洗衣服", "晾衣服", "晾晒",
  "做饭", "煮饭", "炒菜", "菜谱", "食谱",
  "收纳", "整理", "归纳",
  "清洁", "打扫", "卫生", "拖地", "扫地",
  "猫", "狗", "宠物", "猫咪", "狗狗",
  "囤货", "买什么", "怎么选", "选哪个", "推荐买",
  "家里", "厨房", "卫生间", "阳台", "客厅",
  "除味", "除湿", "防潮", "防虫",
  "垃圾袋", "保鲜", "冷冻", "冷藏"
]

/**
 * 判定用户输入的对话边界类型。
 * 优先级：identityOrMeta > realtimeExternal > adjacentHomeLife > casual > unsupported。
 * coreHousehold 不在本函数判定——由 orchestrator 先走 intent/draft/查询逻辑，命中后才标记 coreHousehold。
 *
 * 注意：短闲聊判定需在身份判定之后，避免「你是谁啊」被识别为 casual。
 */
export function classifyConversationBoundary(text: string): ConversationBoundary {
  const normalized = normalize(text)
  if (!normalized) return "unsupported"

  // 1. identityOrMeta：身份/元对话/用户反馈
  if (IDENTITY_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "identityOrMeta"
  }

  // 2. realtimeExternal：实时外部信息
  if (REALTIME_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "realtimeExternal"
  }

  // 3. adjacentHomeLife：家庭生活相邻
  if (ADJACENT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "adjacentHomeLife"
  }

  // 4. casual：短闲聊（长度限制 + 关键词）
  // 长度 ≤ 8 容纳「哈哈好的没事」这类组合；超过 8 字符即使含「哈哈」也认为是正经话
  if (normalized.length <= 8 && CASUAL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "casual"
  }

  return "unsupported"
}
