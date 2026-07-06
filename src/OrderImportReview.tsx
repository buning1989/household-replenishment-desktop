/**
 * 订单截图识别结果的共享展示 / 编辑组件。
 *
 * 同一套组件服务两个入口：
 *   - modal 模式：原「从订单截图导入」弹窗，字段完整展开，偏详细编辑
 *   - chat 模式：家庭管家对话里的订单截图识别结果，紧凑呈现
 *
 * 字段结构和数据结构完全一致，只在样式密度和按钮文案上有差异。
 * 不允许在 chat 模式里维护另一套订单行模型或转换逻辑。
 *
 * 纯逻辑（类型、行转换、确认转换）放在 orderImportRows.ts，方便测试和复用。
 */
import { type ReplenishmentItem } from "./types"
import { PLATFORM_OPTIONS as platforms } from "./types"
import { fuzzyMatchOption } from "./llm/orderImport"
import { measureUnitDefinitions, getCompatibleMeasureUnits } from "./orderImportHelpers"
import {
  buildOrderImportRowsFromExtract,
  orderImportRowsToConfirmed,
  rowMatchStatus,
  type OrderImportRow,
  type OrderImportConfirmedRow
} from "./orderImportRows"

/** 单次批量导入的截图数量上限，控制识别成本与确认列表长度 */
export const MAX_ORDER_IMAGES = 5

// 重新导出，方便外部从单一入口引入
export type { OrderImportRow, OrderImportConfirmedRow }
export { buildOrderImportRowsFromExtract, orderImportRowsToConfirmed, rowMatchStatus }

export type OrderImportReviewMode = "modal" | "chat"

type OrderImportReviewCardProps = {
  row: OrderImportRow
  items: ReplenishmentItem[]
  categories: string[]
  mode: OrderImportReviewMode
  onChange: (key: string, patch: Partial<OrderImportRow>) => void
}

/**
 * 单条订单识别结果卡片。
 * 字段顺序固定：商品名 / 分类 / 消耗品 / 常购商品 / 数量 / 含量 / 价格 / 日期 / 平台 / 评价 / 匹配状态。
 * 空字段不展示成强 warning；可编辑字段在两种模式下都支持编辑。
 */
