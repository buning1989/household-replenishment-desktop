/**
 * ResponseComposer：家庭管家对话文案的唯一来源。
 *
 * 设计原则：
 *   1. 所有给用户看的文案只能从这里产出，不允许分散在 App.tsx / householdChat.ts / drafts.ts
 *   2. 文案保持管家口吻：口语、熟悉、克制，不像系统表单
 *   3. 价格、平台、评价、商品名等非必要字段不作为「缺失字段」暴露
 *   4. 不暴露内部推理过程（不出现「我理解为」「根据模板」「待确认草稿」等）
 *   5. 模型不能声称已创建/已记录/已更新；写入完成态只由 composer 在 committed 时生成
 */

import { describeAgentDraft, type AgentDraft, type OrderRow } from "./drafts"
import type { ChatMessageLink } from "../llm/householdChat"
import type { OrderImportRow } from "../OrderImportReview"
import type { ConversationBoundary } from "./conversationBoundary"

/**
 * 草稿卡片的状态标签文案。
 * 统一用第一人称管家陈述句式，不出现「准备加入并记账」等系统化短语。
 */
export function composeDraftStatusLabel(
  status: "pending" | "confirmed" | "cancelled" | "superseded",
  draft: AgentDraft
): string {
  if (status === "confirmed") return "已写入"
  if (status === "cancelled") return "已取消"
  if (status === "superseded") return "已更新为新草稿"
  // pending
  if (draft.kind === "createItem") return "我准备这么加"
  if (draft.kind === "restock") return "我准备这么记"
  if (draft.kind === "createItemWithRestock") return "我准备这么记"
  return "我准备这么挂"
}

/**
 * 物品匹配疑似时的提示文案。
 * 改写为管家陈述句式，不出现「疑似匹配」「模板」「库里」等实现词汇。
 * matchHint 来自 drafts.ts，已是管家口吻（如「『纸』可能指：xxx，请确认是哪一个。」），
 * 这里直接透传，由调用方去掉系统化标签。
 */
export function composeMatchHintText(matchHint: string): string {
  return matchHint
}

/**
 * 判断商品名是否与物品名冗余（相同或仅包含关系），用于摘要行去重。
 * 当商品名等于物品名、或商品名仅是物品名加品牌前缀且无实质区分时，视为冗余。
 */
export function isProductNameRedundant(itemName: string, productName: string | undefined): boolean {
  if (!productName) return false
  const norm = (s: string) => s.trim().toLocaleLowerCase("zh-CN")
  const name = norm(itemName)
  const product = norm(productName)
  if (!product) return false
  // 完全相同 → 冗余
  if (name === product) return true
  // 商品名仅是物品名前后加修饰但无实质区分（如「猫砂」「某猫砂」「猫砂一袋」）→ 冗余
  // 仅当商品名长度与物品名差距 ≤ 3 字符时判定
  if (Math.abs(product.length - name.length) <= 3) {
    if (product.includes(name) || name.includes(product)) return true
  }
  return false
}

/**
 * 简报观察拼接：按物品分组合并 + 去除子句末句号防连续标点。
 *
 * - 同一物品（itemId 相同）的多条观察用逗号合并为单句
 * - 无 itemId 的观察（如预算类）各自独立成句
 * - 拼接前去除每条 text 末尾的句号（保留问号，问号是语义的一部分）
 * - 句子之间用分号连接
 */
export function composeGroupedObservationText(
  observations: Array<{ text: string; itemId?: string }>
): string {
  if (observations.length === 0) return ""
  // 按 itemId 分组（undefined/null 归为各自独立的组，不合并）
  const groups: Array<Array<{ text: string; itemId?: string }>> = []
  const groupIndexByItemId = new Map<string | null, number>()
  for (const obs of observations) {
    const key = obs.itemId ?? null
    if (key === null) {
      // 无 itemId 的观察不参与合并，独立成组
      groups.push([obs])
    } else if (groupIndexByItemId.has(key)) {
      groups[groupIndexByItemId.get(key)!].push(obs)
    } else {
      groupIndexByItemId.set(key, groups.length)
      groups.push([obs])
    }
  }
  // 每组合并为一句：去除子句末句号，用逗号连接
  const sentences = groups.map((group) =>
    group.map((obs) => obs.text.replace(/。$/, "")).join("，")
  )
  return sentences.join("；")
}

