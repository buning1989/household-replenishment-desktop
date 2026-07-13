/**
 * PricePrior：细分类目价格先验模块。
 *
 * 设计目标：
 *   1. 提供常见家庭消耗品的低置信价格先验，避免无历史时给出明显离谱的估价。
 *   2. 只覆盖能明确识别细分类目的物品，未命中时不估价。
 *   3. 价格区间保守、低置信，文案必须标注「粗估」或「常见范围」。
 *
 * 使用场景：
 *   - 当草稿缺 price 且无历史/无常购商品/无同品类历史时，
 *     用 findPricePrior 查找细分类目先验。
 *   - 命中：返回低置信区间，文案说「粗估」「常见范围」。
 *   - 未命中：不返回价格建议，文案说「我还没有历史价格，先不乱估」。
 */

export type PricePrior = {
  /** 细分类目标识 */
  categoryKey: string
  /** 别名列表（用于匹配物品名） */
  aliases: string[]
  /** 常见单位 */
  unit: string[]
  /** 单件价格区间 [min, max] */
  unitPriceRange: [number, number]
  /** 置信度（固定为 low 或 medium） */
  confidence: "low" | "medium"
  /** 备注说明 */
  note?: string
}

/**
 * 常见家庭消耗品价格先验表。
 *
 * 注意：
 *   - 这些区间基于中国大陆常见电商价格（2024-2025），仅供参考。
 *   - 实际价格因品牌、规格、平台差异较大，区间尽量保守。
 *   - 未覆盖的物品不估价，避免伪推理。
 */
const PRICE_PRIORS: PricePrior[] = [
  // 宠物用品
  {
    categoryKey: "pet_wipes",
    aliases: ["宠物湿巾", "宠物擦脚巾", "擦脚巾", "擦脚湿巾", "狗狗湿巾", "猫咪湿巾"],
    unit: ["包", "袋"],
    unitPriceRange: [5, 15],
    confidence: "low",
    note: "小包宠物湿巾/擦脚巾常见价格"
  },
  {
    categoryKey: "cat_litter",
    aliases: ["猫砂"],
    unit: ["袋", "包"],
    unitPriceRange: [20, 50],
    confidence: "low",
    note: "常见猫砂单袋价格（10L 左右规格）"
  },
  {
    categoryKey: "cat_food",
    aliases: ["猫粮"],
    unit: ["袋", "包"],
    unitPriceRange: [30, 80],
    confidence: "low",
    note: "常见猫粮单袋价格（1-2kg 规格）"
  },
  {
    categoryKey: "dog_food",
    aliases: ["狗粮"],
    unit: ["袋", "包"],
    unitPriceRange: [30, 80],
    confidence: "low",
    note: "常见狗粮单袋价格（1-2kg 规格）"
  },

  // 纸品
  {
    categoryKey: "tissue",
    aliases: ["纸巾", "抽纸", "面巾纸"],
    unit: ["包", "提"],
    unitPriceRange: [3, 15],
    confidence: "low",
    note: "单包/单提纸巾常见价格"
  },
  {
    categoryKey: "toilet_paper",
    aliases: ["卫生纸", "卷纸"],
    unit: ["提", "卷"],
    unitPriceRange: [25, 50],
    confidence: "low",
    note: "一提卫生纸（10-12 卷）常见价格"
  },
  {
    categoryKey: "kitchen_towel",
    aliases: ["厨房纸", "厨房纸巾"],
    unit: ["包", "卷"],
    unitPriceRange: [15, 30],
    confidence: "low",
    note: "单包/单卷厨房纸常见价格"
  },

  // 清洁用品
  {
    categoryKey: "trash_bag",
    aliases: ["垃圾袋"],
    unit: ["包", "卷"],
    unitPriceRange: [5, 20],
    confidence: "low",
    note: "单包/单卷垃圾袋常见价格"
  },
  {
    categoryKey: "laundry_detergent",
    aliases: ["洗衣液"],
    unit: ["瓶", "袋"],
    unitPriceRange: [20, 50],
    confidence: "low",
    note: "常见洗衣液单瓶价格（1-2L 规格）"
  },
  {
    categoryKey: "dish_soap",
    aliases: ["洗洁精"],
    unit: ["瓶"],
    unitPriceRange: [10, 25],
    confidence: "low",
    note: "常见洗洁精单瓶价格"
  },
  {
    categoryKey: "hand_soap",
    aliases: ["洗手液"],
    unit: ["瓶"],
    unitPriceRange: [15, 35],
    confidence: "low",
    note: "常见洗手液单瓶价格"
  },

  // 个人护理
  {
    categoryKey: "shampoo",
    aliases: ["洗发水"],
    unit: ["瓶"],
    unitPriceRange: [30, 80],
    confidence: "low",
    note: "常见洗发水单瓶价格（400-600ml 规格）"
  },
  {
    categoryKey: "body_wash",
    aliases: ["沐浴露"],
    unit: ["瓶"],
    unitPriceRange: [25, 60],
    confidence: "low",
    note: "常见沐浴露单瓶价格"
  },
  {
    categoryKey: "toothpaste",
    aliases: ["牙膏"],
    unit: ["支"],
    unitPriceRange: [15, 40],
    confidence: "low",
    note: "常见牙膏单支价格"
  },

  // 母婴用品
  {
    categoryKey: "diapers",
    aliases: ["纸尿裤", "尿不湿"],
    unit: ["包"],
    unitPriceRange: [80, 180],
    confidence: "low",
    note: "常见纸尿裤单包价格"
  },
  {
    categoryKey: "wet_wipes",
    aliases: ["湿巾", "婴儿湿巾"],
    unit: ["包"],
    unitPriceRange: [10, 30],
    confidence: "low",
    note: "常见湿巾单包价格（80 抽左右）"
  },
  {
    categoryKey: "pee_pad",
    aliases: ["尿垫", "宠物尿垫"],
    unit: ["包"],
    unitPriceRange: [30, 80],
    confidence: "low",
    note: "常见尿垫单包价格"
  }
]

/**
 * 根据物品名查找匹配的细分类目价格先验。
 *
 * 匹配规则：
 *   1. 将物品名转为小写（中文不区分大小写，但统一处理）。
 *   2. 遍历 PRICE_PRIORS，检查物品名是否包含任一别名。
 *   3. 返回第一个匹配的 PricePrior，未命中返回 null。
 *
 * 注意：
 *   - 匹配是「包含」关系，例如「宠物擦脚巾湿巾」会匹配到「宠物湿巾」。
 *   - 未命中时返回 null，调用方应不估价。
 */
export function findPricePrior(itemName: string): PricePrior | null {
  const lower = itemName.trim().toLocaleLowerCase("zh-CN")
  for (const prior of PRICE_PRIORS) {
    const matched = prior.aliases.some((alias) => {
      const aliasLower = alias.toLocaleLowerCase("zh-CN")
      return lower.includes(aliasLower)
    })
    if (matched) return prior
  }
  return null
}

/**
 * 工具函数：基于价格先验和数量计算总价区间。
 *
 * 返回 null 表示无先验。
 */
export function computePriceRange(
  prior: PricePrior,
  qty: number
): { min: number; max: number } | null {
  if (qty <= 0) return null
  const [unitMin, unitMax] = prior.unitPriceRange
  return {
    min: Math.round(unitMin * qty),
    max: Math.round(unitMax * qty)
  }
}
