// Demo 家庭消耗品 Seed 数据（比赛 Demo 专用）
//
// 本文件是 Demo 数据的单一数据源，由 scripts/demo-seed.mjs 和 scripts/demo-verify.mjs 引用。
// 数据描述一个"两名成人 + 一名学龄儿童 + 一只猫"的家庭，已使用 403 管家约 2-3 个月。
//
// 规则：
// - 所有日期固定，不使用 Math.random()
// - 商品名、分类、数量、金额均为固定值
// - ID 使用稳定前缀，保证可预测
// - 不修改 Agent 逻辑，仅提供数据

// ---- 日期工具 ----

/** 创建本地时间午夜时间戳（与 app 的 startOfDay 语义一致） */
function day(year, month, date) {
  return new Date(year, month - 1, date, 0, 0, 0, 0).getTime()
}

// Demo 参考日期：2026-07-12（比赛 Demo 日）
const DEMO_NOW = day(2026, 7, 12)

// ---- 家庭档案：两名成人 + 一名学龄儿童 + 一只猫 ----

const demoHouseholdProfile = {
  residentCount: 3,
  children: "schoolAge",
  pets: "cat",
  cookingFrequency: "often",
  laundryFrequency: "medium",
  homeSize: "threePlus",
  createdAt: day(2026, 4, 15),
  updatedAt: day(2026, 4, 15)
}

// ---- 分类：复用 createInitialState 的默认分类 ----

const demoCategories = [
  "卫生间",
  "厨房",
  "洗衣清洁",
  "宠物用品",
  "日常护理",
  "饮品零食",
  "其他用品"
]

// ---- 补货记录构造工具 ----

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {number} opts.at
 * @param {number} [opts.intervalDays]
 * @param {number} [opts.price]
 * @param {number} [opts.qty]
 * @param {string} [opts.platform]
 * @param {string} [opts.purchaseUnit]
 * @param {string} [opts.purchaseOptionId]
 * @param {string} [opts.purchaseProductName]
 * @param {"spec"|"weight"} [opts.purchasePricingMode]
 * @param {1|2|3} [opts.rating]
 * @param {string} [opts.review]
 */
function restockEvent(opts) {
  const event = {
    id: opts.id,
    at: opts.at,
    intervalDays: opts.intervalDays
  }
  if (opts.price !== undefined) event.price = opts.price
  if (opts.qty !== undefined) event.qty = opts.qty
  if (opts.platform !== undefined) event.platform = opts.platform
  if (opts.purchaseUnit !== undefined) event.purchaseUnit = opts.purchaseUnit
  if (opts.purchaseOptionId !== undefined) event.purchaseOptionId = opts.purchaseOptionId
  if (opts.purchaseProductName !== undefined) event.purchaseProductName = opts.purchaseProductName
  if (opts.purchasePricingMode !== undefined) event.purchasePricingMode = opts.purchasePricingMode
  if (opts.rating !== undefined) event.rating = opts.rating
  if (opts.review !== undefined) event.review = opts.review
  return event
}

/**
 * 构造一个常购商品（PurchaseOption）。
 * Demo 数据统一使用 spec 计价模式，商品身份固定。
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.productName
 * @param {string} opts.unit
 * @param {boolean} [opts.isDefault]
 */
function purchaseOption(opts) {
  return {
    id: opts.id,
    productName: opts.productName,
    unit: opts.unit,
    pricingMode: "spec",
    isDefault: opts.isDefault === undefined ? true : opts.isDefault
  }
}

// ---- 消耗品构造工具 ----

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.name
 * @param {string} opts.category
 * @param {string} opts.unit
 * @param {number} opts.cycleDays
 * @param {number} opts.bufferDays
 * @param {number} opts.lastRestockedAt
 * @param {number} opts.createdAt
 * @param {Array} opts.history
 * @param {Array} [opts.purchaseOptions]
 * @param {"low"|"medium"|"high"} [opts.confidence]
 * @param {"justRestocked"|"plenty"|"half"|"low"|"unknown"} [opts.inventoryStatus]
 * @param {number} [opts.defaultQty]
 */