/** 禁用词：composer 输出的任何文案都不应包含这些词 */
export const FORBIDDEN_PHRASES = [
  "我理解为", "我猜", "我估算", "根据模板", "根据常识",
  "待确认草稿", "确认创建", "确认记录",
  "分类：", "单位：",
  "bufferDays", "cycleDays"
] as const

/** 检查文案是否包含禁用词；命中则返回该词，否则返回 null。供测试使用。 */
export function findForbiddenPhrase(text: string): string | null {
  for (const phrase of FORBIDDEN_PHRASES) {
    if (text.includes(phrase)) return phrase
  }
  return null
}

/**
 * 生成 proposal 的口语化处理方案文案。
 * 不暴露 AgentDraft 的字段表，只说「我先把 X 加进来 / 我先按这次补货记上」。
 *
 * 注意：本函数只生成基础话术，不含缺失字段追问。
 * 缺失字段追问由 composeMissingFieldPrompt 单独生成，在 draftToProposal 中追加，
 * 保证只在草稿首次产出时追问一次，revise/confirm 路径不重复追问。
 */
export function composeProposalMessage(draft: AgentDraft): string {
  if (draft.kind === "createItem") {
    return `我先把「${draft.itemName}」加进来，按 ${draft.cycleDays} 天一轮帮你盯着。你要是没问题，我就先这么记下。`
  }
  if (draft.kind === "restock") {
    return `「${draft.itemName}」我先按这次补货记上，价格和平台没说也不影响。你要是没问题，我就这么保存。`
  }
  if (draft.kind === "createItemWithRestock") {
    const qty = draft.restock.qty
    const unit = draft.restock.unit || draft.item.unit || "件"
    const qtyText = qty ? `${qty}${unit}` : "这一笔"
    return `我先把「${draft.item.itemName}」加进来，这次 ${qtyText} 也一起算作起始记录。你要是没问题，我就先这么记下。`
  }
  // addPurchaseOption
  return `我先把「${draft.productName}」放到「${draft.itemName}」下面，之后你补货就能直接沿用。没问题我就保存。`
}

/**
 * 任务四 B3：草稿产出时检测金额/平台缺失，返回对话式追问文案。
 * 仅在 restock / createItemWithRestock 草稿首次产出时调用。
 * 不在 revise / confirm / committed 路径调用，避免追问第二次。
 *
 * 返回 null 表示无需追问（字段齐全或草稿类型不涉及金额/平台）。
 */
export function composeMissingFieldPrompt(draft: AgentDraft): string | null {
  if (draft.kind === "restock") {
    const missingPrice = draft.price === undefined || draft.price === null
    const missingPlatform = !draft.platform
    return buildMissingFieldPrompt(missingPrice, missingPlatform)
  }
  if (draft.kind === "createItemWithRestock") {
    const missingPrice = draft.restock.price === undefined || draft.restock.price === null
    const missingPlatform = !draft.restock.platform
    return buildMissingFieldPrompt(missingPrice, missingPlatform)
  }
  // createItem / addPurchaseOption 不涉及金额/平台，不追问
  return null
}

function buildMissingFieldPrompt(missingPrice: boolean, missingPlatform: boolean): string | null {
  if (!missingPrice && !missingPlatform) return null
  if (missingPrice && missingPlatform) {
    return "多少钱、在哪家买的？顺口说一声我一起记上，不说也行。"
  }
  if (missingPrice) {
    return "多少钱买的？顺口说一声我一起记上，不说也行。"
  }
  return "在哪家买的？说了我顺手记上，不说也行。"
}

