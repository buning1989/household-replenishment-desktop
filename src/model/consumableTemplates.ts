import type { ConsumableTemplate } from "../types"

export const CONSUMABLE_TEMPLATES: ConsumableTemplate[] = [
  { id: "kitchen-dish-soap", name: "洗洁精", category: "厨房", minCycleDays: 25, maxCycleDays: 55, defaultCycleDays: 40, bufferDays: 7, unit: "瓶", activation: "default", influenceFactors: ["residents", "cooking"], learningEnabled: true, defaultConfidence: "low" },
  { id: "kitchen-paper", name: "厨房纸", category: "厨房", minCycleDays: 20, maxCycleDays: 45, defaultCycleDays: 32, bufferDays: 6, unit: "包", activation: "conditional", trigger: { kind: "cooking", values: ["often", "daily"] }, influenceFactors: ["residents", "cooking"], learningEnabled: true, defaultConfidence: "low" },
  { id: "kitchen-garbage-bags", name: "垃圾袋", category: "厨房", minCycleDays: 20, maxCycleDays: 45, defaultCycleDays: 30, bufferDays: 6, unit: "卷", activation: "default", influenceFactors: ["residents", "cooking"], learningEnabled: true, defaultConfidence: "low" },
  { id: "kitchen-storage-bags", name: "保鲜袋", category: "厨房", minCycleDays: 30, maxCycleDays: 75, defaultCycleDays: 50, bufferDays: 8, unit: "盒", activation: "conditional", trigger: { kind: "cooking", values: ["often", "daily"] }, influenceFactors: ["residents", "cooking"], learningEnabled: true, defaultConfidence: "low" },

  { id: "bathroom-toilet-paper", name: "卷纸", category: "卫生间", minCycleDays: 20, maxCycleDays: 45, defaultCycleDays: 30, bufferDays: 6, unit: "提", activation: "default", influenceFactors: ["residents", "children"], learningEnabled: true, defaultConfidence: "low" },
  { id: "bathroom-tissues", name: "抽纸", category: "卫生间", minCycleDays: 18, maxCycleDays: 40, defaultCycleDays: 28, bufferDays: 6, unit: "提", activation: "default", influenceFactors: ["residents", "children", "pets"], learningEnabled: true, defaultConfidence: "low" },
  { id: "bathroom-hand-soap", name: "洗手液", category: "卫生间", minCycleDays: 35, maxCycleDays: 75, defaultCycleDays: 55, bufferDays: 8, unit: "瓶", activation: "recommended", influenceFactors: ["residents", "children"], learningEnabled: true, defaultConfidence: "low" },
  { id: "bathroom-toilet-cleaner", name: "洁厕灵", category: "卫生间", minCycleDays: 45, maxCycleDays: 90, defaultCycleDays: 65, bufferDays: 10, unit: "瓶", activation: "recommended", influenceFactors: ["homeSize", "residents"], learningEnabled: true, defaultConfidence: "low" },

  { id: "laundry-detergent", name: "洗衣液", category: "洗衣清洁", minCycleDays: 45, maxCycleDays: 90, defaultCycleDays: 60, bufferDays: 10, unit: "瓶", activation: "default", influenceFactors: ["residents", "laundry", "children", "pets"], learningEnabled: true, defaultConfidence: "low" },
  { id: "care-shampoo", name: "洗发水", category: "日常护理", minCycleDays: 35, maxCycleDays: 75, defaultCycleDays: 50, bufferDays: 8, unit: "瓶", activation: "default", influenceFactors: ["residents"], learningEnabled: true, defaultConfidence: "low" },
  { id: "care-body-wash", name: "沐浴露", category: "日常护理", minCycleDays: 35, maxCycleDays: 75, defaultCycleDays: 52, bufferDays: 8, unit: "瓶", activation: "default", influenceFactors: ["residents"], learningEnabled: true, defaultConfidence: "low" },
  { id: "care-toothpaste", name: "牙膏", category: "日常护理", minCycleDays: 25, maxCycleDays: 55, defaultCycleDays: 38, bufferDays: 7, unit: "支", activation: "default", influenceFactors: ["residents", "children"], learningEnabled: true, defaultConfidence: "low" },
  { id: "cleaning-floor-cleaner", name: "地板清洁剂", category: "洗衣清洁", minCycleDays: 50, maxCycleDays: 100, defaultCycleDays: 75, bufferDays: 12, unit: "瓶", activation: "recommended", influenceFactors: ["homeSize", "residents", "pets"], learningEnabled: true, defaultConfidence: "low" },

  { id: "pet-cat-food", name: "猫粮", category: "宠物用品", minCycleDays: 20, maxCycleDays: 45, defaultCycleDays: 30, bufferDays: 6, unit: "袋", activation: "conditional", trigger: { kind: "pet", values: ["cat", "catAndDog"] }, influenceFactors: ["pets"], learningEnabled: true, defaultConfidence: "low" },
  { id: "pet-cat-litter", name: "猫砂", category: "宠物用品", minCycleDays: 15, maxCycleDays: 35, defaultCycleDays: 24, bufferDays: 5, unit: "袋", activation: "conditional", trigger: { kind: "pet", values: ["cat", "catAndDog"] }, influenceFactors: ["pets"], learningEnabled: true, defaultConfidence: "low" },
  { id: "pet-dog-food", name: "狗粮", category: "宠物用品", minCycleDays: 20, maxCycleDays: 45, defaultCycleDays: 30, bufferDays: 6, unit: "袋", activation: "conditional", trigger: { kind: "pet", values: ["dog", "catAndDog"] }, influenceFactors: ["pets"], learningEnabled: true, defaultConfidence: "low" },
  { id: "pet-pads", name: "尿垫", category: "宠物用品", minCycleDays: 15, maxCycleDays: 35, defaultCycleDays: 24, bufferDays: 5, unit: "包", activation: "conditional", trigger: { kind: "pet", values: ["dog", "catAndDog"] }, influenceFactors: ["pets"], learningEnabled: true, defaultConfidence: "low" },

  { id: "baby-diapers", name: "纸尿裤", category: "母婴用品", minCycleDays: 7, maxCycleDays: 20, defaultCycleDays: 14, bufferDays: 4, unit: "包", activation: "conditional", trigger: { kind: "child", values: ["infant"] }, influenceFactors: ["children"], learningEnabled: true, defaultConfidence: "low" },
  { id: "baby-wipes", name: "湿巾", category: "母婴用品", minCycleDays: 12, maxCycleDays: 30, defaultCycleDays: 20, bufferDays: 5, unit: "包", activation: "conditional", trigger: { kind: "child", values: ["infant"] }, influenceFactors: ["children", "residents"], learningEnabled: true, defaultConfidence: "low" },
  { id: "baby-formula", name: "奶粉", category: "母婴用品", minCycleDays: 7, maxCycleDays: 25, defaultCycleDays: 14, bufferDays: 5, unit: "罐", activation: "conditional", trigger: { kind: "child", values: ["infant"] }, influenceFactors: ["children"], learningEnabled: true, defaultConfidence: "low" }
]

export const CONSUMABLE_TEMPLATE_BY_ID = new Map(CONSUMABLE_TEMPLATES.map((template) => [template.id, template]))