export function OrderImportReviewCard({ row, items, categories, mode, onChange }: OrderImportReviewCardProps) {
  const resolvedCategory = row.category === "__newcat__" ? (row.customCategory.trim() || "其他") : row.category
  const targetItemObj = items.find((item) => item.id === row.targetItem)
  const categoryItems = items.filter((item) => item.category === resolvedCategory || item.id === row.targetItem)
  const selectedOption = targetItemObj?.purchaseOptions?.find((option) => option.id === row.targetOption)
  const unitLabel = selectedOption?.unit || targetItemObj?.unit || "件"
  const editableName = row.coreName ?? row.brandName ?? row.productName
  const coreLabel = editableName?.trim() || row.brandName || row.productName
  const matchStatus = rowMatchStatus(row, items)
  const measureUnitChoices = selectedOption?.measureUnit
    ? getCompatibleMeasureUnits(selectedOption.measureUnit)
    : measureUnitDefinitions
  const isSkipped = row.targetItem === "__skip__"
  const isChat = mode === "chat"

  return (
    <div className={`order-import-row${isSkipped ? " is-skipped" : ""}${isChat ? " is-chat" : ""}`}>
      <div className="order-import-card-title">
        <label className="order-import-name-field">
          <span>商品名</span>
          <input
            type="text"
            value={editableName ?? ""}
            aria-label="商品名"
            title={row.productName}
            onChange={(event) => onChange(row.key, { coreName: event.target.value })}
          />
        </label>
        <span className={`order-import-match-status${isSkipped ? " is-skipped" : ""}`}>{matchStatus}</span>
      </div>

      <div className="order-import-card-section order-import-target-section" aria-label={`${coreLabel}归类方式`}>
        <div className="order-import-target-selects">
          <label className="order-import-select-field">
            <span>分类</span>
            <select
              value={row.category}
              aria-label={`${coreLabel}分类`}
              onChange={(event) => {
                const nextCategory = event.target.value
                const nextResolvedCategory = nextCategory === "__newcat__" ? (row.customCategory.trim() || "其他") : nextCategory
                const firstItem = items.find((item) => item.category === nextResolvedCategory)
                const nextOption = firstItem
                  ? fuzzyMatchOption(firstItem, [row.coreName, row.productName, row.brandName])
                  : undefined
                onChange(row.key, {
                  category: nextCategory,
                  targetItem: firstItem ? firstItem.id : "__create__",
                  targetOption: firstItem
                    ? (nextOption ? nextOption.id : ((row.coreName || row.brandName || row.productName) ? "__newopt__" : ""))
                    : ""
                })
              }}
            >
              {categories.map((name) => <option key={name} value={name}>{name}</option>)}
              {!categories.includes("其他") && <option value="其他">其他</option>}
              <option value="__newcat__">新建分类</option>
            </select>
          </label>
          {row.category === "__newcat__" && (
            <label className="order-import-select-field">
              <span>新分类</span>
              <input
                type="text"
                className="order-import-newcat-input"
                aria-label={`${coreLabel}新分类名称`}
                value={row.customCategory}
                onChange={(event) => onChange(row.key, { customCategory: event.target.value })}
                placeholder="如：宝宝用品"
              />
            </label>
          )}
          <label className="order-import-select-field">
            <span>消耗品</span>
            <select
              value={row.targetItem}
              aria-label={`${coreLabel}消耗品`}
              onChange={(event) => {
                const nextItemId = event.target.value
                const nextItem = items.find((item) => item.id === nextItemId)
                const nextOption = nextItem
                  ? fuzzyMatchOption(nextItem, [row.coreName, row.productName, row.brandName])
                  : undefined
                onChange(row.key, {
                  targetItem: nextItemId,
                  category: nextItem?.category || row.category,
                  targetOption: nextItem
                    ? (nextOption ? nextOption.id : ((row.coreName || row.brandName || row.productName) ? "__newopt__" : ""))
                    : ""
                })
              }}
            >
              {categoryItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              <option value="__create__">新建消耗品「{row.genericName || coreLabel}」</option>
              <option value="__skip__">跳过，不导入</option>
            </select>
          </label>
          {targetItemObj && (
            <label className="order-import-select-field">
              <span>常购商品</span>
              <select
                value={row.targetOption}
                aria-label={`${coreLabel}常购商品`}
                onChange={(event) => onChange(row.key, { targetOption: event.target.value })}
              >
                <option value="">不指定常购商品</option>
                {(targetItemObj.purchaseOptions || []).map((option) => (
                  <option key={option.id} value={option.id}>{option.productName}</option>
                ))}
                <option value="__newopt__">新建「{coreLabel}」</option>
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="order-import-card-section order-import-row-specs">
        <label className="order-import-inline-field">
          <span>数量</span>
          <input
            type="number"
            min="1"
            aria-label={`${coreLabel}数量`}
            value={row.qty}
            onChange={(event) => onChange(row.key, { qty: event.target.value === "" ? "" : Number(event.target.value) })}
          />
          <b>{unitLabel}</b>
        </label>
        <label className="order-import-inline-field">
          <span>含量</span>
          <input
            type="number"
            min="0"
            step="0.01"
            aria-label={`${coreLabel}单件含量`}
            value={row.measureAmount}
            onChange={(event) => onChange(row.key, { measureAmount: event.target.value === "" ? "" : Number(event.target.value) })}
            placeholder="选填"
          />
          <select
            value={row.measureUnit}
            aria-label={`${coreLabel}含量单位`}
            onChange={(event) => onChange(row.key, { measureUnit: event.target.value })}
          >
            <option value="">单位</option>
            {measureUnitChoices.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
            {row.measureUnit && !measureUnitChoices.some((unit) => unit.value === row.measureUnit) && (
              <option value={row.measureUnit}>{row.measureUnit}</option>
            )}
          </select>
        </label>
        <label className="order-import-inline-field">
          <span>价格</span>
          <input
            type="number"
            min="0"
            step="0.01"
            aria-label={`${coreLabel}总价`}
            value={row.price}
            onChange={(event) => onChange(row.key, { price: event.target.value === "" ? "" : Number(event.target.value) })}
            placeholder={isChat ? "未识别，可不填" : "总价"}
          />
          <b>元</b>
        </label>
      </div>

      <div className="order-import-card-section order-import-row-meta">
        <label className="order-import-inline-field">
          <span>日期</span>
          <input
            type="date"
            aria-label={`${coreLabel}购买日期`}
            value={row.date}
            onChange={(event) => onChange(row.key, { date: event.target.value })}
          />
        </label>
        <label className="order-import-inline-field">
          <span>平台</span>
          <select
            value={row.platform}
            aria-label={`${coreLabel}购买平台`}
            onChange={(event) => onChange(row.key, { platform: event.target.value })}
          >
            <option value="">选填</option>
            {platforms.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="order-import-inline-field order-import-review-field">
          <span>评价</span>
          <input
            type="text"
            aria-label={`${coreLabel}商品评价`}
            value={row.review}
            onChange={(event) => onChange(row.key, { review: event.target.value })}
            placeholder="选填"
          />
        </label>
      </div>

      {row.duplicate && row.targetItem !== "__skip__" && (
        <span className="order-import-duplicate-hint">当天已有相同记录，可能重复</span>
      )}
    </div>
  )
}

type OrderImportReviewListProps = {
  rows: OrderImportRow[]
  items: ReplenishmentItem[]
  categories: string[]
  mode: OrderImportReviewMode
  onRowsChange: (rows: OrderImportRow[]) => void
  /** 单条跳过：把对应行 targetItem 设为 __skip__ */
  onSkipIndex?: (index: number) => void
  /** chat 模式下用户点「就这么记」时触发；modal 模式由调用方自行管理确认按钮 */
  onConfirmBatch?: () => void
  /** chat 模式下用户点「先不记」时触发 */
  onCancelBatch?: () => void
  /** 写入完成后的结果摘要和跳转入口，仅 chat 模式用 */
  result?: { summary: string; links: { label: string; target: { kind: "item"; itemId: string } | { kind: "category"; category: string } }[] }
  /** chat 模式下点击写入后的「查看」入口 */
  onOpenItem?: (itemId: string) => void
}

/**
 * 订单识别结果列表。modal 和 chat 共用。
 * - modal 模式：完整展开，确认按钮由外层 modal 提供
 * - chat 模式：紧凑展示，自带「就这么记 / 先不记 / 单条跳过」按钮
 */
export function OrderImportReviewList({
  rows,
  items,
  categories,
  mode,
  onRowsChange,
  onSkipIndex,
  onConfirmBatch,
  onCancelBatch,
  result,
  onOpenItem
}: OrderImportReviewListProps) {
  const isChat = mode === "chat"
  const includedCount = rows.filter((row) => row.targetItem !== "__skip__" && row.qty !== "" && Number(row.qty) > 0).length
  const skippedCount = rows.filter((row) => row.targetItem === "__skip__").length
  const hasPending = !result

  function updateRow(key: string, patch: Partial<OrderImportRow>) {
    onRowsChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function handleSkip(index: number) {
    if (!onSkipIndex) return
    onSkipIndex(index)
  }

  return (
    <div className={`order-import-review-list${isChat ? " is-chat" : ""}`}>
      {isChat && (
        <div className="order-import-review-header">
          <strong>这张订单里我准备这样记</strong>
          {hasPending && (
            <small>可以逐条跳过，或直接改下面的字段。没问题就点「就这么记」。</small>
          )}
        </div>
      )}
      <div className="order-import-rows">
        {rows.map((row, index) => (
          <div key={row.key} className="order-import-row-wrapper">
            <OrderImportReviewCard
              row={row}
              items={items}
              categories={categories}
              mode={mode}
              onChange={updateRow}
            />
            {isChat && hasPending && row.targetItem !== "__skip__" && (
              <button
                type="button"
                className="quiet-button compact order-import-row-skip"
                onClick={() => handleSkip(index)}
              >
                单条跳过
              </button>
            )}
            {isChat && result && row.targetItem !== "__skip__" && (() => {
              const itemId = row.targetItem !== "__create__" ? row.targetItem : undefined
              return itemId && onOpenItem ? (
                <button
                  type="button"
                  className="text-button compact order-import-row-view"
                  onClick={() => onOpenItem(itemId)}
                >
                  查看
                </button>
              ) : null
            })()}
          </div>
        ))}
      </div>
      {isChat && (
        <div className="order-import-review-actions">
          {hasPending ? (
            <>
              {onCancelBatch && (
                <button type="button" className="quiet-button compact" onClick={onCancelBatch}>先不记</button>
              )}
              {onConfirmBatch && (
                <button
                  type="button"
                  className="primary-button compact green"
                  onClick={onConfirmBatch}
                  disabled={includedCount === 0}
                >
                  就这么记（{includedCount} 件）
                </button>
              )}
            </>
          ) : result ? (
            <small className="order-import-review-summary">
              {skippedCount > 0
                ? `已记下 ${includedCount} 件，跳过 ${skippedCount} 件。`
                : `已记下 ${includedCount} 件。`}
            </small>
          ) : null}
        </div>
      )}
    </div>
  )
}