/**
 * 生成 clarification 的口语化追问文案。
 * 调用方传入追问场景和参数，composer 拼出符合管家口吻的句子。
 */
export function composeClarificationMessage(
  scenario: "duplicate-create" | "ambiguous-item" | "missing-target",
  params: { itemName?: string; candidates?: string[] }
): string {
  if (scenario === "duplicate-create") {
    return `${params.itemName}已经在管了。你这次是要记一笔补货，还是想改一下提醒节奏？`
  }
  if (scenario === "ambiguous-item") {
    const list = params.candidates?.join("、") || ""
    return `你说的是${list}哪一个？我怕记错，先跟你确认一下。`
  }
  // missing-target：用户说要记/补，但没说是什么物品
  return "你这次要记的是哪个？跟我说一下物品名，我就能先按家里的习惯给你记上。"
}

/**
 * 生成 cancelled 文案。
 * 不说「已取消草稿」，说「先不记了」之类管家口吻。
 */
export function composeCancelledMessage(): string {
  return "行，这条我先不记。下次你说了我再来。"
}

/**
 * 生成 committed 文案。
 * 注意：只有这里能出现「已记下 / 已加进来」这类完成态。
 */
export function composeCommittedMessage(
  draft: AgentDraft,
  summary: string,
  links: ChatMessageLink[]
): string {
  // 主文案用 summary（executor 生成的写入结果摘要，如「已记下「猫砂」本次补货」）
  // 不再拼「已创建」「已记录」等动词，由 summary 决定
  const linkHint = links.length
    ? `要看的话点这里：${links.map((link) => link.label).join("、")}。`
    : ""
  return [summary, linkHint].filter(Boolean).join(" ")
}

/**
 * 生成 pending reminder 文案：用户问「记了吗」时回答还没真正写入。
 */
export function composePendingReminder(draft: AgentDraft): string {
  return [
    "还没真正写入，需要你确认一下。",
    `当前准备处理：${describeAgentDraft(draft)}。`,
    "你可以点卡片里的「就这么记」，或直接输入「确认吧」。"
  ].join("\n")
}

/**
 * 生成修订后的提示文案。
 * 不说「已更新草稿」，说「我按你说的改了一下」。
 */
export function composeRevisedMessage(): string {
  return "好的，我按你说的改了一下。要是不对再告诉我。"
}

/**
 * 生成 batch（订单导入）的引导文案。
 */
export function composeBatchIntro(count: number): string {
  return `已从订单截图生成 ${count} 条待确认草稿。可以在下面逐条修正，或输入「全部确认」一次性写入。`
}

/**
 * 生成 batch 修订后的提示文案。
 */
export function composeBatchRevisedMessage(scope: "single" | "all"): string {
  if (scope === "single") return "这一条我按你说的改了一下。"
  return "全部待确认草稿都按你说的改了。"
}

/**
 * 生成 LLM fallback 失败时的兜底文案。
 * 注意：no-answer 仅作为极少数真正异常兜底；非管家问题应优先使用 composeBoundaryAnswer。
 */
export function composeFallbackMessage(scenario: "no-draft" | "no-answer"): string {
  if (scenario === "no-draft") return "我没能整理成可确认草稿，你换一句描述试试。"
  return "我没能整理出可靠回答，你换一句问法试试。"
}

/**
 * 根据对话边界类型生成自然、有边界的回应。
 * 用于 orchestrator 同步处理 identity/realtime/casual，以及 LLM 解析失败时按边界兜底。
 *
 * 设计原则：
 *   - 不编造实时外部信息
 *   - 身份/元对话直接回答，不让用户换问法
 *   - 家庭生活相邻问题给简短建议，并自然带回家务/补货能力
 *   - 闲聊自然接住，引导用户回到核心事务
 *   - unsupported 仍给边界说明，但提示可以转成采购/提醒/记录
 */