function consumableItem(opts) {
  const latest = opts.history[opts.history.length - 1]
  const item = {
    id: opts.id,
    name: opts.name,
    category: opts.category,
    type: "learning",
    cycleDays: opts.cycleDays,
    bufferDays: opts.bufferDays,
    lastRestockedAt: opts.lastRestockedAt,
    inventoryDepletionAt: undefined,
    anchorEstimated: false,
    purchaseOptions: opts.purchaseOptions || [],
    history: opts.history,
    learningEnabled: true,
    source: "manual",
    confidence: opts.confidence || "medium",
    inventoryStatus: opts.inventoryStatus,
    unit: opts.unit,
    platform: latest?.platform,
    price: latest?.price,
    defaultQty: opts.defaultQty,
    createdAt: opts.createdAt,
    updatedAt: opts.lastRestockedAt
  }
  return item
}

// ---- 15 个消耗品 ----

const demoItems = [
  // 1. 猫砂 — 即将需要关注（warning），预计剩余 8 天
  //    最近补货：2026-07-03，2 袋，68 元，无平台
  //    cycleDays=17 → depletionAt=2026-07-20，daysUntilDepletion=8
  //    bufferDays=9 → dueAt=2026-07-11，daysUntilDue=-1 → warning
  consumableItem({
    id: "demo-cat-litter",
    name: "猫砂",
    category: "宠物用品",
    unit: "袋",
    cycleDays: 17,
    bufferDays: 9,
    lastRestockedAt: day(2026, 7, 3),
    createdAt: day(2026, 4, 15),
    confidence: "high",
    defaultQty: 2,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-catlitter",
        productName: "pidan 豆腐猫砂 2.4kg",
        unit: "袋"
      })
    ],
    history: [
      restockEvent({
        id: "demo-cat-litter-h1",
        at: day(2026, 5, 20),
        qty: 2,
        price: 65,
        platform: "淘宝",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-catlitter",
        purchaseProductName: "pidan 豆腐猫砂 2.4kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-cat-litter-h2",
        at: day(2026, 6, 10),
        intervalDays: 21,
        qty: 2,
        price: 68,
        platform: "淘宝",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-catlitter",
        purchaseProductName: "pidan 豆腐猫砂 2.4kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-cat-litter-h3",
        at: day(2026, 7, 3),
        intervalDays: 23,
        qty: 2,
        price: 68,
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-catlitter",
        purchaseProductName: "pidan 豆腐猫砂 2.4kg",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 2. 洗衣液 — 库存正常（normal），预计剩余 23 天
  //    最近补货：2026-06-20，1 瓶，28 元，京东
  consumableItem({
    id: "demo-laundry-detergent",
    name: "洗衣液",
    category: "洗衣清洁",
    unit: "瓶",
    cycleDays: 45,
    bufferDays: 10,
    lastRestockedAt: day(2026, 6, 20),
    createdAt: day(2026, 4, 20),
    confidence: "high",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-detergent",
        productName: "蓝月亮深层洁净洗衣液 3kg",
        unit: "瓶"
      })
    ],
    history: [
      restockEvent({
        id: "demo-laundry-detergent-h1",
        at: day(2026, 5, 10),
        qty: 1,
        price: 32,
        platform: "京东",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-detergent",
        purchaseProductName: "蓝月亮深层洁净洗衣液 3kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-laundry-detergent-h2",
        at: day(2026, 6, 20),
        intervalDays: 41,
        qty: 1,
        price: 28,
        platform: "京东",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-detergent",
        purchaseProductName: "蓝月亮深层洁净洗衣液 3kg",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 3. 宠物擦脚湿巾 — 最近刚补货（normal），预计剩余 28 天
  //    最近补货：2026-07-10，3 包，42 元，拼多多
  consumableItem({
    id: "demo-pet-wipes",
    name: "宠物擦脚湿巾",
    category: "宠物用品",
    unit: "包",
    cycleDays: 30,
    bufferDays: 6,
    lastRestockedAt: day(2026, 7, 10),
    createdAt: day(2026, 5, 1),
    confidence: "medium",
    inventoryStatus: "justRestocked",
    defaultQty: 3,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-pet-wipes",
        productName: "小佩宠物湿巾 80 抽",
        unit: "包"
      })
    ],
    history: [
      restockEvent({
        id: "demo-pet-wipes-h1",
        at: day(2026, 6, 5),
        qty: 3,
        price: 45,
        platform: "拼多多",
        purchaseUnit: "包",
        purchaseOptionId: "demo-po-pet-wipes",
        purchaseProductName: "小佩宠物湿巾 80 抽",
        purchasePricingMode: "spec",
        rating: 2,
        review: "一般"
      }),
      restockEvent({
        id: "demo-pet-wipes-h2",
        at: day(2026, 7, 10),
        intervalDays: 35,
        qty: 3,
        price: 42,
        platform: "拼多多",
        purchaseUnit: "包",
        purchaseOptionId: "demo-po-pet-wipes",
        purchaseProductName: "小佩宠物湿巾 80 抽",
        purchasePricingMode: "spec",
        rating: 3,
        review: "质量不错"
      })
    ]
  }),

  // 4. 抽纸 — 即将需要关注（warning），预计剩余 7 天
  //    最近补货：2026-06-22，2 提，35 元，无平台
  //    cycleDays=27 → depletionAt=2026-07-19，daysUntilDepletion=7
  //    bufferDays=8 → dueAt=2026-07-11，daysUntilDue=-1 → warning
  consumableItem({
    id: "demo-tissues",
    name: "抽纸",
    category: "卫生间",
    unit: "提",
    cycleDays: 27,
    bufferDays: 8,
    lastRestockedAt: day(2026, 6, 22),
    createdAt: day(2026, 4, 25),
    confidence: "high",
    defaultQty: 2,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-tissues",
        productName: "维达超韧抽纸 3 层 100 抽 × 12 包",
        unit: "提"
      })
    ],
    history: [
      restockEvent({
        id: "demo-tissues-h1",
        at: day(2026, 5, 5),
        qty: 2,
        price: 35,
        platform: "淘宝",
        purchaseUnit: "提",
        purchaseOptionId: "demo-po-tissues",
        purchaseProductName: "维达超韧抽纸 3 层 100 抽 × 12 包",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-tissues-h2",
        at: day(2026, 5, 28),
        intervalDays: 23,
        qty: 2,
        price: 33,
        platform: "淘宝",
        purchaseUnit: "提",
        purchaseOptionId: "demo-po-tissues",
        purchaseProductName: "维达超韧抽纸 3 层 100 抽 × 12 包",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-tissues-h3",
        at: day(2026, 6, 22),
        intervalDays: 25,
        qty: 2,
        price: 35,
        purchaseUnit: "提",
        purchaseOptionId: "demo-po-tissues",
        purchaseProductName: "维达超韧抽纸 3 层 100 抽 × 12 包",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 5. 垃圾袋 — 库存正常（normal），预计剩余 23 天
  //    最近补货：2026-07-05，2 卷，16 元，无平台
  consumableItem({
    id: "demo-garbage-bags",
    name: "垃圾袋",
    category: "厨房",
    unit: "卷",
    cycleDays: 30,
    bufferDays: 6,
    lastRestockedAt: day(2026, 7, 5),
    createdAt: day(2026, 5, 10),
    confidence: "medium",
    defaultQty: 2,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-garbage-bags",
        productName: "妙洁加厚垃圾袋 30 只",
        unit: "卷"
      })
    ],
    history: [
      restockEvent({
        id: "demo-garbage-bags-h1",
        at: day(2026, 6, 1),
        qty: 2,
        price: 18,
        platform: "线下",
        purchaseUnit: "卷",
        purchaseOptionId: "demo-po-garbage-bags",
        purchaseProductName: "妙洁加厚垃圾袋 30 只",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-garbage-bags-h2",
        at: day(2026, 7, 5),
        intervalDays: 34,
        qty: 2,
        price: 16,
        purchaseUnit: "卷",
        purchaseOptionId: "demo-po-garbage-bags",
        purchaseProductName: "妙洁加厚垃圾袋 30 只",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 6. 猫粮 — 最近刚补货（normal），预计剩余 26 天
  //    最近补货：2026-07-08，1 袋，120 元，京东
  consumableItem({
    id: "demo-cat-food",
    name: "猫粮",
    category: "宠物用品",
    unit: "袋",
    cycleDays: 30,
    bufferDays: 6,
    lastRestockedAt: day(2026, 7, 8),
    createdAt: day(2026, 4, 18),
    confidence: "high",
    inventoryStatus: "justRestocked",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-cat-food",
        productName: "皇家室内成猫粮 2kg",
        unit: "袋"
      })
    ],
    history: [
      restockEvent({
        id: "demo-cat-food-h1",
        at: day(2026, 5, 15),
        qty: 1,
        price: 120,
        platform: "京东",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-cat-food",
        purchaseProductName: "皇家室内成猫粮 2kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-cat-food-h2",
        at: day(2026, 6, 14),
        intervalDays: 30,
        qty: 1,
        price: 118,
        platform: "京东",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-cat-food",
        purchaseProductName: "皇家室内成猫粮 2kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-cat-food-h3",
        at: day(2026, 7, 8),
        intervalDays: 24,
        qty: 1,
        price: 120,
        platform: "京东",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-cat-food",
        purchaseProductName: "皇家室内成猫粮 2kg",
        purchasePricingMode: "spec",
        rating: 3,
        review: "猫咪爱吃"
      })
    ]
  }),

  // 7. 卷纸 — 库存正常（normal），预计剩余 13 天
  consumableItem({
    id: "demo-toilet-paper",
    name: "卷纸",
    category: "卫生间",
    unit: "提",
    cycleDays: 30,
    bufferDays: 6,
    lastRestockedAt: day(2026, 6, 25),
    createdAt: day(2026, 4, 22),
    confidence: "medium",
    defaultQty: 2,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-toilet-paper",
        productName: "维达蓝色经典卷纸 4 层 10 卷",
        unit: "提"
      })
    ],
    history: [
      restockEvent({
        id: "demo-toilet-paper-h1",
        at: day(2026, 5, 20),
        qty: 2,
        price: 45,
        platform: "淘宝",
        purchaseUnit: "提",
        purchaseOptionId: "demo-po-toilet-paper",
        purchaseProductName: "维达蓝色经典卷纸 4 层 10 卷",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-toilet-paper-h2",
        at: day(2026, 6, 25),
        intervalDays: 36,
        qty: 2,
        price: 42,
        platform: "淘宝",
        purchaseUnit: "提",
        purchaseOptionId: "demo-po-toilet-paper",
        purchaseProductName: "维达蓝色经典卷纸 4 层 10 卷",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 8. 厨房纸 — 库存正常（normal），预计剩余 8 天
  consumableItem({
    id: "demo-kitchen-paper",
    name: "厨房纸",
    category: "厨房",
    unit: "包",
    cycleDays: 32,
    bufferDays: 6,
    lastRestockedAt: day(2026, 6, 18),
    createdAt: day(2026, 4, 28),
    confidence: "medium",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-kitchen-paper",
        productName: "心相印厨房纸 2 卷",
        unit: "包"
      })
    ],
    history: [
      restockEvent({
        id: "demo-kitchen-paper-h1",
        at: day(2026, 5, 15),
        qty: 1,
        price: 22,
        platform: "京东",
        purchaseUnit: "包",
        purchaseOptionId: "demo-po-kitchen-paper",
        purchaseProductName: "心相印厨房纸 2 卷",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-kitchen-paper-h2",
        at: day(2026, 6, 18),
        intervalDays: 34,
        qty: 1,
        price: 25,
        platform: "京东",
        purchaseUnit: "包",
        purchaseOptionId: "demo-po-kitchen-paper",
        purchaseProductName: "心相印厨房纸 2 卷",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 9. 洗洁精 — 库存正常（normal），预计剩余 8 天
  consumableItem({
    id: "demo-dish-soap",
    name: "洗洁精",
    category: "厨房",
    unit: "瓶",
    cycleDays: 40,
    bufferDays: 7,
    lastRestockedAt: day(2026, 6, 10),
    createdAt: day(2026, 4, 16),
    confidence: "medium",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-dish-soap",
        productName: "立白洗洁精 1.1kg",
        unit: "瓶"
      })
    ],
    history: [
      restockEvent({
        id: "demo-dish-soap-h1",
        at: day(2026, 5, 1),
        qty: 1,
        price: 15,
        platform: "线下",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-dish-soap",
        purchaseProductName: "立白洗洁精 1.1kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-dish-soap-h2",
        at: day(2026, 6, 10),
        intervalDays: 40,
        qty: 1,
        price: 15,
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-dish-soap",
        purchaseProductName: "立白洗洁精 1.1kg",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 10. 洗手液 — 库存正常（normal），历史数据较少（仅 1 条记录）
  consumableItem({
    id: "demo-hand-soap",
    name: "洗手液",
    category: "卫生间",
    unit: "瓶",
    cycleDays: 55,
    bufferDays: 8,
    lastRestockedAt: day(2026, 6, 15),
    createdAt: day(2026, 6, 15),
    confidence: "low",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-hand-soap",
        productName: "威露士泡沫洗手液 300ml",
        unit: "瓶"
      })
    ],
    history: [
      restockEvent({
        id: "demo-hand-soap-h1",
        at: day(2026, 6, 15),
        qty: 1,
        price: 12,
        platform: "线下",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-hand-soap",
        purchaseProductName: "威露士泡沫洗手液 300ml",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 11. 牙膏 — 库存正常（normal），预计剩余 16 天
  consumableItem({
    id: "demo-toothpaste",
    name: "牙膏",
    category: "日常护理",
    unit: "支",
    cycleDays: 38,
    bufferDays: 7,
    lastRestockedAt: day(2026, 6, 20),
    createdAt: day(2026, 4, 14),
    confidence: "medium",
    defaultQty: 2,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-toothpaste",
        productName: "云南白药牙膏 120g",
        unit: "支"
      })
    ],
    history: [
      restockEvent({
        id: "demo-toothpaste-h1",
        at: day(2026, 5, 10),
        qty: 2,
        price: 28,
        platform: "淘宝",
        purchaseUnit: "支",
        purchaseOptionId: "demo-po-toothpaste",
        purchaseProductName: "云南白药牙膏 120g",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-toothpaste-h2",
        at: day(2026, 6, 20),
        intervalDays: 41,
        qty: 2,
        price: 30,
        platform: "淘宝",
        purchaseUnit: "支",
        purchaseOptionId: "demo-po-toothpaste",
        purchaseProductName: "云南白药牙膏 120g",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 12. 洗发水 — 库存正常（normal），预计剩余 20 天
  consumableItem({
    id: "demo-shampoo",
    name: "洗发水",
    category: "日常护理",
    unit: "瓶",
    cycleDays: 50,
    bufferDays: 8,
    lastRestockedAt: day(2026, 6, 12),
    createdAt: day(2026, 4, 12),
    confidence: "medium",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-shampoo",
        productName: "海飞丝去屑洗发水 750ml",
        unit: "瓶"
      })
    ],
    history: [
      restockEvent({
        id: "demo-shampoo-h1",
        at: day(2026, 5, 1),
        qty: 1,
        price: 35,
        platform: "京东",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-shampoo",
        purchaseProductName: "海飞丝去屑洗发水 750ml",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-shampoo-h2",
        at: day(2026, 6, 12),
        intervalDays: 42,
        qty: 1,
        price: 38,
        platform: "京东",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-shampoo",
        purchaseProductName: "海飞丝去屑洗发水 750ml",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 13. 沐浴露 — 库存正常（normal），预计剩余 18 天
  consumableItem({
    id: "demo-body-wash",
    name: "沐浴露",
    category: "日常护理",
    unit: "瓶",
    cycleDays: 52,
    bufferDays: 8,
    lastRestockedAt: day(2026, 6, 8),
    createdAt: day(2026, 4, 10),
    confidence: "medium",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-body-wash",
        productName: "舒肤佳沐浴露 720ml",
        unit: "瓶"
      })
    ],
    history: [
      restockEvent({
        id: "demo-body-wash-h1",
        at: day(2026, 5, 5),
        qty: 1,
        price: 25,
        platform: "淘宝",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-body-wash",
        purchaseProductName: "舒肤佳沐浴露 720ml",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-body-wash-h2",
        at: day(2026, 6, 8),
        intervalDays: 34,
        qty: 1,
        price: 28,
        platform: "淘宝",
        purchaseUnit: "瓶",
        purchaseOptionId: "demo-po-body-wash",
        purchaseProductName: "舒肤佳沐浴露 720ml",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 14. 大米 — 库存正常（normal），预计剩余 11 天
  consumableItem({
    id: "demo-rice",
    name: "大米",
    category: "厨房",
    unit: "袋",
    cycleDays: 25,
    bufferDays: 5,
    lastRestockedAt: day(2026, 6, 28),
    createdAt: day(2026, 5, 20),
    confidence: "medium",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-rice",
        productName: "十月稻田五常大米 5kg",
        unit: "袋"
      })
    ],
    history: [
      restockEvent({
        id: "demo-rice-h1",
        at: day(2026, 5, 30),
        qty: 1,
        price: 55,
        platform: "线下",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-rice",
        purchaseProductName: "十月稻田五常大米 5kg",
        purchasePricingMode: "spec"
      }),
      restockEvent({
        id: "demo-rice-h2",
        at: day(2026, 6, 28),
        intervalDays: 29,
        qty: 1,
        price: 58,
        platform: "线下",
        purchaseUnit: "袋",
        purchaseOptionId: "demo-po-rice",
        purchaseProductName: "十月稻田五常大米 5kg",
        purchasePricingMode: "spec"
      })
    ]
  }),

  // 15. 保鲜袋 — 库存正常（normal），历史数据较少（仅 1 条记录）
  consumableItem({
    id: "demo-storage-bags",
    name: "保鲜袋",
    category: "厨房",
    unit: "盒",
    cycleDays: 50,
    bufferDays: 8,
    lastRestockedAt: day(2026, 6, 2),
    createdAt: day(2026, 6, 2),
    confidence: "low",
    defaultQty: 1,
    purchaseOptions: [
      purchaseOption({
        id: "demo-po-storage-bags",
        productName: "妙洁中号保鲜袋 100 只",
        unit: "盒"
      })
    ],
    history: [
      restockEvent({
        id: "demo-storage-bags-h1",
        at: day(2026, 6, 2),
        qty: 1,
        price: 8,
        purchaseUnit: "盒",
        purchaseOptionId: "demo-po-storage-bags",
        purchaseProductName: "妙洁中号保鲜袋 100 只",
        purchasePricingMode: "spec"
      })
    ]
  })
]

// ---- 设置 ----

const demoSettings = {
  reminderIntervalHours: 1,
  quietStart: "22:00",
  quietEnd: "08:00",
  notificationEnabled: true,
  aiOrderMode: "accurate",
  monthlyBudget: 800
}

// ---- 导出 ----

/**
 * 创建 Demo AppState。
 * updatedAt 使用 DEMO_NOW 保持确定性；
 * 业务数据（items/history/dates）全部固定。
 * @returns {object} AppState
 */
export function createDemoState() {
  return {
    version: 3,
    categories: [...demoCategories],
    items: demoItems.map((item) => ({ ...item, history: [...item.history] })),
    settings: { ...demoSettings },
    householdProfile: { ...demoHouseholdProfile },
    updatedAt: DEMO_NOW
  }
}

/**
 * Demo 数据的参考日期（2026-07-12 午夜本地时间）。
 * 用于 verify 脚本计算 daysUntilDepletion 等预期值。
 */
export const DEMO_REFERENCE_DATE = DEMO_NOW

/**
 * Demo 数据的核心断言：用于 verify 脚本。
 * 每条断言描述一个必须成立的数据约束。
 */
export const DEMO_ASSERTIONS = {
  itemCount: 15,
  minHistoryCount: 30,
  maxHistoryCount: 45,
  categoryCount: 7,
  // 核心商品必须存在且唯一
  requiredItems: [
    { name: "猫砂", unit: "袋", category: "宠物用品" },
    { name: "洗衣液", unit: "瓶", category: "洗衣清洁" },
    { name: "宠物擦脚湿巾", unit: "包", category: "宠物用品" },
    { name: "抽纸", unit: "提", category: "卫生间" },
    { name: "垃圾袋", unit: "卷", category: "厨房" },
    { name: "猫粮", unit: "袋", category: "宠物用品" },
    { name: "卷纸", unit: "提", category: "卫生间" },
    { name: "厨房纸", unit: "包", category: "厨房" },
    { name: "洗洁精", unit: "瓶", category: "厨房" },
    { name: "洗手液", unit: "瓶", category: "卫生间" },
    { name: "牙膏", unit: "支", category: "日常护理" },
    { name: "洗发水", unit: "瓶", category: "日常护理" },
    { name: "沐浴露", unit: "瓶", category: "日常护理" },
    { name: "大米", unit: "袋", category: "厨房" },
    { name: "保鲜袋", unit: "盒", category: "厨房" }
  ],
  // 洗衣凝珠必须不存在
  forbiddenItems: ["洗衣凝珠"],
  // 猫砂最近补货记录
  catLitterLatestRestock: {
    date: day(2026, 7, 3),
    qty: 2,
    price: 68
  },
  // 猫砂预计剩余天数范围
  catLitterRemainingRange: { min: 5, max: 8 },
  // 猫砂状态应为 warning（即将需要关注）
  catLitterStatus: "warning"
}
