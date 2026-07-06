/**
 * 订单导入和补货记录共享的计量单位辅助函数。
 * 同时被 App.tsx（弹窗、补货记录编辑）和 OrderImportReview.tsx（订单识别结果卡片）使用。
 */

export const measureUnitDefinitions = [
  { value: "kg", label: "公斤", shortLabel: "kg", dimension: "mass", factor: 1000, defaultBaseAmount: 1, aliases: ["kg", "公斤", "千克"] },
  { value: "g", label: "克", shortLabel: "g", dimension: "mass", factor: 1, defaultBaseAmount: 100, aliases: ["g", "克"] },
  { value: "L", label: "升", shortLabel: "L", dimension: "volume", factor: 1000, defaultBaseAmount: 1, aliases: ["l", "L", "升"] },
  { value: "ml", label: "毫升", shortLabel: "ml", dimension: "volume", factor: 1, defaultBaseAmount: 100, aliases: ["ml", "毫升"] },
  { value: "个", label: "个", shortLabel: "个", dimension: "count", factor: 1, defaultBaseAmount: 1, aliases: ["个", "件"] },
  { value: "只", label: "只", shortLabel: "只", dimension: "count", factor: 1, defaultBaseAmount: 100, aliases: ["只"] },
  { value: "包", label: "包", shortLabel: "包", dimension: "count", factor: 1, defaultBaseAmount: 1, aliases: ["包"] },
  { value: "抽", label: "抽", shortLabel: "抽", dimension: "count", factor: 1, defaultBaseAmount: 100, aliases: ["抽"] },
  { value: "片", label: "片", shortLabel: "片", dimension: "count", factor: 1, defaultBaseAmount: 100, aliases: ["片"] },
  { value: "颗", label: "颗", shortLabel: "颗", dimension: "count", factor: 1, defaultBaseAmount: 1, aliases: ["颗", "粒"] },
  { value: "节", label: "节", shortLabel: "节", dimension: "count", factor: 1, defaultBaseAmount: 1, aliases: ["节"] },
  { value: "卷", label: "卷", shortLabel: "卷", dimension: "count", factor: 1, defaultBaseAmount: 1, aliases: ["卷"] }
] as const

export type MeasureUnitDefinition = (typeof measureUnitDefinitions)[number] | {
  value: string
  label: string
  shortLabel: string
  dimension: string
  factor: number
  defaultBaseAmount: number
  aliases: string[]
}

export function encodeCustomMeasureUnit(name: string, dimension: string, factor: number): string {
  return `custom:${name.trim()}:${dimension}:${factor}`
}

export function parseCustomMeasureUnit(value?: string) {
  if (!value?.startsWith("custom:")) return null
  const [, name, dimension, factorText] = value.split(":")
  const factor = Number(factorText)
  if (!name || !dimension || !Number.isFinite(factor) || factor <= 0) return null
  return {
    value,
    label: name,
    shortLabel: name,
    dimension,
    factor,
    defaultBaseAmount: 1,
    aliases: [name]
  }
}

export function getMeasureUnitDefinition(value?: string): MeasureUnitDefinition | undefined {
  if (!value) return undefined
  const customUnit = parseCustomMeasureUnit(value)
  if (customUnit) return customUnit
  const normalized = value.trim()
  return measureUnitDefinitions.find((definition) =>
    definition.value === normalized || definition.aliases.some((alias) => alias.toLowerCase() === normalized.toLowerCase())
  )
}

export function getMeasureUnitLabel(value?: string): string {
  return getMeasureUnitDefinition(value)?.label || value || "计量单位"
}

export function getMeasureUnitShortLabel(value?: string): string {
  return getMeasureUnitDefinition(value)?.shortLabel || value || "单位"
}

export function getMeasureBaseAmount(option?: { measureUnit?: string; measureBaseAmount?: number }): number {
  return option?.measureBaseAmount || (option?.measureUnit ? getMeasureUnitDefinition(option.measureUnit)?.defaultBaseAmount || 1 : 1)
}

export function getCompatibleMeasureUnits(commonUnit?: string): MeasureUnitDefinition[] {
  const definition = getMeasureUnitDefinition(commonUnit)
  if (!definition) return [...measureUnitDefinitions]
  const units = definition.dimension === "count"
    ? measureUnitDefinitions.filter((unit) => unit.dimension === "count")
    : measureUnitDefinitions.filter((unit) => unit.dimension === definition.dimension)
  return units.some((unit) => unit.value === definition.value) ? [...units] : [...units, definition]
}

export function convertMeasureAmount(amount: number | undefined, fromUnit: string | undefined, toUnit: string | undefined): number | undefined {
  if (!Number.isFinite(amount) || amount! <= 0) return undefined
  const from = getMeasureUnitDefinition(fromUnit)
  const to = getMeasureUnitDefinition(toUnit)
  if (!from || !to || from.dimension !== to.dimension) return undefined
  return amount! * from.factor / to.factor
}