export function composeBoundaryAnswer(boundary: ConversationBoundary, text: string): string {
  const normalized = text.trim().toLocaleLowerCase("zh-CN")

  if (boundary === "identityOrMeta") {
    // 用户在纠正管家「你应该回答你是谁」
    if (normalized.includes("你应该回答") || normalized.includes("你应该") || normalized.includes("你怎么不")) {
      return "对，这类我应该直接答，不该让你换问法。我是 403 管家，负责帮你管家里的消耗品和补货。"
    }
    return "我是 403 管家，主要帮你盯家里的消耗品。你随口说买了什么、快没什么，我就帮你记好。"
  }

  if (boundary === "realtimeExternal") {
    // 天气类
    if (normalized.includes("天气") || normalized.includes("温度") || normalized.includes("气温")) {
      return "我这边看不了实时天气，别瞎报。你要是为了安排采购或洗衣，我可以帮你看看家里现在有什么要顺手补。"
    }
    // 其他实时外部信息（新闻/股票/汇率/限行/快递/外卖）
    return "这个需要实时信息，我这边不能保证准。家里补货、库存和订单记录我可以直接帮你处理。"
  }

  if (boundary === "adjacentHomeLife") {
    // 宠物相关：可以提示帮记常购商品
    if (normalized.includes("猫") || normalized.includes("狗") || normalized.includes("宠物")) {
      // 用户在问选哪种商品（如「猫砂买哪种好」）
      if (normalized.includes("买哪种") || normalized.includes("怎么选") || normalized.includes("选哪个") || normalized.includes("推荐")) {
        return "这个我可以帮你按家里场景想一下。你要是定了，我也可以顺手帮你记成常购商品，下次补货直接沿用。"
      }
      return "这个我可以帮你按家里场景想一下。你是想省事一点，还是想更省钱？"
    }
    // 洗衣/清洁/收纳等：可以提示看家里相关物品还够不够
    if (normalized.includes("洗衣") || normalized.includes("清洁") || normalized.includes("打扫") || normalized.includes("收纳")) {
      return "这个我可以帮你按家里场景想一下。你要是想顺手看看洗衣液、清洁剂这些还够不够，我可以直接帮你看。"
    }
    return "这个我可以帮你按家里场景想一下。你是想省事一点，还是想更省钱？"
  }

  if (boundary === "casual") {
    return "行，你直接说要我看哪件事就行。"
  }

  // unsupported
  return "这个不太属于我能直接处理的家务范围。不过你要是想把它转成采购、提醒或记录，我可以接着帮你。"
}

/**
 * 生成订单截图识别完成后的管家整理文案。
 * 不暴露「识别结果」「待确认批量草稿」等系统用语，只说管家口吻的整理说明。
 *
 * - 提到准备记的物品数量
 * - 逐条提及关键物品（最多 3 条，避免刷屏）
 * - 跳过的非消耗品用一句话带过（最多 2 个物品名）
 * - 待确认的歧义行单独提示
 * - 结尾给用户明确的下一步
 */
