/**
 * 403：管理请求统一守卫。
 *
 * 用于在任何录入解析前拦截管理类请求（删除/编辑/预算/周期/提醒/常购商品管理/默认商品设置）。
 * 这些请求只能返回导航回答，不能生成 AgentPlan、AgentDraft、collection 或其他写入动作。
 *
 * 本模块是独立模块，不依赖 drafts.ts / turnInterpretation.ts，避免循环依赖。
 * 被 drafts.ts / planner.ts / householdOrchestrator.ts 共享使用。
 */

/** 压缩文本：移除空白和标点，便于关键词匹配。 */
function compact(value: string): string {
  return value.trim().replace(/[\s，。！？、,.!?]/g, "")
}

/** 删除请求关键词。 */
const DELETE_REQUEST_PATTERN = /删除|删掉|移除|清空|不再管理|不再管/

/** 预算管理关键词。 */
const BUDGET_KEYWORD_PATTERN = /预算设|预算改|预算调成|月预算|预算调/

/** 物品管理关键词：编辑类（重命名/移动/改单位/改周期/改提醒/设默认/提醒设置）。
 *
 * 注意：「改成」和「改为」不在此 pattern 中，因为它们也常用于当前草稿字段修订
 * （如「改成 3 袋」「金额改成 78」）。只有在前面有管理目标词时才算管理请求
 * （如「周期改成」「常购商品平台改成」），这些由其他更具体的 pattern 覆盖。
 *
 * 注意：「以后提醒」不在此 pattern 中，因为它常用于新建消耗品时的提醒备注
 * （如「帮我加一个洗发水，以后提醒」）。提醒管理由更具体的 pattern 覆盖
 * （提前.*天.*提醒 / 提醒.*改 / 提醒.*设）。
 */
const MANAGE_ITEM_KEYWORD_PATTERN =
  /帮我管|改名为|改叫|重命名|移到|归到|归入|放到|单位改|单位设|按包记|按瓶记|按袋记|快用完前|默认商品设|设为默认|设成默认|周期改|周期设|周期调成|补货周期|设为.*默认|设成.*默认|常购商品.*改|常购商品.*设|常购商品.*默认|默认常购|提前.*天.*提醒|提醒.*改|提醒.*设|提醒.*提前/

/**
 * 403：统一管理请求检测——用于在任何录入解析前拦截。
 * 覆盖删除、编辑、预算、周期、提醒、常购商品管理、默认商品设置等所有已关闭能力。
 * 此函数是「兜底守卫」，即使 interpretUserTurn 未正确分类，此处也能拦住。
 *
 * 检测范围：
 *   - 删除类：删除/删掉/移除/清空/不再管理/不再管
 *   - 编辑类：重命名/移动/改单位/改周期/改提醒/设默认/设为默认
 *   - 常购商品管理：常购商品 + 改/设/默认/删除
 *   - 预算类：预算设/预算改/月预算
 *   - 周期类：周期改/周期设/补货周期
 *   - 提醒类：提前 N 天提醒/提醒改/提醒设
 *
 * 注意：「改成 N 袋」「金额改成 78」「平台改成京东」等当前草稿字段修订不算管理请求，
 *   它们由 isCurrentEntryFieldRevision 判定，允许进入 pending 修订链路。
 *   只有带管理目标的「改成」才算管理请求（如「周期改成」「常购商品改成」）。
 */
export function isManagementRequest(text: string): boolean {
  const normalized = compact(text)
  // 删除类
  if (DELETE_REQUEST_PATTERN.test(normalized)) return true
  // 预算类
  if (BUDGET_KEYWORD_PATTERN.test(normalized)) return true
  // 周期类
  if (/周期改|周期设|周期调成|补货周期/.test(normalized)) return true
  // 提醒类（注意：「以后提醒」不在此处，因为它常用于新建消耗品时的提醒备注）
  if (/提前.*天.*提醒|提醒.*改|提醒.*设/.test(normalized)) return true
  // 常购商品管理类
  if (/常购商品/.test(normalized) && /改|设|默认|删除|删掉/.test(normalized)) return true
  // 设为/设成默认
  if (/设为.*默认|设成.*默认|默认商品设|设为默认|设成默认/.test(normalized)) return true
  // 历史记录编辑类：含历史时间引用 + 修改关键词 → 管理请求（不修订当前草稿）
  //   如「把上个月的猫粮价格改成268」「上次买的猫砂平台改成京东」
  if (/上个月|上次|之前|历史记录|历史/.test(normalized) && /改成|改为|删/.test(normalized)) return true
  // 分类/物品重命名类：「把X改成Y」且 X 不是字段名（数量/金额/价格/平台/日期/单位等）
  //   如「把宠物用品改成猫咪用品」「把猫砂改成豆腐猫砂」
  //   排除：含购买动词、含数量/价格信号、X 是字段名的当前草稿字段修订
  if (/把.{2,10}改成.{2,10}/.test(normalized) && !/买|花了|花费|补货/.test(normalized)) {
    const isFieldNameRevision = /把(?:数量|金额|价格|平台|日期|单位|商品名|名称).*(?:改成|改为)/.test(normalized)
    const hasQtySignal = /\d+\s*(?:包|瓶|袋|盒|支|卷|件|kg|斤|L|升)/.test(normalized)
    const hasPriceSignal = /\d+(?:\.\d+)?(?:\s*元|块钱|块)/.test(normalized)
    if (!isFieldNameRevision && !hasQtySignal && !hasPriceSignal) return true
  }
  // 编辑类（重命名/移动/改单位等，不含通用的「改成」）
  if (MANAGE_ITEM_KEYWORD_PATTERN.test(normalized)) return true
  return false
}