export function composeOrderBatchMessage(params: {
  drafts: AgentDraft[]
  skippedRows?: OrderRow[]
  uncertainRows?: OrderRow[]
}): string {
  const { drafts, skippedRows, uncertainRows } = params
  const lines: string[] = []

  if (drafts.length > 0) {
    lines.push(`我看了下，这张订单里有 ${drafts.length} 样像是家里要管的消耗品。`)
    // 逐条提及关键物品（最多 3 条）
    const mentioned = drafts.slice(0, 3).map((draft) => {
      if (draft.kind === "restock") {
        const parts: string[] = []
        if (draft.qty) parts.push(`${draft.qty}${draft.unit || ""}`)
        if (draft.platform) parts.push(`平台是${draft.platform}`)
        const detail = parts.length ? `，我按 ${parts.join("，")} 记上` : "我按这次补货记上"
        return `「${draft.itemName}」${detail}`
      }
      if (draft.kind === "createItemWithRestock") {
        const qty = draft.restock.qty
        const unit = draft.restock.unit || draft.item.unit || "件"
        const qtyText = qty ? `${qty}${unit}` : "这一笔"
        return `「${draft.item.itemName}」我先把这${qtyText}加进来`
      }
      if (draft.kind === "createItem") {
        return `「${draft.itemName}」我先把这消耗品加进来`
      }
      return `「${draft.productName}」我挂到「${draft.itemName}」下面`
    })
    lines.push(mentioned.join("；") + "。")
  } else {
    lines.push("我看了下这张订单，暂时没识别到需要管理的消耗品。")
  }

  // 跳过的非消耗品
  const skipped = skippedRows || []
  if (skipped.length > 0) {
    const names = skipped.slice(0, 2).map((row) => row.coreName || row.brandName || row.productName).filter(Boolean)
    if (names.length > 0) {
      lines.push(`${names.join("、")}不像日常消耗品，我先不管。`)
    }
  }

  // 待确认的歧义行
  const uncertain = uncertainRows || []
  if (uncertain.length > 0) {
    const names = uncertain.map((row) => row.coreName || row.brandName || row.productName).filter(Boolean)
    if (names.length === 1) {
      lines.push(`${names[0]}我不太确定归到哪个物品，怕记错，先放在待确认里。`)
    } else {
      lines.push(`${names.join("、")}这几样我不太确定归到哪个物品，先放在待确认里。`)
    }
  }

  // 结尾
  if (drafts.length > 0) {
    lines.push("你要是没问题，我就按这个保存。")
  }

  return lines.join("\n")
}

/**
 * 生成订单识别进行中的提示文案。
 */
export function composeOrderRecognizingMessage(): string {
  return "我看一下这张订单。"
}

/**
 * 生成订单截图识别完成后的管家总结文案。
 * 与 composeOrderBatchMessage 不同，这里基于 OrderImportRow[]（与弹窗同结构），
 * 描述识别到几样、命中已有的有哪些、准备新建的有哪些、跳过的有哪些。
 *
 * 文案约束：
 *   - 不出现「识别结果如下」「待确认批量草稿」「字段缺失」「解析结果」
 *   - 不暴露内部状态字段名
 *   - 空字段不作为「缺失」暴露
 */
export function composeOrderImportSummary(rows: OrderImportRow[], platform?: string): string {
  const included = rows.filter((row) => row.targetItem !== "__skip__")
  const skipped = rows.filter((row) => row.targetItem === "__skip__")
  if (included.length === 0 && skipped.length === 0) {
    return "我看了下这张订单，暂时没识别到需要管理的消耗品。"
  }
  const lines: string[] = []
  if (included.length > 0) {
    lines.push(`我看了下，这张订单里有 ${included.length} 样像是家里要管的消耗品。`)
    const matched = included.filter((row) => row.targetItem !== "__create__")
    const willCreate = included.filter((row) => row.targetItem === "__create__")
    if (matched.length > 0) {
      const names = matched.map((row) => {
        const name = row.coreName || row.brandName || row.productName
        const qtyText = row.qty ? ` ${row.qty}${row.measureUnit || "件"}` : ""
        const platformText = platform ? `，平台${platform}` : ""
        return `「${name}」我按${qtyText}记上${platformText}`
      })
      lines.push(names.join("；") + "。")
    }
    if (willCreate.length > 0) {
      const names = willCreate.map((row) => row.genericName || row.coreName || row.brandName || row.productName)
      lines.push(`「${names.join("」「")}」我先把这几样加进来。`)
    }
    lines.push("你要是没问题，我就按这个保存。")
  }
  if (skipped.length > 0) {
    const names = skipped.map((row) => row.coreName || row.brandName || row.productName)
    lines.push(`${names.join("、")}不像日常消耗品，我先不管。`)
  }
  return lines.join("\n")
}
