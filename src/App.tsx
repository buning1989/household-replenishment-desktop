import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { AnimatedIcon as Icon } from "./AnimatedIcon"
import { OnboardingWizard, type OnboardingCompletion } from "./OnboardingWizard"
import catIcon from "./assets/cat-icon.png?inline"
import {
  calibrateRemainingDays,
  calculateConsumption,
  computeItem,
  createItem,
  DEFAULT_CYCLES,
  estimateRemainingQty,
  formatCompactPrice,
  formatDate,
  formatDateTime,
  formatPrice,
  formatUnitPrice,
  getLatestRating,
  nextSnoozeTime,
  restockItem,
  startOfDay,
  updateRestockRecord,
  updateItemFromDraft
} from "./domain"
import { applyColdStartFeedback, createColdStartItems, type ColdStartFeedback } from "./model/coldStart"
import { extractOrderFromImage, fileToCompressedDataUrl, fuzzyMatchItem, fuzzyMatchOption, type ExtractedOrder, type OrderRecognitionMode } from "./llm/orderImport"
import { answerHouseholdQuickly, askHouseholdAssistant, buildHouseholdChatStarter, type ChatMessageLink, type ChatProposedAction, type HouseholdChatMessage } from "./llm/householdChat"
import { buildLocalDraftFromText, describeAgentDraft, parseAgentResponse, reviseAgentDraft, type AgentDraft, type AgentDraftStatus } from "./agent/drafts"
import { classifyAgentIntent, shouldSkipQuickAnswerForAgent } from "./agent/intent"
import { commitAgentDraft, type AgentMessageLink } from "./agent/executor"
import { loadState, persistState, reconcileState, takePendingLoadIssue, type PersistenceIssue } from "./store"
import { canConfirmRestock, applyDeleteCategory, calculateMonthlySpend } from "./pure-logic.mjs"
import type { AppState, DeleteCategoryOptions, HouseholdProfile, ItemComputed, ItemDraft, OnboardingState, PricingMode, Rating, ReplenishmentItem, PurchaseOption, RestockEvent } from "./types"
import { PLATFORM_OPTIONS as platforms, UNIT_OPTIONS as units } from "./types"

const EMPTY_DRAFT: ItemDraft = {
  name: "",
  category: "厨房",
  cycleDays: 10,
  bufferDays: 2,
  link: "",
  remainingDays: "",
  learningEnabled: true,
  unit: "件",
  defaultQty: "",
  platform: ""
}

// 格式化物品状态栏文本
function formatItemStatusText(
  item: ReplenishmentItem,
  computed: ItemComputed,
  options?: { includeCategory?: boolean }
): string {
  const parts: string[] = []

  // 0. 所属大类（仅在“当前待处理”等跨分类列表中显示，分类页内不重复）
  if (options?.includeCategory) {
    parts.push(item.category || "未分类")
  }

  // 1. 剩余天数
  parts.push(`还剩约 ${Math.max(0, computed.daysUntilDepletion)} 天`)
  
  // 2. 上次补货日期
  if (item.lastRestockedAt) {
    const lastRestockDate = new Date(item.lastRestockedAt)
    const month = lastRestockDate.getMonth() + 1
    const day = lastRestockDate.getDate()
    parts.push(`上次补货 ${month} 月 ${day} 日`)
  }

  // 3. 上次购买的商品名称
  const lastEvent = item.history.length > 0 ? item.history[item.history.length - 1] : null
  if (lastEvent?.purchaseProductName) {
    parts.push(lastEvent.purchaseProductName)
  }

  return parts.join(' · ')
}

// 获取用于展示的采购选项单位
function getDisplayPurchaseUnit(item: ReplenishmentItem): string {
  if (item.unit) return item.unit
  const defaultOption = item.purchaseOptions?.find(opt => opt.isDefault)
  if (defaultOption?.unit) {
    return defaultOption.unit
  }
  if (item.purchaseOptions?.length && item.purchaseOptions[0].unit) {
    return item.purchaseOptions[0].unit
  }
  return "件"
}

function cloneItem(item: ReplenishmentItem): ReplenishmentItem {
  return { ...item, history: item.history.map((event) => ({ ...event })) }
}

function toDateInputValue(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseDateInputValue(value: string): number | undefined {
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function formatFullDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

type ItemViewType = { item: ReplenishmentItem; computed: ItemComputed }

function PersistenceAlert({ issue, backupState, onRetry, onCopyBackup, onDismiss }: {
  issue: PersistenceIssue
  backupState: "idle" | "copied" | "failed"
  onRetry: () => void
  onCopyBackup: () => void
  onDismiss: () => void
}) {
  return (
    <div className="persistence-alert" role="alert">
      <div className="persistence-alert-copy">
        <strong>数据保存需要注意</strong>
        <span>{issue.message}</span>
        {backupState === "failed" && <span className="persistence-alert-detail">复制备份失败，请保持应用开启后重试。</span>}
      </div>
      <div className="persistence-alert-actions">
        {issue.kind !== "read" && <button type="button" onClick={onRetry}>重试保存</button>}
        <button type="button" onClick={onCopyBackup}>{backupState === "copied" ? "已复制备份" : "复制当前数据"}</button>
        <button type="button" className="persistence-alert-dismiss" onClick={onDismiss} aria-label="关闭数据保存提示"><Icon name="close" size={14} /></button>
      </div>
    </div>
  )
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function RestockHeatmap({ items, now }: { items: ReplenishmentItem[]; now: number }) {
  const today = startOfDay(now)
  const monthStartDate = new Date(today)
  monthStartDate.setDate(1)
  const monthEndDate = new Date(monthStartDate)
  monthEndDate.setMonth(monthEndDate.getMonth() + 1)
  monthEndDate.setDate(0)
  const firstDayOffset = (monthStartDate.getDay() + 6) % 7
  const startDate = new Date(monthStartDate)
  startDate.setDate(startDate.getDate() - firstDayOffset)
  const lastDayOffset = (monthEndDate.getDay() + 6) % 7
  const endDate = new Date(monthEndDate)
  endDate.setDate(endDate.getDate() + (6 - lastDayOffset))
  const startMs = startOfDay(startDate.getTime())
  const endMs = startOfDay(endDate.getTime())
  const spendByDay = new Map<string, { amount: number; count: number }>()

  for (const item of items) {
    for (const event of item.history || []) {
      const price = Number(event.price)
      if (!Number.isFinite(event.at) || !Number.isFinite(price) || price <= 0) continue
      const eventDay = startOfDay(event.at)
      if (eventDay < startMs || eventDay > endMs) continue
      const key = dayKey(eventDay)
      const current = spendByDay.get(key) || { amount: 0, count: 0 }
      spendByDay.set(key, { amount: current.amount + price, count: current.count + 1 })
    }
  }

  const monthSpend = calculateMonthlySpend(items, now)
  const cellCount = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1
  const currentMonth = monthStartDate.getMonth()
  const monthLabel = new Intl.DateTimeFormat("zh-CN", { month: "long" }).format(monthStartDate)
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(startMs)
    date.setDate(date.getDate() + index)
    const timestamp = startOfDay(date.getTime())
    const value = spendByDay.get(dayKey(timestamp))
    const amount = value?.amount || 0
    const level = amount <= 0 ? 0 : amount < 50 ? 1 : amount < 150 ? 2 : amount < 300 ? 3 : 4
    const title = `${formatDate(timestamp)} · ${amount > 0 ? `¥${formatPrice(amount)} · ${value?.count || 0} 项` : "无补货"}`
    return { key: dayKey(timestamp), level, title, inMonth: date.getMonth() === currentMonth }
  })

  return (
    <section className="sidebar-heatmap" aria-label="花费">
      <div className="sidebar-heatmap-heading">
        <span className="sidebar-section-label">花费</span>
        <span className="sidebar-heatmap-total">{monthLabel} ¥{formatPrice(monthSpend)}</span>
      </div>
      {spendByDay.size > 0 ? (
        <>
          <div className="sidebar-heatmap-grid">
            {cells.map((cell) => (
              <span
                key={cell.key}
                className="sidebar-heatmap-cell"
                data-level={cell.level}
                data-muted={!cell.inMonth || undefined}
                title={cell.title}
                aria-label={cell.title}
              />
            ))}
          </div>
          <div className="sidebar-heatmap-legend" aria-hidden="true">
            <span>少</span>
            <span className="sidebar-heatmap-cell" data-level={1} />
            <span className="sidebar-heatmap-cell" data-level={2} />
            <span className="sidebar-heatmap-cell" data-level={3} />
            <span className="sidebar-heatmap-cell" data-level={4} />
            <span>多</span>
          </div>
        </>
      ) : (
        <p className="sidebar-heatmap-empty">有价格记录后显示</p>
      )}
    </section>
  )
}

function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [persistenceIssue, setPersistenceIssue] = useState<PersistenceIssue | null>(() => takePendingLoadIssue())
  const [backupCopyState, setBackupCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const persistenceSequence = useRef(0)
  // 启动协调完成前禁止将空初始状态写回主进程，避免覆盖桌面备份
  const [persistenceReady, setPersistenceReady] = useState(false)
  const [editingItem, setEditingItem] = useState<ReplenishmentItem | null | undefined>(undefined)
  const [newItemCategory, setNewItemCategory] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [categoryCreatorOpen, setCategoryCreatorOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<"rename" | null>(null)
  const [pendingCategoryDelete, setPendingCategoryDelete] = useState<string | null>(null)
  const [detailItemId, setDetailItemId] = useState<string | null>(null)
  // Restock modal state
  const [restockToast, setRestockToast] = useState<{ itemName: string } | null>(null)
  const [restockModalOpen, setRestockModalOpen] = useState(false)
  const [restockModalItemId, setRestockModalItemId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Panel exit animation states
  const [categoryPanelClosing, setCategoryPanelClosing] = useState(false)
  const [detailPanelClosing, setDetailPanelClosing] = useState(false)
  const [editorClosing, setEditorClosing] = useState(false)
  const [settingsClosing, setSettingsClosing] = useState(false)
  const [categoryCreatorClosing, setCategoryCreatorClosing] = useState(false)
  const [categoryManagerClosing, setCategoryManagerClosing] = useState(false)
  const [householdChatOpen, setHouseholdChatOpen] = useState(false)
  const [householdChatClosing, setHouseholdChatClosing] = useState(false)
  const [householdChatMessages, setHouseholdChatMessages] = useState<HouseholdChatMessage[]>([])
  const [householdChatLastQuestion, setHouseholdChatLastQuestion] = useState("")
  // Item creator dialog state
  const [isItemCreatorOpen, setIsItemCreatorOpen] = useState(false)
  const [creatingCategory, setCreatingCategory] = useState<string | null>(null)
  // Item editor dialog state
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [isItemEditorDialogOpen, setIsItemEditorDialogOpen] = useState(false)
  // Purchase option management state
  const [showAddPurchaseModal, setShowAddPurchaseModal] = useState(false)
  const [addPurchaseOptionItemId, setAddPurchaseOptionItemId] = useState<string | null>(null)
  const [editingPurchaseOption, setEditingPurchaseOption] = useState<PurchaseOption | null>(null)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingRestockRecord, setEditingRestockRecord] = useState<{ itemId: string; recordId: string } | null>(null)
  // 当从补货弹窗中录入新商品后，用于在 RestockModal 中自动选中该商品
  const [preferredPurchaseOptionId, setPreferredPurchaseOptionId] = useState<string | null>(null)
  // 订单截图批量导入弹窗
  const [orderImportOpen, setOrderImportOpen] = useState(false)
  function deferredClose(setClosing: (v: boolean) => void, actualClose: () => void, delay = 200) {
    setClosing(true)
    setTimeout(() => { setClosing(false); actualClose() }, delay)
  }

  const itemViews = useMemo(() => state.items
    .map((item) => ({ item, computed: computeItem(item, now) }))
    .sort((a, b) => a.computed.dueAt - b.computed.dueAt), [now, state.items])
  const dueItems = useMemo(() => {
    return itemViews
      .filter(({ computed }) => computed.isDue)
      .sort((a, b) => a.computed.dueAt - b.computed.dueAt)
  }, [itemViews])
  const snoozedItems = useMemo(() => itemViews
    .filter(({ computed }) => computed.isSnoozed && computed.status !== "normal")
    .sort((a, b) => Number(a.item.snoozeUntil || 0) - Number(b.item.snoozeUntil || 0)), [itemViews])
  const detailItem = detailItemId ? state.items.find((item) => item.id === detailItemId) || null : null
  const editingRestockItem = editingRestockRecord ? state.items.find((item) => item.id === editingRestockRecord.itemId) || null : null
  const editingRestockEvent = editingRestockItem && editingRestockRecord
    ? editingRestockItem.history.find((record) => record.id === editingRestockRecord.recordId) || null
    : null
  const categorySummaries = useMemo(() => state.categories.map((category) => {
    const views = itemViews.filter(({ item }) => item.category === category)
    return {
      category,
      views,
      urgent: views.filter(({ computed }) => computed.displayStatus === "urgent").length,
      warning: views.filter(({ computed }) => computed.displayStatus === "warning").length
    }
  }), [itemViews, state.categories])
  const householdChatSubtitle = householdChatLastQuestion.trim() || "库存与补货"

  useEffect(() => {
    // 启动协调完成前禁止将空初始状态写回主进程，避免覆盖桌面备份。
    // 用户连续操作时合并保存，减少 localStorage / 主进程文件的重复写入。
    if (!persistenceReady) return
    const sequence = ++persistenceSequence.current
    const timer = window.setTimeout(() => {
      void persistState(state).then((issue) => {
        if (sequence !== persistenceSequence.current) return
        setPersistenceIssue((current) => issue ?? (current?.kind === "read" ? current : null))
        if (issue) setBackupCopyState("idle")
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [state, persistenceReady])

  // 启动时协调 localStorage 与主进程 JSON 两份数据，选择较新或有效的版本
  useEffect(() => {
    let cancelled = false
    const initial = loadState()
    void reconcileState(initial).then((reconciled) => {
      if (cancelled) return
      setState(reconciled)
      setPersistenceReady(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => window.desktop?.onNotificationAction((payload) => {
    if (payload.action === "open" && payload.itemIds.length === 1) {
      setDetailItemId(payload.itemIds[0])
    }
    if (payload.action === "restock" && payload.itemIds.length === 1) {
      const item = state.items.find((current) => current.id === payload.itemIds[0])
      if (item) handleRestock(item)
    }
    if (payload.action === "snooze") {
      const snoozeUntil = nextSnoozeTime(state.settings.reminderIntervalHours)
      updateItems(payload.itemIds, (item) => ({ ...item, snoozeUntil, updatedAt: Date.now() }))
    }
  }), [state.items, state.settings.reminderIntervalHours])

  useEffect(() => {
    function closeTopPanel(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (pendingCategoryDelete) setPendingCategoryDelete(null)
      else if (categoryDialog) setCategoryDialog(null)
      else if (detailItemId) deferredClose(setDetailPanelClosing, () => setDetailItemId(null))
      else if (householdChatOpen) deferredClose(setHouseholdChatClosing, () => setHouseholdChatOpen(false))
      else if (settingsOpen) deferredClose(setSettingsClosing, () => setSettingsOpen(false))
      else if (categoryCreatorOpen) deferredClose(setCategoryCreatorClosing, () => setCategoryCreatorOpen(false), 150)
    }
    window.addEventListener("keydown", closeTopPanel)
    return () => window.removeEventListener("keydown", closeTopPanel)
  }, [categoryCreatorOpen, categoryDialog, detailItemId, editingItem, householdChatOpen, pendingCategoryDelete, settingsOpen])

  function commit(next: AppState) {
    setState({ ...next, updatedAt: Date.now() })
  }

  function updateItems(ids: string[], updater: (item: ReplenishmentItem) => ReplenishmentItem) {
    setState((current) => ({
      ...current,
      items: current.items.map((item) => ids.includes(item.id) ? updater(item) : item),
      updatedAt: Date.now()
    }))
  }

  function handleRestock(item: ReplenishmentItem) {
    // 打开补货弹窗，而不是展开内联输入卡
    setRestockModalItemId(item.id)
    setRestockModalOpen(true)
  }

  function performRestock(itemId: string, qty?: number, price?: number, platform?: string, purchaseOptionId?: string, purchaseProductName?: string, purchaseUnit?: string, purchasePricingMode?: PricingMode, purchaseMeasureBaseAmount?: number, purchaseMeasureAmount?: number, purchaseMeasureUnit?: string, review?: string, restockDate?: number) {
    const currentItem = state.items.find((item) => item.id === itemId)
    if (!currentItem) return
    updateItems([itemId], (current) => restockItem(current, Date.now(), price, qty, platform, purchaseOptionId, purchaseProductName, purchaseUnit, purchasePricingMode, purchaseMeasureBaseAmount, purchaseMeasureAmount, purchaseMeasureUnit, review, restockDate))
  }

  // 订单截图批量导入确认：一次 setState 写入全部补货记录，
  // 必要时新建物品/常购商品，写入路径与补货面板一致（带 purchaseOptionId 快照）
  function handleOrderImportConfirm(payload: { rows: OrderImportConfirmedRow[] }) {
    const now = Date.now()
    const actionableRows = payload.rows.filter((row) => row.targetItem !== "__skip__")
    setOrderImportOpen(false)
    if (!actionableRows.length) return
    type ImportRow = typeof actionableRows[number]
    setState((current) => {
      let items = [...current.items]
      let categories = current.categories

      // 与 RestockModal 相同的写入口径：带 option id/名称/单位/计价方式/含量快照
      const restockWith = (item: ReplenishmentItem, row: ImportRow, option?: PurchaseOption): ReplenishmentItem =>
        restockItem(
          item,
          now,
          row.price,
          row.qty,
          row.platform,
          option?.id,
          option?.productName || row.coreName || row.brandName || row.productName,
          option?.unit || item.unit,
          option ? (option.pricingMode || (option.measureUnit ? "measure" : "spec")) : undefined,
          option?.measureBaseAmount,
          row.measureAmount,
          row.measureUnit,
          row.review,
          row.restockDate
        )

      const newOptionFrom = (row: ImportRow, unit: string): PurchaseOption => ({
        id: crypto.randomUUID(),
        productName: (row.coreName || row.brandName || row.productName).trim(),
        unit,
        pricingMode: "spec"
      })

      const applyToItem = (itemId: string, row: ImportRow) => {
        items = items.map((item) => {
          if (item.id !== itemId) return item
          const targetCategory = (row.category || item.category || "其他").trim() || "其他"
          const itemWithCategory = item.category === targetCategory
            ? item
            : { ...item, category: targetCategory, updatedAt: now }
          if (row.targetOption === "__newopt__") {
            // 顺带建档：把识别出的品牌商品登记为常购商品
            const option = newOptionFrom(row, itemWithCategory.unit || "件")
            return restockWith({ ...itemWithCategory, purchaseOptions: [...(itemWithCategory.purchaseOptions || []), option] }, row, option)
          }
          const option = (itemWithCategory.purchaseOptions || []).find((candidate) => candidate.id === row.targetOption)
          return restockWith(itemWithCategory, row, option)
        })
      }

      for (const row of actionableRows) {
        if (row.targetItem === "__create__") {
          const name = (row.genericName || row.coreName || row.brandName || row.productName).trim()
          if (!name) continue
          // 同名物品已存在时直接补货到该物品，避免重复建档
          const existing = items.find((item) => item.name.trim().toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))
          if (existing) {
            applyToItem(existing.id, { ...row, targetOption: "__newopt__" })
            continue
          }
          const categoryName = (row.category || "其他").trim() || "其他"
          const newItem = createItem({
            name,
            category: categoryName,
            cycleDays: 30,
            bufferDays: 2,
            link: "",
            remainingDays: "",
            learningEnabled: true,
            unit: "件",
            defaultQty: "",
            platform: ""
          }, now)
          if (!categories.includes(categoryName)) categories = [...categories, categoryName]
          const option = newOptionFrom(row, "件")
          items = [...items, restockWith({ ...newItem, purchaseOptions: [option] }, row, option)]
        } else {
          applyToItem(row.targetItem, row)
        }
      }
      return { ...current, categories, items, updatedAt: now }
    })
    setRestockToast({ itemName: `${actionableRows.length} 项商品` })
  }

  function saveEditedRestockRecord(itemId: string, recordId: string, patch: Pick<RestockEvent, "at" | "qty" | "price"> & Partial<Pick<RestockEvent, "platform" | "purchasePricingMode" | "purchaseMeasureBaseAmount" | "purchaseMeasureAmount" | "purchaseMeasureUnit" | "review">>) {
    updateItems([itemId], (current) => updateRestockRecord(current, recordId, patch))
    setEditingRestockRecord(null)
  }

  function handleSnooze(item: ReplenishmentItem) {
    const snoozeUntil = nextSnoozeTime(state.settings.reminderIntervalHours)
    updateItems([item.id], (current) => ({ ...current, snoozeUntil, updatedAt: Date.now() }))
  }

  function handleColdStartFeedback(item: ReplenishmentItem, feedback: ColdStartFeedback) {
    const snoozeUntil = feedback === "later" ? nextSnoozeTime(state.settings.reminderIntervalHours) : undefined
    updateItems([item.id], (current) => applyColdStartFeedback(current, feedback, Date.now(), snoozeUntil))
  }

  function calibrateItem(item: ReplenishmentItem, remainingDays: number) {
    updateItems([item.id], (current) => calibrateRemainingDays(current, remainingDays))
  }

  function quickEditItem(item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform" | "purchaseOptions">>) {
    updateItems([item.id], (current) => {
      const nextUnit = patch.unit?.trim()
      return {
        ...current,
        ...patch,
        purchaseOptions: nextUnit
          ? (current.purchaseOptions || []).map((option) => ({ ...option, unit: nextUnit }))
          : patch.purchaseOptions ?? current.purchaseOptions,
        updatedAt: Date.now()
      }
    })
  }

  function saveItem(draft: ItemDraft) {
    if (!draft.name.trim()) return
    const nextItem = editingItem ? updateItemFromDraft(editingItem, draft) : createItem(draft)
    const exists = state.items.some((item) => item.id === nextItem.id)
    const categories = state.categories.includes(nextItem.category)
      ? state.categories
      : [...state.categories, nextItem.category]
    commit({
      ...state,
      categories,
      items: exists
        ? state.items.map((item) => item.id === nextItem.id ? nextItem : item)
        : [...state.items, nextItem]
    })
    setEditingItem(undefined)
    setNewItemCategory(undefined)
  }

  // 对话确认清单的写入执行器：一次 setState 批量创建，重名跳过，
  // addPurchaseOption 可以引用同一批 createItem 刚建出来的物品；返回跳转入口
  function handleChatActionsConfirm(actions: ChatProposedAction[]): { created: string[]; skipped: string[]; links: ChatMessageLink[] } {
    const now = Date.now()
    const created: string[] = []
    const skipped: string[] = []
    const links: ChatMessageLink[] = []
    const linkedItemIds = new Set<string>()
    const norm = (value: string) => value.trim().toLocaleLowerCase("zh-CN")
    let categories = [...state.categories]
    let items = [...state.items]

    const addItemLink = (itemId: string, name: string) => {
      if (linkedItemIds.has(itemId)) return
      linkedItemIds.add(itemId)
      links.push({ label: `查看「${name}」`, target: { kind: "item", itemId } })
    }

    for (const action of actions) {
      if (action.type === "createCategory") {
        const name = action.name.trim()
        if (categories.some((category) => norm(category) === norm(name))) {
          skipped.push(`分类「${name}」已存在`)
        } else {
          categories = [...categories, name]
          created.push(`分类「${name}」`)
          links.push({ label: `打开分类「${name}」`, target: { kind: "category", category: name } })
        }
      } else if (action.type === "createItem") {
        const name = action.name.trim()
        if (items.some((item) => norm(item.name) === norm(name))) {
          skipped.push(`消耗品「${name}」已存在`)
          continue
        }
        const category = action.category.trim() || "其他"
        if (!categories.includes(category)) {
          categories = [...categories, category]
          created.push(`分类「${category}」`)
        }
        const newItem = createItem({
          name,
          category,
          cycleDays: action.cycleDays,
          bufferDays: action.bufferDays,
          link: "",
          remainingDays: "",
          learningEnabled: true,
          unit: action.unit.trim() || "件",
          defaultQty: "",
          platform: ""
        }, now)
        items = [...items, newItem]
        created.push(`消耗品「${name}」`)
        addItemLink(newItem.id, name)
      } else {
        const target = items.find((item) => norm(item.name) === norm(action.itemName))
          || items.find((item) => action.itemName.includes(item.name) || item.name.includes(action.itemName))
        if (!target) {
          skipped.push(`找不到消耗品「${action.itemName}」，未添加「${action.productName}」`)
          continue
        }
        if ((target.purchaseOptions || []).some((option) => norm(option.productName) === norm(action.productName))) {
          skipped.push(`「${target.name}」下已有商品「${action.productName}」`)
          continue
        }
        const option: PurchaseOption = {
          id: crypto.randomUUID(),
          productName: action.productName.trim(),
          unit: action.unit.trim() || target.unit || "件",
          pricingMode: "spec"
        }
        items = items.map((item) => item.id === target.id
          ? { ...item, purchaseOptions: [...(item.purchaseOptions || []), option], updatedAt: now }
          : item)
        created.push(`常购商品「${action.productName}」（${target.name}）`)
        addItemLink(target.id, target.name)
      }
    }

    commit({ ...state, categories, items })
    return { created, skipped, links: links.slice(0, 3) }
  }

  function handleAgentDraftConfirm(agentDraft: AgentDraft): { summary: string; links: AgentMessageLink[] } {
    const result = commitAgentDraft(state, agentDraft)
    if (result.state !== state) commit(result.state)
    return { summary: result.summary, links: result.links }
  }

  function addCategory(name: string): string | undefined {
    const normalized = name.trim()
    if (!normalized) return undefined
    setState((current) => ({
      ...current,
      categories: current.categories.includes(normalized)
        ? current.categories
        : [...current.categories, normalized],
      updatedAt: Date.now()
    }))
    return normalized
  }

  function renameCategory(category: string, nextName: string) {
    const normalized = nextName.trim()
    if (!normalized || normalized === category || state.categories.includes(normalized)) return
    setState((current) => ({
      ...current,
      categories: current.categories.map((name) => name === category ? normalized : name),
      items: current.items.map((item) => item.category === category ? { ...item, category: normalized, updatedAt: Date.now() } : item),
      updatedAt: Date.now()
    }))
    setActiveCategory(normalized)
    setCategoryDialog(null)
  }

  function deleteCategory(category: string, options?: DeleteCategoryOptions) {
    // 安全门：非空分类必须显式选择迁移目标或确认删除物品，避免一个轻量 confirm 误删真实数据。
    // applyDeleteCategory 在条件不满足时返回 ok:false，state 不会被改动。
    setState((current) => {
      const result = applyDeleteCategory(current, category, options)
      if (!result.ok) {
        // 拒绝删除：保持原 state，由调用方（Sidebar）的 UI 保证不会走到这里。
        return current
      }
      return result.state
    })
    setCategoryDialog(null)
    setPendingCategoryDelete(null)
    setActiveCategory(null)
  }

  function deleteItem(item: ReplenishmentItem) {
    commit({ ...state, items: state.items.filter((current) => current.id !== item.id) })
    setDetailItemId(null)
    setEditingItem(undefined)
  }

  function renameItem(id: string, newName: string) {
    const normalizedName = newName.trim()
    if (!normalizedName) return
    setState(prev => ({
      ...prev,
      items: prev.items.map(item => 
        item.id === id ? { ...item, name: normalizedName } : item
      ),
      updatedAt: Date.now()
    }))
  }

  function moveItemToCategory(id: string, newCategory: string) {
    setState(prev => ({
      ...prev,
      items: prev.items.map(item => 
        item.id === id ? { ...item, category: newCategory } : item
      ),
      updatedAt: Date.now()
    }))
  }

  function deleteItemById(id: string) {
    setState(prev => ({
      ...prev,
      items: prev.items.filter(item => item.id !== id),
      updatedAt: Date.now()
    }))
  }

  function handleRestockFromOption(itemId: string, option: PurchaseOption) {
    const item = state.items.find(i => i.id === itemId)
    if (!item) return
    setRestockModalItemId(itemId)
    setPreferredPurchaseOptionId(option.id)
    setRestockModalOpen(true)
  }

  function handleAddPurchaseOption(itemId: string, optionData: Omit<PurchaseOption, 'id'>) {
    const item = state.items.find((current) => current.id === itemId)
    if (!item) return
    const pricingMode = optionData.pricingMode || (optionData.measureUnit ? 'measure' : 'spec')
    const option: PurchaseOption = {
      id: crypto.randomUUID(),
      ...optionData,
      unit: optionData.unit.trim() || item.unit || '件',
      pricingMode,
      measureUnit: pricingMode === 'measure' ? optionData.measureUnit?.trim() || undefined : undefined,
      measureBaseAmount: pricingMode === 'measure' && optionData.measureBaseAmount && optionData.measureBaseAmount > 0 ? optionData.measureBaseAmount : undefined,
      platform: undefined,
      price: undefined,
      review: undefined
    }

    updateItems([itemId], (current) => ({
      ...current,
      purchaseOptions: [...(current.purchaseOptions || []), option]
    }))

    // 关闭录入弹窗
    setShowAddPurchaseModal(false)
    setAddPurchaseOptionItemId(null)

    // 如果当前正在给同一个 item 补货，则让 RestockModal 自动选中刚录入的选项，并保持补货弹窗打开
    if (restockModalOpen && restockModalItemId === itemId) {
      setPreferredPurchaseOptionId(option.id)
    }
  }

  // 保存编辑后的商品
  function handleSaveEditedOption(editedOption: PurchaseOption) {
    const item = state.items.find(i => i.purchaseOptions?.some(opt => opt.id === editedOption.id))
    if (!item) return
    
    updateItems([item.id], (current) => ({
      ...current,
      purchaseOptions: (current.purchaseOptions || []).map(opt => 
        opt.id === editedOption.id
          ? {
              ...editedOption,
              unit: editedOption.unit.trim() || current.unit || '件',
              pricingMode: editedOption.pricingMode || (editedOption.measureUnit ? 'measure' : 'spec'),
              measureUnit: (editedOption.pricingMode || (editedOption.measureUnit ? 'measure' : 'spec')) === 'measure' ? editedOption.measureUnit?.trim() || undefined : undefined,
              measureBaseAmount: (editedOption.pricingMode || (editedOption.measureUnit ? 'measure' : 'spec')) === 'measure' && editedOption.measureBaseAmount && editedOption.measureBaseAmount > 0 ? editedOption.measureBaseAmount : undefined,
              platform: undefined,
              price: undefined,
              review: undefined
            }
          : opt
      )
    }))
    
    setEditModalOpen(false)
    setEditingPurchaseOption(null)
  }

  // 编辑商品
  function handleEditPurchaseOption(option: PurchaseOption) {
    setEditingPurchaseOption(option)
    setEditModalOpen(true)
  }

  // 删除商品
  function handleDeletePurchaseOption(itemId: string, optionId: string) {
    const item = state.items.find(i => i.id === itemId)
    if (!item) return
    
    updateItems([itemId], (current) => ({
      ...current,
      purchaseOptions: (current.purchaseOptions || []).filter(opt => opt.id !== optionId)
    }))
  }

  // 取消补货
  function handleCancelRestock() {
    setRestockModalOpen(false)
    setRestockModalItemId(null)
  }

  function applyCycleSuggestion(item: ReplenishmentItem) {
    if (!item.suggestedCycleDays) return
    updateItems([item.id], (current) => ({
      ...current,
      cycleDays: current.suggestedCycleDays || current.cycleDays,
      suggestedCycleDays: undefined,
      updatedAt: Date.now()
    }))
  }

  function dismissSuggestion(item: ReplenishmentItem) {
    updateItems([item.id], (current) => ({ ...current, suggestedCycleDays: undefined, updatedAt: Date.now() }))
  }

  function rateRestockEvent(itemId: string, eventId: string, rating?: Rating, review?: string) {
    updateItems([itemId], (item) => ({
      ...item,
      history: item.history.map((e) =>
        e.id === eventId ? { ...e, rating: rating ?? e.rating, review: review?.trim() || undefined } : e
      ),
      updatedAt: Date.now()
    }))
  }

  function openItem(item: ReplenishmentItem) {
    setDetailItemId(item.id)
  }

  function editFromDetail(item: ReplenishmentItem) {
    setDetailItemId(null)
    setNewItemCategory(undefined)
    setEditingItem(item)
  }

  function addItemToCategory(category: string) {
    setNewItemCategory(category)
    setEditingItem(null)
  }

  function handleOnboardingProgress(profile: HouseholdProfile, patch: Partial<OnboardingState>) {
    setState((current) => ({
      ...current,
      householdProfile: profile,
      onboarding: { ...current.onboarding, ...patch },
      updatedAt: Date.now()
    }))
  }

  function handleOnboardingSkip() {
    const completedAt = Date.now()
    const isRerun = state.onboarding.rerun
    setState((current) => ({
      ...current,
      onboarding: {
        ...current.onboarding,
        completed: true,
        rerun: false,
        currentStep: 5,
        skipped: isRerun ? current.onboarding.skipped : true,
        completedAt
      },
      updatedAt: completedAt
    }))
    if (!isRerun) {
      setCreatingCategory(state.categories[0] || null)
      setIsItemCreatorOpen(true)
    }
  }

  function startOnboardingRerun() {
    const startedAt = Date.now()
    setSettingsOpen(false)
    setSettingsClosing(false)
    setState((current) => ({
      ...current,
      onboarding: {
        ...current.onboarding,
        completed: false,
        rerun: true,
        currentStep: 1,
        skipped: false,
        startedAt,
        completedAt: undefined
      },
      updatedAt: startedAt
    }))
  }

  function handleOnboardingComplete(result: OnboardingCompletion) {
    const now = Date.now()
    const createdItems = createColdStartItems(
      result.profile,
      result.selections.map(({ template, inventoryStatus }) => ({ template, inventoryStatus })),
      now
    )
    const selectedTemplateIds = createdItems.flatMap((item) => item.templateId ? [item.templateId] : [])
    const notUsedTemplateIds = Object.entries(result.decisions).filter(([, decision]) => decision === "notUsed").map(([id]) => id)
    const deferredTemplateIds = Object.entries(result.decisions).filter(([, decision]) => decision === "defer").map(([id]) => id)
    setState((current) => {
      const existingTemplateIds = new Set(current.items.flatMap((item) => item.templateId ? [item.templateId] : []))
      const existingNames = new Set(current.items.map((item) => item.name.trim().toLocaleLowerCase("zh-CN")))
      const uniqueItems = createdItems.filter((item) =>
        (!item.templateId || !existingTemplateIds.has(item.templateId)) &&
        !existingNames.has(item.name.trim().toLocaleLowerCase("zh-CN"))
      )
      const newlyCreatedTemplateIds = uniqueItems.flatMap((item) => item.templateId ? [item.templateId] : [])
      const categories = [...new Set([...current.categories, ...uniqueItems.map((item) => item.category)])]
      return {
        ...current,
        categories,
        items: [...current.items, ...uniqueItems],
        householdProfile: { ...result.profile, updatedAt: now },
        onboarding: {
          ...current.onboarding,
          completed: true,
          rerun: false,
          currentStep: 5,
          skipped: false,
          skippedProfile: result.skippedProfile,
          managedTemplateIds: selectedTemplateIds,
          notUsedTemplateIds,
          deferredTemplateIds,
          createdTemplateIds: [...new Set([...(current.onboarding.createdTemplateIds ?? []), ...newlyCreatedTemplateIds])],
          inventoryStatuses: Object.fromEntries(result.selections.map(({ template, inventoryStatus }) => [template.id, inventoryStatus])),
          completedAt: now
        },
        updatedAt: now
      }
    })
  }

  function retryPersistence() {
    const sequence = ++persistenceSequence.current
    void persistState(state).then((issue) => {
      if (sequence !== persistenceSequence.current) return
      setPersistenceIssue(issue)
      setBackupCopyState("idle")
    })
  }

  function copyCurrentDataBackup() {
    setBackupCopyState("idle")
    if (!navigator.clipboard?.writeText) {
      setBackupCopyState("failed")
      return
    }
    void navigator.clipboard.writeText(JSON.stringify(state, null, 2)).then(
      () => setBackupCopyState("copied"),
      () => setBackupCopyState("failed")
    )
  }

  const persistenceAlert = persistenceIssue ? (
    <PersistenceAlert
      issue={persistenceIssue}
      backupState={backupCopyState}
      onRetry={retryPersistence}
      onCopyBackup={copyCurrentDataBackup}
      onDismiss={() => {
        setPersistenceIssue(null)
        setBackupCopyState("idle")
      }}
    />
  ) : null

  if (!state.onboarding.completed) {
    return (
      <>
        {persistenceAlert}
        <OnboardingWizard
          initialProfile={state.householdProfile}
          onboarding={state.onboarding}
          isRerun={state.onboarding.rerun}
          existingTemplateIds={state.items.flatMap((item) => item.templateId ? [item.templateId] : [])}
          onProgress={handleOnboardingProgress}
          onSkip={handleOnboardingSkip}
          onComplete={handleOnboardingComplete}
        />
      </>
    )
  }

  return (
    <div className="app-shell">
      {persistenceAlert}
      <header className="topbar">
        {/* Topbar 保留用于拖拽窗口 */}
      </header>

      <div className="app-body">
        <Sidebar
          dueCount={dueItems.length}
          categorySummaries={categorySummaries}
          allItems={state.items}
          now={now}
          activeCategory={activeCategory}
          onSelectCategory={setActiveCategory}
          onCreateCategory={() => setCategoryCreatorOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onRenameCategory={renameCategory}
          pendingDelete={pendingCategoryDelete}
          onRequestDeleteCategory={setPendingCategoryDelete}
          onCancelDeleteCategory={() => setPendingCategoryDelete(null)}
          onConfirmDeleteCategory={(name, options) => deleteCategory(name, options)}
        />
        <main className="work-area">
          {activeCategory ? (
            <CategoryWorkArea
              category={activeCategory}
              views={itemViews.filter(({ item }) => item.category === activeCategory)}
              onAddItem={() => {
                setCreatingCategory(activeCategory)
                setIsItemCreatorOpen(true)
              }}
              onRename={() => setCategoryDialog("rename")}
              onDelete={() => setPendingCategoryDelete(activeCategory)}
              onEdit={editFromDetail}
              onSnooze={handleSnooze}
              onRestock={handleRestock}
              onCalibrate={calibrateItem}
              onQuickEdit={quickEditItem}
              onApplySuggestion={applyCycleSuggestion}
              onDismissSuggestion={dismissSuggestion}
              onOpenItem={openItem}
              onOpenItemEditor={(itemId) => {
                setEditingItemId(itemId)
                setIsItemEditorDialogOpen(true)
              }}
              onRestockFromOption={handleRestockFromOption}
              showAddPurchaseModal={showAddPurchaseModal}
              setShowAddPurchaseModal={setShowAddPurchaseModal}
              addPurchaseOptionItemId={addPurchaseOptionItemId}
              setAddPurchaseOptionItemId={setAddPurchaseOptionItemId}
              editingPurchaseOption={editingPurchaseOption}
              setEditingPurchaseOption={setEditingPurchaseOption}
              editModalOpen={editModalOpen}
              setEditModalOpen={setEditModalOpen}
              onEditPurchaseOption={handleEditPurchaseOption}
              onDeletePurchaseOption={handleDeletePurchaseOption}
              onSaveEditedOption={handleSaveEditedOption}
              onEditRestockRecord={(itemId, recordId) => setEditingRestockRecord({ itemId, recordId })}
            />
          ) : (
            <CurrentTasks
              items={dueItems}
              snoozedItems={snoozedItems}
              allItems={itemViews}
              onRestock={handleRestock}
              onSnooze={handleSnooze}
              onColdStartFeedback={handleColdStartFeedback}
              onApplySuggestion={applyCycleSuggestion}
              onDismissSuggestion={dismissSuggestion}
              onOpenItem={openItem}
              onAddItem={() => {
                setCreatingCategory(state.categories[0] || null)
                setIsItemCreatorOpen(true)
              }}
              onOpenChat={() => setHouseholdChatOpen(true)}
              onOpenOrderImport={() => setOrderImportOpen(true)}
            />
          )}
          {restockToast && (
            <RestockToast itemName={restockToast.itemName} onDismiss={() => setRestockToast(null)} />
          )}
        </main>
      </div>

      {/* overlays — 全部保留 */}
      {(detailItem || detailPanelClosing) && detailItem && (
        <ItemDetailPanel
          key={detailItem.id}
          item={detailItem}
          computed={computeItem(detailItem, now)}
          isClosing={detailPanelClosing}
          onClose={() => deferredClose(setDetailPanelClosing, () => setDetailItemId(null))}
          onSnooze={handleSnooze}
          onRestock={handleRestock}
          onCalibrate={calibrateItem}
          onApplySuggestion={applyCycleSuggestion}
          onDismissSuggestion={dismissSuggestion}
        />
      )}
      {(editingItem !== undefined || editorClosing) && (
        <ItemEditor item={editingItem ?? null} initialCategory={newItemCategory} categories={state.categories} onAddCategory={addCategory} isClosing={editorClosing} onClose={() => deferredClose(setEditorClosing, () => {
          setEditingItem(undefined)
          setNewItemCategory(undefined)
        })} onSave={saveItem} onDelete={editingItem ? deleteItem : undefined} />
      )}
      {(settingsOpen || settingsClosing) && <SettingsPanel state={state} onChange={commit} onRestartOnboarding={startOnboardingRerun} isClosing={settingsClosing} onClose={() => deferredClose(setSettingsClosing, () => setSettingsOpen(false))} />}
      {(householdChatOpen || householdChatClosing) && (
        <HouseholdChatPanel
          state={state}
          itemViews={itemViews}
	          messages={householdChatMessages}
	          onMessagesChange={setHouseholdChatMessages}
	          onQuestionSent={setHouseholdChatLastQuestion}
	          onConfirmDraft={handleAgentDraftConfirm}
          onOpenItem={(itemId) => {
            deferredClose(setHouseholdChatClosing, () => setHouseholdChatOpen(false))
            setDetailItemId(itemId)
          }}
          onOpenCategory={(category) => {
            deferredClose(setHouseholdChatClosing, () => setHouseholdChatOpen(false))
            setActiveCategory(category)
          }}
          isClosing={householdChatClosing}
          onClose={() => deferredClose(setHouseholdChatClosing, () => setHouseholdChatOpen(false))}
          onOpenSettings={() => {
            deferredClose(setHouseholdChatClosing, () => setHouseholdChatOpen(false))
            setSettingsOpen(true)
          }}
        />
      )}
      {isItemCreatorOpen && (
        <ItemCreatorDialog
          category={creatingCategory || ''}
          isOpen={isItemCreatorOpen}
          onClose={() => {
            setIsItemCreatorOpen(false)
            setCreatingCategory(null)
          }}
          onCreate={(itemData) => {
            const newItem = createItem({
              name: itemData.name,
              category: creatingCategory || '其他',
              cycleDays: itemData.usageIntervalDays || 10,
              bufferDays: itemData.bufferDays !== undefined ? itemData.bufferDays : 2,
              unit: itemData.unit || '件',
              defaultQty: '',
              platform: '',
              link: '',
              remainingDays: itemData.inventoryDays === undefined ? '' : String(itemData.inventoryDays),
              learningEnabled: true
            })
            commit({
              ...state,
              items: [...state.items, newItem],
              categories: state.categories.includes(newItem.category)
                ? state.categories
                : [...state.categories, newItem.category]
            })
          }}
        />
      )}
      {(categoryCreatorOpen || categoryCreatorClosing) && <CategoryCreator existingCategories={state.categories} isClosing={categoryCreatorClosing} onClose={() => deferredClose(setCategoryCreatorClosing, () => setCategoryCreatorOpen(false), 150)} onCreate={(name) => {
        const category = addCategory(name)
        if (!category) return false
        setCategoryCreatorOpen(false)
        return true
      }} />}
      {activeCategory && categoryDialog === "rename" && <CategoryManagerDialog category={activeCategory} categories={state.categories} isClosing={categoryManagerClosing} onClose={() => deferredClose(setCategoryManagerClosing, () => setCategoryDialog(null), 150)} onRename={(name) => renameCategory(activeCategory, name)} />}
      <ItemEditorDialog
        item={state.items.find(i => i.id === editingItemId) || null}
        categories={[...new Set([...state.categories, ...state.items.map((item) => item.category)])]}
        daysUntilDepletion={editingItemId ? computeItem(state.items.find(i => i.id === editingItemId)!, now).daysUntilDepletion : 0}
        isOpen={isItemEditorDialogOpen}
        onClose={() => {
          setIsItemEditorDialogOpen(false)
          setEditingItemId(null)
        }}
        onRename={renameItem}
        onMove={moveItemToCategory}
        onDelete={deleteItemById}
        onQuickEdit={quickEditItem}
        onCalibrate={calibrateItem}
      />
      
      {/* 补货弹窗 */}
      <RestockModal
        isOpen={restockModalOpen}
        onClose={handleCancelRestock}
        item={restockModalItemId ? state.items.find(i => i.id === restockModalItemId) || null : null}
        onConfirm={(itemId, option, qty, price, restockDate, platform, pricingMode, measureBaseAmount, measureAmount, measureUnit, review) => {
          const item = state.items.find((i) => i.id === itemId)
          performRestock(itemId, qty, price || undefined, platform, option?.id, option?.productName, option?.unit || item?.unit, pricingMode, measureBaseAmount, measureAmount, measureUnit, review, restockDate)
          setRestockToast({ itemName: item?.name ?? '' })
          handleCancelRestock()
        }}
        onAddPurchaseOption={(itemId) => {
          // 不关闭 RestockModal，仅打开商品录入弹窗
          setAddPurchaseOptionItemId(itemId)
          setShowAddPurchaseModal(true)
        }}
        preferredPurchaseOptionId={preferredPurchaseOptionId}
        onPreferredPurchaseOptionConsumed={() => setPreferredPurchaseOptionId(null)}
      />

      <RestockRecordEditModal
        isOpen={Boolean(editingRestockRecord && editingRestockItem && editingRestockEvent)}
        item={editingRestockItem}
        record={editingRestockEvent}
        onClose={() => setEditingRestockRecord(null)}
        onSave={(recordId, patch) => {
          if (!editingRestockItem) return
          saveEditedRestockRecord(editingRestockItem.id, recordId, patch)
        }}
      />

      {/* 订单截图批量导入 */}
      <OrderImportModal
        isOpen={orderImportOpen}
        onClose={() => setOrderImportOpen(false)}
        items={state.items}
        categories={state.categories}
        apiKey={state.settings.aiApiKey}
        model={state.settings.aiOrderModel ?? state.settings.aiModel}
        recognitionMode={state.settings.aiOrderMode ?? "accurate"}
        onOpenSettings={() => {
          setOrderImportOpen(false)
          setSettingsOpen(true)
        }}
        onConfirm={handleOrderImportConfirm}
      />

      {/* 添加商品弹窗（统一在 App 根部渲染，供分类页与补货弹窗复用） */}
      <PurchaseOptionModal
        isOpen={showAddPurchaseModal}
        onClose={() => {
          setShowAddPurchaseModal(false)
          setAddPurchaseOptionItemId(null)
        }}
        onSave={(optionData) => {
          if (addPurchaseOptionItemId) {
            handleAddPurchaseOption(addPurchaseOptionItemId, optionData)
          }
        }}
      />

    </div>
  )
}

function RestockToast({ itemName, onDismiss }: { itemName: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 2400)
    return () => clearTimeout(t)
  }, [onDismiss])
  return (
    <div className="restock-toast" role="status" aria-live="polite">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7.25" stroke="currentColor" strokeWidth="1.5" opacity=".4"/>
        <path d="M4.5 8l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span><strong>{itemName}</strong> 已补货</span>
    </div>
  )
}

function cleanChatLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function renderChatAnswer(content: string) {
  const lines = content
    .split(/\n+/)
    .map(cleanChatLine)
    .filter(Boolean)

  if (!lines.length) return <p className="chat-answer-paragraph">没有返回可显示的内容。</p>

  return (
    <div className="chat-answer">
      {lines.map((line, index) => {
        const noteMatch = line.match(/^(提示|建议|下一步|可以这样做|注意)[:：]\s*(.+)$/)
        if (noteMatch) {
          return (
            <div className="chat-answer-note" key={`${line}-${index}`}>
              <b>{noteMatch[1]}</b>
              <span>{noteMatch[2]}</span>
            </div>
          )
        }

        const sectionMatch = line.match(/^(.{2,12})[:：]\s*$/)
        if (sectionMatch) {
          return <strong className="chat-answer-heading" key={`${line}-${index}`}>{sectionMatch[1]}</strong>
        }

        const rowMatch = line.match(/^([^：:]{2,16})[:：]\s*(.+)$/)
        if (rowMatch) {
          return (
            <div className="chat-answer-row" key={`${line}-${index}`}>
              <b>{rowMatch[1]}</b>
              <span>{rowMatch[2]}</span>
            </div>
          )
        }

        return <p className="chat-answer-paragraph" key={`${line}-${index}`}>{line}</p>
      })}
    </div>
  )
}

// 对话创建提案的确认清单：只读展示，修改通过继续对话完成
function ChatActionCard({ actions, status, onConfirm, onCancel }: {
  actions: ChatProposedAction[]
  status: "pending" | "confirmed" | "cancelled" | "superseded"
  onConfirm: () => void
  onCancel: () => void
}) {
  const statusLabel = status === "pending"
    ? `将创建 ${actions.length} 项`
    : status === "confirmed" ? "已创建" : status === "cancelled" ? "已取消" : "已更新为新方案"

  function actionTypeLabel(action: ChatProposedAction): string {
    if (action.type === "createCategory") return "分类"
    if (action.type === "createItem") return "消耗品"
    return "常购商品"
  }

  function actionSummary(action: ChatProposedAction): string {
    if (action.type === "createCategory") return action.name
    if (action.type === "createItem") return `${action.name} · 归入${action.category} · 约 ${action.cycleDays} 天一轮 · 单位 ${action.unit}`
    return `${action.productName} → ${action.itemName}`
  }

  return (
    <div className={`chat-action-card is-${status}`}>
      <div className="chat-action-card-head">
        <span>{statusLabel}</span>
      </div>
      {actions.map((action, index) => (
        <p key={index} className="chat-action-summary">
          <b>{actionTypeLabel(action)}</b>
          {actionSummary(action)}
        </p>
      ))}
      {status === "pending" && (
        <>
          <div className="chat-action-card-actions">
            <button type="button" className="quiet-button compact" onClick={onCancel}>取消</button>
            <button type="button" className="primary-button compact green" onClick={onConfirm}>确认创建</button>
          </div>
          <small className="chat-action-hint">想调整的话直接说，比如「周期改成 90 天」。</small>
        </>
      )}
    </div>
  )
}

function AgentDraftCard({ draft, status, onConfirm, onCancel }: {
  draft: AgentDraft
  status: AgentDraftStatus
  onConfirm: () => void
  onCancel: () => void
}) {
  const statusLabel = status === "pending"
    ? draft.kind === "createItem" ? "待确认创建"
      : draft.kind === "restock" ? "待确认补货记录"
        : draft.kind === "createItemWithRestock" ? "待确认创建并记录"
          : "待确认常购商品"
    : status === "confirmed" ? "已处理" : status === "cancelled" ? "已取消" : "已更新为新草稿"
  const confirmLabel = draft.kind === "createItem"
    ? "确认创建"
    : draft.kind === "restock" ? "确认记录补货"
      : draft.kind === "createItemWithRestock" ? "确认创建并记录"
        : "确认添加常购商品"

  function rows(): Array<[string, string]> {
    if (draft.kind === "createItem") {
      return [
        ["消耗品", draft.itemName],
        ["分类", draft.category],
        ["补货周期", `${draft.cycleDays} 天，提前 ${draft.bufferDays} 天提醒`],
        ["单位", draft.unit]
      ]
    }
    if (draft.kind === "restock") {
      return [
        ["物品", draft.itemName],
        ["数量", draft.qty ? `${draft.qty}${draft.unit || ""}` : "未填写"],
        ["金额", draft.price !== undefined ? `¥${formatPrice(draft.price)}` : "未填写"],
        ["平台", draft.platform || "未填写"],
        ...(draft.cycleDaysPatch ? [["周期调整", `${draft.cycleDaysPatch} 天`] as [string, string]] : [])
      ]
    }
    if (draft.kind === "createItemWithRestock") {
      return [
        ["消耗品", draft.item.itemName],
        ["分类", draft.item.category],
        ["补货周期", `${draft.item.cycleDays} 天，提前 ${draft.item.bufferDays} 天提醒`],
        ["数量", draft.restock.qty ? `${draft.restock.qty}${draft.restock.unit || draft.item.unit}` : "未填写"],
        ["金额", draft.restock.price !== undefined ? `¥${formatPrice(draft.restock.price)}` : "未填写"],
        ["平台", draft.restock.platform || "未填写"],
        ["常购商品", draft.addPurchaseOption?.productName || draft.restock.purchaseProductName || "不登记"]
      ]
    }
    return [
      ["常购商品", draft.productName],
      ["挂到", draft.itemName],
      ["单位", draft.unit || "沿用消耗品单位"]
    ]
  }

  return (
    <div className={`chat-action-card is-${status}`}>
      <div className="chat-action-card-head">
        <span>{statusLabel}</span>
      </div>
      {rows().map(([label, value]) => (
        <p key={label} className="chat-action-summary">
          <b>{label}</b>
          {value}
        </p>
      ))}
      {status === "pending" && (
        <>
          <div className="chat-action-card-actions">
            <button type="button" className="quiet-button compact" onClick={onCancel}>取消</button>
            <button type="button" className="primary-button compact green" onClick={onConfirm}>{confirmLabel}</button>
          </div>
          <small className="chat-action-hint">想调整的话直接说，比如「周期改成 90 天」或「平台是京东」。</small>
        </>
      )}
    </div>
  )
}

function HouseholdChatPanel({ state, itemViews, messages, onMessagesChange, onQuestionSent, onConfirmDraft, onOpenItem, onOpenCategory, onClose, onOpenSettings, isClosing }: {
  state: AppState
  itemViews: ItemView[]
  messages: HouseholdChatMessage[]
  onMessagesChange: (messages: HouseholdChatMessage[]) => void
  onQuestionSent: (question: string) => void
  onConfirmDraft: (draft: AgentDraft) => { summary: string; links: AgentMessageLink[] }
  onOpenItem: (itemId: string) => void
  onOpenCategory: (category: string) => void
  onClose: () => void
  onOpenSettings: () => void
  isClosing?: boolean
}) {
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const starter = buildHouseholdChatStarter(itemViews)
	  const quickQuestions = [
	    "今天优先补什么？",
	    "哪些东西可以暂时不用管？",
	    "最近价格记录有什么异常？",
	    "帮我添加一个消耗品"
	  ]
	  function latestPendingDraftMessageIndex(list: HouseholdChatMessage[]): number {
	    for (let index = list.length - 1; index >= 0; index -= 1) {
	      if (list[index].role === "assistant" && list[index].draftStatus === "pending" && list[index].agentDraft) return index
	    }
	    return -1
	  }

	  function draftIntro(agentDraft: AgentDraft): string {
	    if (agentDraft.kind === "createItem") return "我整理成了一个待确认的消耗品草稿。"
	    if (agentDraft.kind === "restock") return "我整理成了一条待确认的补货记录。"
	    if (agentDraft.kind === "createItemWithRestock") return "我整理成了一个待确认的创建并补货草稿。"
	    return "我整理成了一个待确认的常购商品草稿。"
	  }

	  function buildPendingDraftReminder(agentDraft: AgentDraft): string {
	    return [
	      "还没有真正写入。",
	      `当前草稿：${describeAgentDraft(agentDraft)}。`,
	      "下一步：点卡片里的确认按钮，或直接输入「确认记录」。"
	    ].join("\n")
	  }

	  function safeQueryFallback(content: string): string {
	    const text = content.trim()
	    if (!text) return "我没能整理出可靠回答，请换一句问法。"
	    if (/已创建|已记录|已更新|已登记|已为您|已帮/.test(text)) return "我没能整理成可确认草稿，请换一句描述。"
	    return text
	  }

	  function confirmAgentDraft(messageIndex: number, baseMessages = messages) {
	    const message = baseMessages[messageIndex]
	    if (!message?.agentDraft) return
	    const result = onConfirmDraft(message.agentDraft)
	    onMessagesChange([
	      ...baseMessages.map((current, index) => index === messageIndex
	        ? { ...current, draftStatus: "confirmed" as const }
	        : current),
	      { role: "assistant" as const, content: result.summary, links: result.links }
	    ])
	  }

	  function cancelAgentDraft(messageIndex: number, baseMessages = messages) {
	    onMessagesChange(baseMessages.map((message, index) => index === messageIndex
	      ? { ...message, draftStatus: "cancelled" as const }
	      : message))
	  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, loading])

	  async function sendMessage(value = draft) {
	    const text = value.trim()
	    if (!text) {
	      setError("先输入一个想了解的问题。")
	      inputRef.current?.focus()
	      return
	    }
	    const nextMessages: HouseholdChatMessage[] = [...messages, { role: "user", content: text }]
	    onMessagesChange(nextMessages)
	    onQuestionSent(text)
	    setDraft("")
	    setError(null)
	    const pendingMessageIndex = latestPendingDraftMessageIndex(messages)
	    const pendingDraft = pendingMessageIndex >= 0 ? messages[pendingMessageIndex].agentDraft : undefined
	    const intent = classifyAgentIntent(text, Boolean(pendingDraft))
	    if (pendingDraft && intent === "confirmDraft") {
	      confirmAgentDraft(pendingMessageIndex, nextMessages)
	      return
	    }
	    if (pendingDraft && intent === "cancelDraft") {
	      cancelAgentDraft(pendingMessageIndex, nextMessages)
	      return
	    }
	    if (pendingDraft && intent === "pendingStatus") {
	      onMessagesChange([...nextMessages, { role: "assistant", content: buildPendingDraftReminder(pendingDraft) }])
	      return
	    }
	    if (pendingDraft && intent === "reviseDraft") {
	      const revised = reviseAgentDraft(pendingDraft, text)
	      if (revised) {
	        const base = nextMessages.map((message, index) => index === pendingMessageIndex
	          ? { ...message, draftStatus: "superseded" as const }
	          : message)
	        onMessagesChange([...base, { role: "assistant", content: "好的，我更新了待确认草稿。", agentDraft: revised, draftStatus: "pending" as const }])
	      } else {
	        onMessagesChange([...nextMessages, { role: "assistant", content: buildPendingDraftReminder(pendingDraft) }])
	      }
	      return
	    }
	    if (intent === "writeDraft") {
	      const localDraft = buildLocalDraftFromText(text, state)
	      if (localDraft) {
	        onMessagesChange([...nextMessages, { role: "assistant", content: draftIntro(localDraft), agentDraft: localDraft, draftStatus: "pending" as const }])
	        return
	      }
	    }
	    const quickAnswer = pendingDraft || shouldSkipQuickAnswerForAgent(text) ? null : answerHouseholdQuickly(text, state, itemViews)
	    if (quickAnswer) {
	      onMessagesChange([...nextMessages, { role: "assistant", content: quickAnswer }])
	      return
    }
    if (!state.settings.aiApiKey?.trim()) {
      setError("还没有设置 AI API Key。这个问题需要模型分析，设置后就可以继续问。")
      inputRef.current?.focus()
      return
    }
    setLoading(true)
    const result = await askHouseholdAssistant({
      apiKey: state.settings.aiApiKey,
      model: state.settings.aiChatModel ?? state.settings.aiModel,
	      state,
	      itemViews,
	      messages: nextMessages,
	      pendingDraft
	    })
	    if (result.ok) {
	      setLoading(false)
		      const parsed = parseAgentResponse(result.content.trim(), state)
		      if (!parsed) {
		        onMessagesChange([...nextMessages, {
		          role: "assistant",
		          content: intent === "writeDraft" || pendingDraft
		            ? (pendingDraft ? buildPendingDraftReminder(pendingDraft) : "我没能整理成可确认草稿，请换一句描述。")
		            : safeQueryFallback(result.content)
		        }])
		        return
		      }
	      if (parsed.kind === "draft") {
	        const base = nextMessages.map((message, index) => index === pendingMessageIndex
	          ? { ...message, draftStatus: "superseded" as const }
	          : message)
	        onMessagesChange([...base, { role: "assistant", content: draftIntro(parsed.draft), agentDraft: parsed.draft, draftStatus: "pending" as const }])
	      } else {
	        if (intent === "writeDraft" || pendingDraft) {
	          onMessagesChange([...nextMessages, { role: "assistant", content: pendingDraft ? buildPendingDraftReminder(pendingDraft) : "我没能整理成可确认草稿，请换一句描述。" }])
	        } else {
	          onMessagesChange([...nextMessages, { role: "assistant", content: parsed.answer }])
	        }
	      }
	    } else {
	      setLoading(false)
	      onMessagesChange(nextMessages)
      setError(result.error)
      inputRef.current?.focus()
    }
  }

	  function submit(event: FormEvent) {
    event.preventDefault()
    if (!loading) void sendMessage()
  }

  return (
    <div className={`overlay chat-overlay ${isClosing ? "is-closing" : ""}`}>
      <aside className={`panel chat-panel ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="household-chat-title">
        <div className="panel-header chat-panel-header">
          <div className="panel-header-info">
            <h2 id="household-chat-title">问问当前库存和补货</h2>
          </div>
          <button className="icon-button close-btn" aria-label="关闭家庭问答" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="chat-panel-body">
          <div className="chat-log" ref={logRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <strong>{starter}</strong>
                <div className="chat-suggestions">
                  {quickQuestions.map((question) => (
                    <button key={question} type="button" onClick={() => void sendMessage(question)} disabled={loading}>{question}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`chat-message ${message.role}`}>
                  {message.role === "assistant" ? (
                    <div className="chat-message-content">{renderChatAnswer(message.content)}</div>
                  ) : (
                    <p>{message.content}</p>
                  )}
	                  {message.role === "assistant" && message.agentDraft && (
	                    <AgentDraftCard
	                      draft={message.agentDraft}
	                      status={message.draftStatus || "pending"}
	                      onConfirm={() => confirmAgentDraft(index)}
	                      onCancel={() => cancelAgentDraft(index)}
	                    />
	                  )}
                  {message.role === "assistant" && message.links && message.links.length > 0 && (
                    <div className="chat-message-links">
                      {message.links.map((link, linkIndex) => (
                        <button
                          key={linkIndex}
                          type="button"
                          className="chat-link-button"
                          onClick={() => link.target.kind === "item" ? onOpenItem(link.target.itemId) : onOpenCategory(link.target.category)}
                        >
                          {link.label} →
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            {loading && (
              <div className="chat-message assistant is-loading">
                <p>正在查看当前记录…</p>
              </div>
            )}
          </div>
        </div>

        <form className="chat-composer" onSubmit={submit}>
          {error && (
            <div className="chat-error" role="alert">
              <span>{error}</span>
              {!state.settings.aiApiKey?.trim() && <button type="button" onClick={onOpenSettings}>去设置</button>}
            </div>
          )}
          <div className="chat-input-row">
            <textarea
              id="household-chat-input"
              ref={inputRef}
              value={draft}
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (!loading) void sendMessage()
                }
              }}
              placeholder=""
            />
            <button type="submit" className="primary-button chat-send-button" disabled={loading}>
              {loading && <span className="chat-send-spinner" aria-hidden="true" />}
              发送
            </button>
          </div>
        </form>
      </aside>
    </div>
  )
}

const measureUnitDefinitions = [
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

const pricingModeLabels = {
  spec: "按规格计价",
  measure: "按含量计价"
} as const

const purchaseSpecUnitOptions = ["袋", "瓶", "包", "盒", "支", "卷", "桶", "罐", "个", "只", "片", "板", "箱", "提", "件"] as const

function encodeCustomMeasureUnit(name: string, dimension: string, factor: number): string {
  return `custom:${name.trim()}:${dimension}:${factor}`
}

function parseCustomMeasureUnit(value?: string) {
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

function getMeasureUnitDefinition(value?: string) {
  if (!value) return undefined
  const customUnit = parseCustomMeasureUnit(value)
  if (customUnit) return customUnit
  const normalized = value.trim()
  return measureUnitDefinitions.find((definition) =>
    definition.value === normalized || definition.aliases.some((alias) => alias.toLowerCase() === normalized.toLowerCase())
  )
}

function getMeasureDimensionBaseUnit(dimension: string): string {
  if (dimension === "mass") return "克"
  if (dimension === "volume") return "毫升"
  return "个"
}

function getMeasureUnitDisplay(value?: string): string {
  return getMeasureUnitDefinition(value)?.label || value || "计量单位"
}

function getMeasureUnitShortLabel(value?: string): string {
  return getMeasureUnitDefinition(value)?.shortLabel || value || "单位"
}

function formatMeasureQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : formatCompactPrice(value)
}

function getPurchaseOptionPricingMode(option: PurchaseOption | undefined): PricingMode {
  return option?.pricingMode || (option?.measureUnit ? "measure" : "spec")
}

function getMeasureBaseAmount(option: PurchaseOption | undefined): number {
  if (option?.measureBaseAmount && option.measureBaseAmount > 0) return option.measureBaseAmount
  return getMeasureUnitDefinition(option?.measureUnit)?.defaultBaseAmount || 1
}

function formatPricingUnit(amount: number | undefined, unit: string | undefined): string {
  const safeAmount = amount && amount > 0 ? amount : 1
  const unitLabel = getMeasureUnitShortLabel(unit)
  return safeAmount === 1 ? unitLabel : `${formatMeasureQuantity(safeAmount)}${unitLabel}`
}

function getPurchaseOptionPricingLabel(option: PurchaseOption | undefined, item?: ReplenishmentItem): string {
  const unit = option?.unit || item?.unit || "件"
  const mode = getPurchaseOptionPricingMode(option)
  if (mode === "measure") return `${unit} · 按${formatPricingUnit(getMeasureBaseAmount(option), option?.measureUnit)}计价`
  return `${unit} · 按规格计价`
}

function getCompatibleMeasureUnits(commonUnit?: string) {
  const definition = getMeasureUnitDefinition(commonUnit)
  if (!definition) return measureUnitDefinitions
  const units = definition.dimension === "count"
    ? measureUnitDefinitions.filter((unit) => unit.dimension === "count")
    : measureUnitDefinitions.filter((unit) => unit.dimension === definition.dimension)
  return units.some((unit) => unit.value === definition.value) ? units : [...units, definition]
}

function convertMeasureAmount(amount: number | undefined, fromUnit: string | undefined, toUnit: string | undefined): number | undefined {
  if (!Number.isFinite(amount) || amount! <= 0) return undefined
  const from = getMeasureUnitDefinition(fromUnit)
  const to = getMeasureUnitDefinition(toUnit)
  if (!from || !to || from.dimension !== to.dimension) return undefined
  return amount! * from.factor / to.factor
}

function findRecordOption(item: ReplenishmentItem, record: RestockEvent): PurchaseOption | undefined {
  const options = item.purchaseOptions || []
  return options.find((option) => option.id === record.purchaseOptionId) ||
    options.find((option) => option.productName === record.purchaseProductName) ||
    (!record.purchaseProductName && options.length === 1 ? options[0] : undefined)
}

function isRecordForOption(record: RestockEvent, option: PurchaseOption): boolean {
  return record.purchaseOptionId === option.id || (!record.purchaseOptionId && record.purchaseProductName === option.productName)
}

function getRestockUnitPriceInfo(item: ReplenishmentItem, option: PurchaseOption | undefined, record: RestockEvent): { label: string; value: number; unit: string } | null {
  const matchedOption = option || findRecordOption(item, record)
  if (!matchedOption || !record.price || record.price <= 0 || !record.qty || record.qty <= 0) return null
  const currentMode = getPurchaseOptionPricingMode(matchedOption)
  const recordMode = record.purchasePricingMode || (record.purchaseMeasureAmount ? "measure" : "spec")
  if (recordMode !== currentMode) return null
  if (currentMode === "spec") {
    const value = record.price / record.qty
    const unit = record.purchaseUnit || matchedOption.unit || item.unit || "件"
    return { label: formatUnitPrice(value, unit), value, unit }
  }
  const commonUnit = matchedOption.measureUnit
  if (!commonUnit) return null
  const normalizedAmount = convertMeasureAmount(record.purchaseMeasureAmount, record.purchaseMeasureUnit, commonUnit)
  if (!normalizedAmount) return null
  const totalAmount = normalizedAmount * record.qty
  if (!totalAmount) return null
  const baseAmount = getMeasureBaseAmount(matchedOption)
  const value = record.price / totalAmount * baseAmount
  const unit = formatPricingUnit(baseAmount, commonUnit)
  return { label: formatUnitPrice(value, unit), value, unit }
}

function getOptionHistoricalLowest(item: ReplenishmentItem, option: PurchaseOption): { label: string; value: number; unit: string } | null {
  const entries = item.history
    .filter((record) => isRecordForOption(record, option))
    .map((record) => getRestockUnitPriceInfo(item, option, record))
    .filter((entry): entry is { label: string; value: number; unit: string } => entry !== null)
  if (!entries.length) return null
  return entries.reduce((lowest, entry) => entry.value < lowest.value ? entry : lowest, entries[0])
}

function getOptionLatestReview(item: ReplenishmentItem, option: PurchaseOption): string | undefined {
  return item.history
    .slice()
    .reverse()
    .find((record) => isRecordForOption(record, option) && record.review?.trim())
    ?.review?.trim()
}

function getRecordMeasureUnit(item: ReplenishmentItem, record: RestockEvent): string | undefined {
  if ((record.purchasePricingMode || (record.purchaseMeasureAmount ? "measure" : "spec")) === "spec") {
    return undefined
  }
  if (record.purchaseMeasureAmount && record.purchaseMeasureUnit) {
    return `${formatMeasureQuantity(record.purchaseMeasureAmount)} ${getMeasureUnitDisplay(record.purchaseMeasureUnit)}/${record.purchaseUnit || item.unit || '件'}`
  }
  const option = findRecordOption(item, record)
  return getPurchaseOptionPricingMode(option) === "measure" ? `按${formatPricingUnit(getMeasureBaseAmount(option), option?.measureUnit)}计价` : undefined
}

function getReviewPreview(review: string): { text: string; isTruncated: boolean } {
  const trimmed = review.trim()
  if (trimmed.length <= 10) return { text: trimmed, isTruncated: false }
  return { text: `${trimmed.slice(0, 10)}…`, isTruncated: true }
}

function CategoryCreator({ existingCategories, onClose, onCreate, isClosing }: {
  existingCategories: string[]
  onClose: () => void
  onCreate: (name: string) => boolean
  isClosing?: boolean
}) {
  const [name, setName] = useState("")
  const normalized = name.trim()
  const duplicated = existingCategories.includes(normalized)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!normalized || duplicated) return
    onCreate(normalized)
  }

  return (
    <div className={`overlay category-creator-overlay ${isClosing ? "is-closing" : ""}`}>
      <form className={`category-creator ${isClosing ? "is-closing" : ""}`} onSubmit={submit}>
        <div className="category-creator-header">
          <h2>添加分类</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </div>
        <label className="field"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：宝宝用品" /></label>
        {duplicated && <p className="category-creator-tip error">这个分类已经有了</p>}
        <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button green" disabled={!normalized || duplicated}>添加</button></div>
      </form>
    </div>
  )
}

type ItemView = { item: ReplenishmentItem; computed: ItemComputed }

function TaskActions({ item, onRestock, onDismiss, isExpanded }: {
  item: ReplenishmentItem
  onRestock: (item: ReplenishmentItem) => void
  onDismiss?: () => void
  isExpanded?: boolean
}) {
  const latestRating = getLatestRating(item)
  if (isExpanded && onDismiss) {
    return (
      <div className="task-actions">
        <button className="task-action collapse" onClick={onDismiss}>收起</button>
      </div>
    )
  }
  return (
    <div className="task-actions">
      {latestRating === 1 && <span className="rating-warning" title="上次评价较差">⚠ 上次较差</span>}
      <button className="task-action done" onClick={() => onRestock(item)}>补货</button>
    </div>
  )
}

function CurrentTasks({ items, snoozedItems, allItems, onRestock, onSnooze, onColdStartFeedback, onApplySuggestion, onDismissSuggestion, onOpenItem, onAddItem, onOpenChat, onOpenOrderImport }: {
  items: ItemView[]
  snoozedItems: ItemView[]
  allItems: ItemView[]
  onRestock: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onColdStartFeedback: (item: ReplenishmentItem, feedback: ColdStartFeedback) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onOpenItem: (item: ReplenishmentItem) => void
  onAddItem: () => void
  onOpenChat: () => void
  onOpenOrderImport: () => void
}) {
  const hasCurrentTasks = items.length > 0
  const hasSnoozedTasks = snoozedItems.length > 0
  const hasAnyTasks = hasCurrentTasks || hasSnoozedTasks
  const hasNoItemsAtAll = allItems.length === 0
  const quickActions = (
    <div className="home-quick-actions" aria-label="首页快捷操作">
      <button type="button" className="quiet-button home-chat-trigger" onClick={onOpenChat}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.6 8.6 0 0 1-7.7 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.5A8.4 8.4 0 0 1 4 11.6 8.6 8.6 0 0 1 12.6 3 8.4 8.4 0 0 1 21 11.5Z" /><path d="M8.5 10.5h7" /><path d="M8.5 14h4.5" /></svg>
        问问家里现在情况
      </button>
      {!hasNoItemsAtAll && (
        <button type="button" className="quiet-button order-import-trigger" onClick={onOpenOrderImport}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
          从订单截图导入
        </button>
      )}
    </div>
  )

  return (
    <div className={`current-section${!hasAnyTasks ? " is-empty" : ""}`}>
      {!hasAnyTasks && quickActions}
      {hasAnyTasks && (
        <section className="task-module" aria-labelledby="current-title">
          <div className="current-heading">
            <h2 id="current-title">当前待处理 <span>{items.length} 项</span></h2>
            {quickActions}
          </div>
          {hasCurrentTasks && (
            <div className="current-list">
              {items.map(({ item, computed }, i) => {
                const isLowConfidence = item.source === "onboarding" && item.confidence === "low"
                return (
                  <div key={item.id} className="current-card-group" style={{ "--index": i } as React.CSSProperties}>
                    <article className={`current-card ${computed.status}`}>
                      <button type="button" className="current-card-copy current-card-open" onClick={() => onOpenItem(item)} aria-label={`查看${item.name}详情`}>
                        <span className={`status-dot ${computed.status}`} />
                        <span>
                          <span className="current-card-title-row">
                            <strong className="current-item-title">{item.name}</strong>
                            <span className="current-category-badge">{item.category || "未分类"}</span>
                          </span>
                          {isLowConfidence && <span className="cold-start-prompt"><b>可能快到补货周期了</b><em>现在还够用吗？</em></span>}
                          <small>{formatItemStatusText(item, computed)}<span className="inline-detail-cue">查看详情</span></small>
                        </span>
                      </button>
                      {isLowConfidence ? (
                        <div className="cold-start-feedback" aria-label={`${item.name}库存反馈`}>
                          <button onClick={() => onColdStartFeedback(item, "plenty")}>还很多</button>
                          <button onClick={() => onColdStartFeedback(item, "low")}>快没了</button>
                          <button className="is-primary" onClick={() => onRestock(item)}>已补货</button>
                          <button onClick={() => onColdStartFeedback(item, "later")}>稍后提醒</button>
                        </div>
                      ) : (
                        <div className="current-card-controls">
                          <button className="task-snooze-link" onClick={() => onSnooze(item)}>稍后提醒</button>
                          <TaskActions item={item} onRestock={onRestock} />
                        </div>
                      )}
                    </article>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {hasSnoozedTasks && (
        <section className="task-module snoozed-module" aria-labelledby="snoozed-title">
          <div className="current-heading"><h2 id="snoozed-title">稍后待处理</h2><span>{snoozedItems.length} 项</span></div>
          <div className="current-list snoozed-list">
            {snoozedItems.map(({ item, computed }, i) => {
              return (
                <div key={item.id} className="current-card-group" style={{ "--index": i } as React.CSSProperties}>
                  <article className="current-card snoozed-card">
                    <button type="button" className="current-card-copy current-card-open" onClick={() => onOpenItem(item)} aria-label={`查看${item.name}详情`}>
                      <span className="status-dot snoozed" />
                      <span>
                        <span className="current-card-title-row">
                          <strong className="current-item-title">{item.name}</strong>
                          <span className="current-category-badge">{item.category || "未分类"}</span>
                        </span>
                        <small>{formatItemStatusText(item, computed)}<span className="inline-detail-cue">查看详情</span></small>
                        <small className="snooze-until">将在 {formatDateTime(item.snoozeUntil!)} 重新提醒</small>
                      </span>
                    </button>
                    <div className="current-card-controls">
                      <TaskActions item={item} onRestock={onRestock} />
                    </div>
                  </article>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {hasNoItemsAtAll ? (
        <div className="all-good-msg">
          <img src={catIcon} alt="家庭管家" className="all-good-cat" />
          <strong style={{ fontSize: 18, color: "var(--ink)" }}>先添加一个你家经常忘记补货的东西</strong>
          <span style={{ color: "var(--faint)" }}>例如：纸巾、洗衣液、牙膏、猫粮</span>
          <button className="primary-button green" style={{ marginTop: 12 }} onClick={onAddItem}>添加消耗品</button>
        </div>
      ) : !hasAnyTasks && (
        <div className="all-good-msg">
          <img src={catIcon} alt="家庭管家" className="all-good-cat" />
          <span>家里的消耗品都很充足，继续保持！</span>
        </div>
      )}
    </div>
  )
}



function CategoryCard({ category, views, urgent, warning, index = 0, onOpen, onRename, onDelete }: {
  category: string
  views: ItemView[]
  urgent: number
  warning: number
  index?: number
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(category)
  const [popoverAlign, setPopoverAlign] = useState<"right" | "left">("right")
  const [popoverTop, setPopoverTop] = useState<number | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const editBtnRef = useRef<HTMLSpanElement>(null)

  // 计算最近到期的消耗品（按 dueAt 排序取第一个）
  const nextDue = views.length > 0
    ? [...views].sort((a, b) => a.computed.dueAt - b.computed.dueAt)[0]
    : null

  const signal = !views.length
    ? { tone: "empty" as const, label: "暂无记录" }
    : urgent
      ? { tone: "urgent" as const, label: `${urgent} 项预计已用完` }
      : warning
        ? { tone: "warning" as const, label: `${warning} 项快用完` }
        : { tone: "normal" as const, label: "充足" }

  const hasItems = views.length > 0

  function openPopover(e: React.MouseEvent) {
    e.stopPropagation()
    // Check if popover would overflow viewport
    if (cardRef.current) {
      const cardRect = cardRef.current.getBoundingClientRect()
      const popoverWidth = 200
      const rightEdge = cardRect.right - 8
      const viewportWidth = window.innerWidth
      setPopoverAlign(rightEdge - popoverWidth < 0 ? "left" : "right")
    }
    // Position popover just below the edit button instead of below the card
    if (editBtnRef.current && cardRef.current) {
      const btnRect = editBtnRef.current.getBoundingClientRect()
      const wrapRect = cardRef.current.getBoundingClientRect()
      setPopoverTop(btnRect.bottom - wrapRect.top + 4)
    } else {
      setPopoverTop(null)
    }
    setPopoverOpen(true)
    setEditingName(false)
    setNameValue(category)
  }

  function handleSaveName() {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== category) onRename(trimmed)
    setEditingName(false)
    setPopoverOpen(false)
  }

  function handleDelete() {
    onDelete()
    setPopoverOpen(false)
  }

  // Close popover when clicking outside
  useEffect(() => {
    if (!popoverOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [popoverOpen])

  return (
    <div className="category-card-wrap" ref={cardRef} style={{ "--index": index } as React.CSSProperties}>
      <button className={`category-card ${popoverOpen ? "is-active" : ""} ${signal.tone === "urgent" ? "has-urgent" : ""}`} onClick={onOpen}>
        <span className="category-card-top">
          <strong className="category-card-title">{category}</strong>
          <span className="category-card-actions">
            <span className="category-card-edit" ref={editBtnRef} onClick={openPopover}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg></span>
            <span className="category-card-count">{views.length} 项</span>
          </span>
        </span>
        <span className="category-card-bottom">
          <span className={`category-card-signal ${signal.tone}`}>
            <span className={`status-dot ${signal.tone}`} />
            <strong>{signal.label}</strong>
          </span>
          {nextDue && !nextDue.computed.isDue && (
            <span className="category-card-next">
              下一个：{nextDue.item.name} · {nextDue.computed.remainingText}
            </span>
          )}
        </span>
      </button>
      {popoverOpen && (
        <div className={`category-card-popover ${popoverAlign}`} onClick={(e) => e.stopPropagation()} ref={popoverRef} style={popoverTop != null ? { top: popoverTop } : undefined}>
          {editingName ? (
            <div className="category-card-rename">
              <input autoFocus type="text" value={nameValue} onChange={(e) => setNameValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSaveName() } if (e.key === "Escape") setEditingName(false) }} placeholder="分类名称" />
              <div className="category-card-rename-actions">
                <button className="quiet-button" onClick={() => setEditingName(false)}>取消</button>
                <button className="primary-button" onClick={handleSaveName} disabled={!nameValue.trim() || nameValue.trim() === category}>保存</button>
              </div>
            </div>
          ) : (
            <div className="category-card-menu">
              <button onClick={() => setEditingName(true)}>编辑名称</button>
              <button className="danger" onClick={handleDelete}>删除分类</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CategoryPanel({ category, views, onClose, onAddItem, onEdit, onDeleteItem, onSnooze, onRestock, onQuickEdit, onApplySuggestion, onDismissSuggestion, onRateEvent, isClosing }: {
  category: string
  views: ItemView[]
  onClose: () => void
  onAddItem: () => void
  onEdit: (item: ReplenishmentItem) => void
  onDeleteItem?: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onQuickEdit: (item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform">>) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onRateEvent: (itemId: string, eventId: string, rating?: Rating, review?: string) => void
  isClosing?: boolean
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<{ id: string; field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "platform" } | null>(null)
  const [editValue, setEditValue] = useState("")
  const [ratingEventId, setRatingEventId] = useState<string | null>(null)
  const [ratingItemId, setRatingItemId] = useState<string | null>(null)
  const [ratingDraft, setRatingDraft] = useState<{ review: string }>({ review: "" })
  const [itemDeleteId, setItemDeleteId] = useState<string | null>(null)
  const [savedFieldKey, setSavedFieldKey] = useState<string | null>(null)
  const urgent = views.filter(({ computed }) => computed.status === "urgent" && computed.isDue).length
  const warning = views.filter(({ computed }) => computed.status === "warning" && computed.isDue).length

  // Escape key to collapse expanded item
  useEffect(() => {
    if (expandedId === null) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setExpandedId(null)
        setEditingField(null)
        setItemDeleteId(null)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [expandedId])

  function toggleExpand(item: ReplenishmentItem, computed: ItemComputed) {
    if (expandedId === item.id) {
      setExpandedId(null)
      setEditingField(null)
    } else {
      setExpandedId(item.id)
      setEditingField(null)
    }
  }

  function startEditing(itemId: string, field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "platform", currentValue: number | string) {
    setEditingField({ id: itemId, field })
    setEditValue(String(currentValue))
  }

  function flashSaved(key: string) {
    setSavedFieldKey(key)
    setTimeout(() => setSavedFieldKey(null), 1200)
  }

  function saveEditing(item: ReplenishmentItem) {
    if (!editingField) return
    if (editingField.field === "link") {
      onQuickEdit(item, { link: editValue || undefined })
      flashSaved(`${item.id}-link`)
      setEditingField(null)
      return
    }
    if (editingField.field === "defaultQty") {
      const trimmed = editValue.trim()
      const num = Number(trimmed)
      onQuickEdit(item, { defaultQty: trimmed && Number.isFinite(num) && num > 0 ? Math.round(num) : undefined })
      flashSaved(`${item.id}-defaultQty`)
      setEditingField(null)
      return
    }
    const num = Number(editValue)
    if (isNaN(num) || num < 1) { setEditingField(null); return }
    if (editingField.field === "cycleDays") {
      onQuickEdit(item, { cycleDays: Math.max(1, num) })
      flashSaved(`${item.id}-cycleDays`)
    } else {
      onQuickEdit(item, { bufferDays: Math.max(0, num) })
      flashSaved(`${item.id}-bufferDays`)
    }
    setEditingField(null)
  }

  function submitRating(itemId: string, eventId: string) {
    if (!ratingDraft.review.trim()) return
    onRateEvent(itemId, eventId, undefined, ratingDraft.review)
    setRatingEventId(null)
    setRatingItemId(null)
    setRatingDraft({ review: "" })
  }

  return (
    <div className={`overlay ${isClosing ? "is-closing" : ""}`}>
      <aside className={`panel category-panel ${isClosing ? "is-closing" : ""}`}>
        <div className="panel-header">
          <div className="panel-header-top">
            <h2>{category}</h2>
            <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
          </div>
          <div className="panel-header-bottom">
            <span className="category-summary-text">{views.length} 项</span>
            <button className="primary-button green" onClick={onAddItem}>添加</button>
          </div>
        </div>
        <div className="category-item-list">
          {views.map(({ item, computed }) => (
            <div key={item.id} className={`category-item-group ${expandedId === item.id ? "is-expanded" : ""}`}>
              <button className={`category-item ${expandedId === item.id ? "is-expanded" : ""}`} onClick={() => toggleExpand(item, computed)}>
                <span className={`status-dot ${computed.displayStatus}`} />
                <span className="category-item-copy"><strong>{item.name}</strong><small>{computed.remainingText}</small></span>
                <span className={`status-label ${computed.displayStatus}`}>{computed.statusLabel}</span>
                <span className={`category-item-arrow ${expandedId === item.id ? "is-open" : ""}`}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></span>
              </button>
              {expandedId === item.id && (
                <div className="category-item-detail">
                  {computed.status !== "normal" && (
                    <div className="category-detail-actions">
                      <TaskActions item={item} onRestock={onRestock} />
                    </div>
                  )}
                  <div className="detail-purchase-info">
                    <h3 className="detail-section-title">补货设置</h3>
                    <div className="detail-link-row">
                      <span className="detail-link-label">默认购买量</span>
                      {editingField?.id === item.id && editingField.field === "defaultQty" ? (
                        <div className="inline-edit inline-edit-wide">
                          <div className="input-suffix"><input autoFocus type="number" min="0" value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => saveEditing(item)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEditing(item) } if (e.key === "Escape") setEditingField(null) }} placeholder="选填" /><b>{item.unit || "件"}</b></div>
                        </div>
                      ) : (
                        <button className="detail-link-value" onClick={() => startEditing(item.id, "defaultQty", item.defaultQty ? String(item.defaultQty) : "")}>
                          {item.defaultQty ? <span className="detail-link-text">{item.defaultQty} {item.unit || "件"}</span> : <span className="detail-link-empty">未设置，点击添加</span>}
                          <Icon name="edit" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  {item.history.length > 0 && (
                    <div className="detail-history">
                      <h3>最近补货</h3>
                      {item.history.slice(-4).reverse().map((event, idx) => {
                        const unit = event.purchaseUnit || item.unit || "件"
                        const measureUnit = getRecordMeasureUnit(item, event)
                        return (
                          <div key={event.id} className="history-row">
                            <span>{formatDate(event.at)}</span>
                            <small>
                              {event.intervalDays ? `相隔 ${event.intervalDays} 天` : "首次记录"}
                              {event.price !== undefined && ` · ¥${formatPrice(event.price)}`}
                              {event.qty && `（${event.qty}${unit}`}
                              {event.qty && measureUnit && ` · ${measureUnit}`}
                              {event.price !== undefined && event.qty && ` · ${formatUnitPrice(event.price / event.qty, unit)}`}
                              {event.qty && `）`}
                              {event.platform && <span className="platform-tag">{event.platform}</span>}
                              {event.rating && <span className={`rating-tag rating-${event.rating}`}>{event.rating === 3 ? "👍" : event.rating === 2 ? "😐" : "👎"}</span>}
                            </small>
                            {!event.rating && (
                              <button className={idx === 0 ? "primary-button compact" : "rate-button"} onClick={() => { setRatingEventId(event.id); setRatingItemId(item.id) }}>评价</button>
                            )}
                            {ratingEventId === event.id && ratingItemId === item.id && (
                              <div className="rating-form">
                                <span>这次买的怎么样？</span>
                                <textarea className="review-textarea" value={ratingDraft.review} onChange={(e) => setRatingDraft({ review: e.target.value })} placeholder="请输入您的评价..." rows={4} />
                                <button className="primary-button compact" onClick={() => submitRating(item.id, event.id)} disabled={!ratingDraft.review.trim()}>保存</button>
                                <button className="quiet-button compact" onClick={() => { setRatingEventId(null); setRatingItemId(null) }}>取消</button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {item.suggestedCycleDays && (
                    <div className="suggestion">
                      <span>最近几次大约每 {item.suggestedCycleDays} 天补一次，要把原来的 {item.cycleDays} 天改掉吗？</span>
                      <button onClick={() => onApplySuggestion(item)}>调整</button>
                      <button className="text-button" onClick={() => onDismissSuggestion(item)}>暂不</button>
                    </div>
                  )}
                  <div className="item-action-row">
                    <button className="text-button" onClick={() => onEdit(item)}>编辑名称与设置</button>
                    {onDeleteItem && (
                      itemDeleteId === item.id ? (
                        <div className="item-delete-confirm">
                          <span>确认删除？</span>
                          <button className="text-button" onClick={() => setItemDeleteId(null)}>取消</button>
                          <button className="text-button danger" onClick={() => { onDeleteItem(item); setItemDeleteId(null); setExpandedId(null) }}>确认删除</button>
                        </div>
                      ) : (
                        <button className="text-button danger" onClick={() => setItemDeleteId(item.id)}>删除</button>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
          {!views.length && <div className="empty-category"><p style={{ margin: "0 0 6px" }}>这个分类还没有记录</p><p style={{ margin: 0, fontSize: "var(--text-small)" }}>点击上方「添加」开始记录</p></div>}
        </div>
      </aside>
    </div>
  )
}

function CategoryManagerDialog({ category, categories, onClose, onRename, isClosing }: {
  category: string
  categories: string[]
  onClose: () => void
  onRename: (name: string) => void
  isClosing?: boolean
}) {
  const [name, setName] = useState(category)
  const normalized = name.trim()
  const duplicated = normalized !== category && categories.includes(normalized)

  function submitRename(event: FormEvent) {
    event.preventDefault()
    if (!normalized || normalized === category || duplicated) return
    onRename(normalized)
  }

  return (
    <div className={`overlay category-manager-overlay ${isClosing ? "is-closing" : ""}`}>
      <div className={`category-manager-dialog ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="category-manager-title">
        <div className="category-creator-header"><h2 id="category-manager-title">修改分类名称</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <form onSubmit={submitRename}>
          <label className="field"><span>分类名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          {duplicated && <p className="category-creator-tip error">这个分类已经有了</p>}
          <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!normalized || normalized === category || duplicated}>保存</button></div>
        </form>
      </div>
    </div>
  )
}

function ItemDetailPanel({ item, computed, onClose, onSnooze, onRestock, onCalibrate, onApplySuggestion, onDismissSuggestion, isClosing }: {
  item: ReplenishmentItem
  computed: ItemComputed
  onClose: () => void
  onSnooze: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onCalibrate: (item: ReplenishmentItem, remainingDays: number) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  isClosing?: boolean
}) {
  const [calibrating, setCalibrating] = useState(false)
  const [remainingDays, setRemainingDays] = useState(String(Math.max(0, computed.daysUntilDepletion)))
  const [suggestionFeedback, setSuggestionFeedback] = useState<null | { status: "applied" | "dismissed"; currentCycleDays: number; suggestedCycleDays: number }>(null)

  useEffect(() => {
    setCalibrating(false)
    setRemainingDays(String(Math.max(0, computed.daysUntilDepletion)))
    setSuggestionFeedback(null)
  }, [item.id])

  const consumption = calculateConsumption(item)
  const remainingQty = estimateRemainingQty(item)
  const latestRating = getLatestRating(item)

  function submitCalibration(event: FormEvent) {
    event.preventDefault()
    if (remainingDays === "") return
    onCalibrate(item, Number(remainingDays))
    setCalibrating(false)
  }

  function applySuggestionFromDetail() {
    if (!item.suggestedCycleDays) return
    setSuggestionFeedback({ status: "applied", currentCycleDays: item.cycleDays, suggestedCycleDays: item.suggestedCycleDays })
    onApplySuggestion(item)
  }

  function dismissSuggestionFromDetail() {
    if (!item.suggestedCycleDays) return
    setSuggestionFeedback({ status: "dismissed", currentCycleDays: item.cycleDays, suggestedCycleDays: item.suggestedCycleDays })
    onDismissSuggestion(item)
  }

  const visibleSuggestion = item.suggestedCycleDays
    ? { status: "pending" as const, currentCycleDays: item.cycleDays, suggestedCycleDays: item.suggestedCycleDays }
    : suggestionFeedback ?? { status: "steady" as const, currentCycleDays: item.cycleDays, suggestedCycleDays: item.cycleDays }

  return (
    <div className={`overlay detail-overlay ${isClosing ? "is-closing" : ""}`}>
      <aside className={`panel detail-panel ${isClosing ? "is-closing" : ""}`}>
        <div className="panel-header detail-panel-header">
          <div className="panel-header-info detail-panel-title">
            <h2>{item.name}</h2>
            <span className="current-category-badge detail-category-badge">{item.category || "未分类"}</span>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </div>

        {/* 状态概览卡片 */}
        <div className="detail-hero">
          <div className="detail-hero-row">
            <div className="detail-hero-status">
              <span className={`status-dot detail-status-dot ${computed.displayStatus}`} />
              <div className="detail-hero-text">
                <strong className="detail-hero-label">{computed.statusLabel}</strong>
                <strong className="detail-hero-value">{computed.remainingText}</strong>
                <div className="detail-calibrate-wrap">
                  <button type="button" className={`detail-calibrate-trigger${calibrating ? " is-active" : ""}`} aria-expanded={calibrating} onClick={() => setCalibrating((current) => !current)}>
                    <Icon name="clock" size={14} />
                    <span>校准</span>
                  </button>
                  {calibrating && (
                    <form className="calibrate-popover" onSubmit={submitCalibration}>
                      <label className="calibrate-popover-field">
                        <span>实际还能用</span>
                        <div className="input-suffix">
                          <input autoFocus aria-label="实际还能使用天数" type="number" min="0" max={item.cycleDays} value={remainingDays} onChange={(event) => setRemainingDays(event.target.value)} />
                          <b>天</b>
                        </div>
                      </label>
                      <div className="calibrate-popover-actions">
                        <button type="button" className="quiet-button compact" onClick={() => setCalibrating(false)}>取消</button>
                        <button type="submit" className="primary-button compact" disabled={remainingDays === ""}>确认</button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </div>
            {computed.status !== "normal" && (
              <div className="detail-hero-actions">
                <TaskActions item={item} onRestock={onRestock} />
              </div>
            )}
          </div>
          {latestRating === 1 && <p className="rating-warning-text">上次购买评价较差，考虑更换品牌</p>}

        </div>

        {/* 关键信息网格 */}
        <div className="detail-stats">
          <div className="detail-stat">
            <span className="detail-stat-label">补货记录</span>
            <strong className="detail-stat-value">{item.history.length} 次</strong>
          </div>
          {consumption.dailyUse && (
            <div className="detail-stat">
              <span className="detail-stat-label">日均消耗</span>
              <strong className="detail-stat-value">{consumption.dailyUseText}</strong>
            </div>
          )}
          {remainingQty && (
            <div className="detail-stat">
              <span className="detail-stat-label">预计剩余</span>
              <strong className="detail-stat-value">{remainingQty}</strong>
            </div>
          )}
        </div>

        {item.source === "onboarding" && (
          <div className="model-info-card">
            <div><span>当前预测周期</span><strong>约 {item.cycleDays} 天</strong></div>
            <div><span>模型置信度</span><strong>{item.confidence === "high" ? "高" : item.confidence === "medium" ? "中" : "低"}</strong></div>
            <div className="model-info-note"><span>校准说明</span><strong>{item.modelNote || (item.anchorEstimated ? "基于家庭画像估算" : "已使用真实补货时间")}</strong><small>{item.history.length < 2 ? `再记录 ${2 - item.history.length} 次补货后，会更接近你家的真实周期。` : "已开始根据你家的真实补货行为学习。"}</small></div>
          </div>
        )}

        {/* 补货间隔建议 */}
        {visibleSuggestion && (
          <div className={`detail-suggestion${visibleSuggestion.status !== "pending" ? " is-resolved" : ""}`}>
            <div className="detail-suggestion-copy">
              <span>周期参考</span>
              {visibleSuggestion.status === "pending" ? (
                <strong>记录显示约 {visibleSuggestion.suggestedCycleDays} 天补一次，当前仍按 {visibleSuggestion.currentCycleDays} 天计算</strong>
              ) : visibleSuggestion.status === "applied" ? (
                <strong>已按历史节奏更新为 {visibleSuggestion.suggestedCycleDays} 天</strong>
              ) : visibleSuggestion.status === "dismissed" ? (
                <strong>已暂不调整，仍按 {visibleSuggestion.currentCycleDays} 天计算</strong>
              ) : item.history.length >= 2 ? (
                <strong>更新节奏与设置信息一致，约每 {visibleSuggestion.currentCycleDays} 天补货一次</strong>
              ) : (
                <strong>当前按 {visibleSuggestion.currentCycleDays} 天计算，记录更多补货后会校准节奏</strong>
              )}
            </div>
            {visibleSuggestion.status === "pending" ? (
              <div className="detail-suggestion-actions">
                <button className="primary-button compact" onClick={applySuggestionFromDetail}><Icon name="check" size={13} />改为 {visibleSuggestion.suggestedCycleDays} 天</button>
                <button className="quiet-button compact" onClick={dismissSuggestionFromDetail}><Icon name="close" size={13} />暂不调整</button>
              </div>
            ) : (
              <span className={`detail-suggestion-state ${visibleSuggestion.status}`}>{visibleSuggestion.status === "applied" ? "已更新" : visibleSuggestion.status === "dismissed" ? "已保留" : "已同步"}</span>
            )}
          </div>
        )}

        {/* 补货历史 */}
        {item.history.length > 0 && (
          <div className="detail-section">
            <h3 className="detail-section-title">最近补货</h3>
            <div className="restock-history-list detail-history-list">
              {item.history.slice().reverse().slice(0, 5).map((record) => {
                const recordProductName = record.purchaseProductName || item.name
                const recordUnit = record.purchaseUnit || item.unit || '件'
                const reviewPreview = record.review ? getReviewPreview(record.review) : null
                return (
                  <div key={record.id} className="restock-record compact detail-record-row">
                    <div className="record-info">
                      <span className="record-date">{formatFullDate(record.at)}</span>
                      <span className="record-separator">·</span>
                      <span className="record-product">{recordProductName}</span>
                      {record.qty && (
                        <>
                          <span className="record-separator">·</span>
                          <span className="record-qty">{record.qty} {recordUnit}</span>
                        </>
                      )}
                      <span className="record-separator">·</span>
                      <span className="record-price">¥{record.price?.toFixed(2) || '0.00'}</span>
                      {reviewPreview && (
                        <>
                          <span className="record-separator">·</span>
                          <span className={`record-review-inline${reviewPreview.isTruncated ? ' has-tooltip' : ''}`} tabIndex={reviewPreview.isTruncated ? 0 : undefined}>
                            {reviewPreview.text}
                            {reviewPreview.isTruncated && <span className="record-review-tooltip">{record.review}</span>}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

function ItemEditor({ item, initialCategory, categories, onAddCategory, onClose, onSave, onDelete, isClosing }: {
  item: ReplenishmentItem | null
  initialCategory?: string
  categories: string[]
  onAddCategory: (name: string) => string | undefined
  onClose: () => void
  onSave: (draft: ItemDraft) => void
  onDelete?: (item: ReplenishmentItem) => void
  isClosing?: boolean
}) {
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState("")
  const [groupAdded, setGroupAdded] = useState(false)
  const [nameError, setNameError] = useState("")
  const nameInputRef = useRef<HTMLInputElement>(null)
  const cycleManuallyChanged = useRef(false)
  const [draft, setDraft] = useState<ItemDraft>(() => {
    const base: ItemDraft = item ? {
      name: item.name,
      category: item.category,
      cycleDays: item.cycleDays,
      bufferDays: item.bufferDays,
      link: item.link || "",
      remainingDays: String(Math.max(0, computeItem(item, Date.now()).daysUntilDepletion)),
      learningEnabled: item.learningEnabled !== false,
      unit: item.unit || "件",
      defaultQty: item.defaultQty ? String(item.defaultQty) : "",
      platform: item.platform || ""
    } : { ...EMPTY_DRAFT, category: initialCategory || EMPTY_DRAFT.category }
    return base
  })

  function set<K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function handleName(value: string) {
    if (nameError && value.trim()) setNameError("")
    const matched = Object.entries(DEFAULT_CYCLES).find(([name]) => value.includes(name))
    setDraft((current) => ({
      ...current,
      name: value,
      cycleDays: !item && !cycleManuallyChanged.current && matched ? matched[1] : current.cycleDays
    }))
  }

  function handleCycle(value: number) {
    cycleManuallyChanged.current = true
    set("cycleDays", value)
  }

  function handleGroup(value: string) {
    if (value === "__new__") {
      setAddingGroup(true)
      setGroupAdded(false)
      return
    }
    setAddingGroup(false)
    setNewGroupName("")
    setGroupAdded(false)
    set("category", value)
  }

  function confirmNewGroup() {
    const category = onAddCategory(newGroupName)
    if (!category) return
    set("category", category)
    setAddingGroup(false)
    setNewGroupName("")
    setGroupAdded(true)
  }

  function cancelNewGroup() {
    setAddingGroup(false)
    setNewGroupName("")
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.name.trim()) {
      setNameError("请输入消耗品名称")
      nameInputRef.current?.focus()
      return
    }
    if (!draft.category.trim()) return
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <div className={`overlay editor-overlay ${isClosing ? "is-closing" : ""}`}>
      <aside className={`panel editor-panel ${isClosing ? "is-closing" : ""}`}>
        <div className="panel-header"><h2>{item ? `编辑 ${item.name}` : "添加消耗品"}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <form className="editor-form" onSubmit={submit}>
          {/* 分类选择 */}
          <div className="editor-section">
            <label className="field field-wide">
              <span>归到哪里</span>
              <select autoFocus={!item} value={addingGroup ? "__new__" : draft.category} onChange={(event) => handleGroup(event.target.value)}>
                {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                <option value="__new__">＋ 新建分类</option>
              </select>
            </label>
            {groupAdded && <div className="group-added field-wide"><Icon name="check" size={15} />已添加并选中"{draft.category}"</div>}
            {addingGroup && (
              <div className="field field-wide new-group-field">
                <span>新分类名称</span>
                <div className="new-group-controls">
                  <input autoFocus value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="例如：宝宝用品" onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), confirmNewGroup())} />
                  <button type="button" className="group-confirm" disabled={!newGroupName.trim()} onClick={confirmNewGroup}>添加</button>
                  <button type="button" className="group-cancel" onClick={cancelNewGroup}>取消</button>
                </div>
              </div>
            )}
          </div>

          {/* 基本信息 */}
          <div className="editor-section">
            <h3 className="editor-section-title">基本信息</h3>
            <label className="field field-wide">
              <span>消耗品名称</span>
              <input ref={nameInputRef} autoFocus={Boolean(item)} value={draft.name} onChange={(event) => handleName(event.target.value)} placeholder="例如：卫生纸" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "item-editor-name-error" : undefined} />
              {nameError && <small id="item-editor-name-error" className="field-error" role="alert">{nameError}</small>}
            </label>
            <div className="field-row">
              <label className="field">
                <span>默认购买量 <em>选填</em></span>
                <div className="input-suffix"><input type="number" min="1" value={draft.defaultQty} onChange={(event) => set("defaultQty", event.target.value)} placeholder="选填" /><b>{draft.unit || "件"}</b></div>
              </label>
            </div>
          </div>

          {/* 消耗设置 */}
          <div className="editor-section">
            <h3 className="editor-section-title">消耗设置</h3>
            <div className="field-row three-cycle-fields">
              <label className="field">
                <span>库存周期</span>
                <div className="input-suffix"><input type="number" min="0" value={draft.remainingDays} onChange={(event) => set("remainingDays", event.target.value)} placeholder="当前还能用几天" /><b>天</b></div>
                <small>当前库存可消耗天数</small>
              </label>
              <label className="field">
                <span>消耗周期</span>
                <div className="input-suffix"><input type="number" min="1" value={draft.cycleDays} onChange={(event) => handleCycle(Number(event.target.value))} /><b>天</b></div>
                <small>单次补货可消耗天数</small>
              </label>
              <label className="field">
                <span>提醒天数</span>
                <div className="input-suffix"><input type="number" min="0" max={Math.max(0, draft.cycleDays - 1)} value={Math.min(draft.bufferDays, Math.max(0, draft.cycleDays - 1))} onChange={(event) => set("bufferDays", Number(event.target.value))} /><b>天</b></div>
                <small>预计用完前提醒</small>
              </label>
            </div>
          </div>

          {/* 高级选项 */}
          <div className="editor-section">
            <label className="learning-toggle field-wide"><input type="checkbox" checked={draft.learningEnabled} onChange={(event) => set("learningEnabled", event.target.checked)} /><span>根据补货记录自动调整间隔建议</span></label>
          </div>

          {/* 编辑时显示历史 */}
          {item && item.history.length > 0 && (
            <div className="editor-section">
              <h3 className="editor-section-title">最近补货</h3>
              <div className="editor-history">
                {item.history.slice(-3).reverse().map((event) => {
                  const eventUnit = event.purchaseUnit || item.unit || "件"
                  const measureUnit = getRecordMeasureUnit(item, event)
                  return (
                    <div key={event.id} className="editor-history-item">
                      <b>{formatDate(event.at)}</b>
                      <span>
                        {event.intervalDays ? `间隔 ${event.intervalDays} 天` : "首轮记录"}
                        {event.qty ? ` · ${event.qty}${eventUnit}` : ""}
                        {event.qty && measureUnit ? ` · ${measureUnit}` : ""}
                        {event.price !== undefined ? ` · 共 ¥${event.price.toFixed(2)}` : ""}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 底部操作 */}
          <div className="panel-footer">
            {item && onDelete ? <button type="button" className="danger-link" onClick={() => onDelete(item)}>删除消耗品</button> : <span />}
            <div className="panel-footer-actions">
              <button type="button" className="quiet-button" onClick={onClose}>取消</button>
              <button type="submit" className="primary-button green">保存</button>
            </div>
          </div>
        </form>
      </aside>
    </div>
  )
}

function SettingsPanel({ state, onChange, onRestartOnboarding, onClose, isClosing }: { state: AppState; onChange: (state: AppState) => void; onRestartOnboarding: () => void; onClose: () => void; isClosing?: boolean }) {
  const settings = state.settings
  const [editingBudget, setEditingBudget] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState(settings.monthlyBudget ? String(settings.monthlyBudget) : "")
  const [editingReminderHours, setEditingReminderHours] = useState(false)
  const [reminderHoursDraft, setReminderHoursDraft] = useState(String(settings.reminderIntervalHours))
  const [editingApiKey, setEditingApiKey] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState("")
  const [editingChatModel, setEditingChatModel] = useState(false)
  const [chatModelDraft, setChatModelDraft] = useState(settings.aiChatModel ?? settings.aiModel ?? "")
  const [editingOrderModel, setEditingOrderModel] = useState(false)
  const [orderModelDraft, setOrderModelDraft] = useState(settings.aiOrderModel ?? settings.aiModel ?? "")

  function patch(values: Partial<typeof settings>) {
    onChange({ ...state, settings: { ...settings, ...values } })
  }

  function saveApiKey() {
    const trimmed = apiKeyDraft.trim()
    patch({ aiApiKey: trimmed || undefined })
    setEditingApiKey(false)
    setApiKeyDraft("")
  }

  function cancelApiKeyEdit() {
    setEditingApiKey(false)
    setApiKeyDraft("")
  }

  function saveChatModel() {
    patch({ aiChatModel: chatModelDraft.trim() || undefined })
    setEditingChatModel(false)
  }

  function cancelChatModelEdit() {
    setChatModelDraft(settings.aiChatModel ?? settings.aiModel ?? "")
    setEditingChatModel(false)
  }

  function saveOrderModel() {
    patch({ aiOrderModel: orderModelDraft.trim() || undefined })
    setEditingOrderModel(false)
  }

  function cancelOrderModelEdit() {
    setOrderModelDraft(settings.aiOrderModel ?? settings.aiModel ?? "")
    setEditingOrderModel(false)
  }

  function saveBudget() {
    const value = Number(budgetDraft)
    patch({ monthlyBudget: budgetDraft.trim() && Number.isFinite(value) && value > 0 ? value : undefined })
    setEditingBudget(false)
  }

  function saveReminderHours() {
    const value = Number(reminderHoursDraft)
    const nextHours = Number.isFinite(value) ? Math.min(24, Math.max(1, Math.round(value))) : settings.reminderIntervalHours
    patch({ reminderIntervalHours: nextHours })
    setReminderHoursDraft(String(nextHours))
    setEditingReminderHours(false)
  }

  function getCurrentMonthSpending(): number {
    // 复用 domain.ts 的 calculateMonthlySpend，避免与主进程预算提醒、domain 计算结果不一致。
    // 该函数会按 monthStart <= at < nextMonthStart 过滤，不会把未来日期的补货记录算进当前月。
    return calculateMonthlySpend(state.items)
  }

  const currentMonthSpending = getCurrentMonthSpending()
  const budgetPercent = settings.monthlyBudget && settings.monthlyBudget > 0
    ? Math.round((currentMonthSpending / settings.monthlyBudget) * 100)
    : 0

  return (
    <div className={`overlay settings-overlay ${isClosing ? "is-closing" : ""}`}>
      <div className={`settings-dialog ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-dialog-header"><h2 id="settings-title">设置</h2><button className="icon-button close-btn" aria-label="关闭" onClick={onClose}><Icon name="close" size={16} /></button></div>
        <div className="settings-body">
          <div className="settings-row">
            <span className="settings-row-label">每月预算</span>
            <div className="settings-row-control">
              {editingBudget ? (
                <div className="input-with-unit settings-inline-input">
                  <input
                    autoFocus
                    aria-label="每月预算"
                    type="number"
                    min="1"
                    step="100"
                    value={budgetDraft}
                    onChange={(event) => setBudgetDraft(event.target.value)}
                    onBlur={saveBudget}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveBudget()
                      if (event.key === "Escape") {
                        event.stopPropagation()
                        setBudgetDraft(settings.monthlyBudget ? String(settings.monthlyBudget) : "")
                        setEditingBudget(false)
                      }
                    }}
                    placeholder="未设置"
                  />
                  <span className="unit-label">元</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="editable-value settings-editable-value"
                  onClick={() => {
                    setBudgetDraft(settings.monthlyBudget ? String(settings.monthlyBudget) : "")
                    setEditingBudget(true)
                  }}
                >
                  <span>{settings.monthlyBudget ? `${settings.monthlyBudget} 元` : "未设置"}</span>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="settings-row budget-usage">
            <span className="settings-row-label">预算消耗</span>
            <div className="settings-row-control">
              {settings.monthlyBudget && settings.monthlyBudget > 0 ? (
                <>
                  <div className="budget-bar" role="progressbar" aria-label="本月预算消耗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(budgetPercent, 100)}>
                    <div className="budget-bar-fill" style={{ width: `${Math.min(budgetPercent, 100)}%` }}></div>
                  </div>
                  <span className="budget-percent">{budgetPercent}%</span>
                  <span className="budget-detail">¥{currentMonthSpending.toFixed(0)} / ¥{settings.monthlyBudget}</span>
                </>
              ) : (
                <span className="settings-empty-value">设置预算后显示</span>
              )}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">稍后提醒</span>
            <div className="settings-row-control">
              {editingReminderHours ? (
                <div className="input-with-unit settings-inline-input">
                  <input
                    autoFocus
                    aria-label="稍后提醒小时数，范围 1 到 24 小时"
                    type="number"
                    min="1"
                    max="24"
                    step="1"
                    value={reminderHoursDraft}
                    onChange={(event) => setReminderHoursDraft(event.target.value)}
                    onBlur={saveReminderHours}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveReminderHours()
                      if (event.key === "Escape") {
                        event.stopPropagation()
                        setReminderHoursDraft(String(settings.reminderIntervalHours))
                        setEditingReminderHours(false)
                      }
                    }}
                  />
                  <span className="unit-label">小时</span>
                </div>
              ) : (
                <button type="button" className="editable-value settings-editable-value" onClick={() => setEditingReminderHours(true)}>
                  <span>{settings.reminderIntervalHours} 小时后</span>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">勿扰时段</span>
            <div className="settings-row-control">
              <div className="time-range">
                <input aria-label="勿扰开始时间" type="time" value={settings.quietStart} onChange={(event) => patch({ quietStart: event.target.value })} />
                <span>至</span>
                <input aria-label="勿扰结束时间" type="time" value={settings.quietEnd} onChange={(event) => patch({ quietEnd: event.target.value })} />
              </div>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">系统通知</span>
            <div className="settings-row-control">
              <div className="segment-control notification-segment" role="group" aria-label="系统通知">
                <button type="button" className={!settings.notificationEnabled ? "active" : ""} aria-pressed={!settings.notificationEnabled} onClick={() => patch({ notificationEnabled: false })}>关闭</button>
                <button type="button" className={settings.notificationEnabled ? "active" : ""} aria-pressed={settings.notificationEnabled} onClick={() => patch({ notificationEnabled: true })}>开启</button>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">AI API Key</span>
            <div className="settings-row-control settings-api-key-control">
              {editingApiKey ? (
                <div className="settings-secret-editor">
                  <input
                    autoFocus
                    aria-label="阿里云百炼 API Key"
                    type="password"
                    value={apiKeyDraft}
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveApiKey()
                      if (event.key === "Escape") {
                        event.stopPropagation()
                        cancelApiKeyEdit()
                      }
                    }}
                    placeholder="sk-..."
                  />
                  <button type="button" className="settings-secret-action" onClick={saveApiKey}>确认</button>
                  <button type="button" className="settings-secret-action muted" onClick={cancelApiKeyEdit}>取消</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="editable-value settings-editable-value"
                  onClick={() => {
                    setApiKeyDraft(settings.aiApiKey ?? "")
                    setEditingApiKey(true)
                  }}
                >
                  <span>{settings.aiApiKey ? `已设置（尾号 ${settings.aiApiKey.slice(-4)}）` : "未设置"}</span>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">问答模型</span>
            <div className="settings-row-control settings-api-key-control">
              {editingChatModel ? (
                <div className="settings-secret-editor settings-model-editor">
                  <input
                    autoFocus
                    aria-label="家庭问答模型 ID"
                    type="text"
                    value={chatModelDraft}
                    onChange={(event) => setChatModelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveChatModel()
                      if (event.key === "Escape") {
                        event.stopPropagation()
                        cancelChatModelEdit()
                      }
                    }}
                    placeholder="默认 qwen-plus"
                  />
                  <button type="button" className="settings-secret-action" onClick={saveChatModel}>确认</button>
                  <button type="button" className="settings-secret-action muted" onClick={cancelChatModelEdit}>取消</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="editable-value settings-editable-value settings-model-value"
                  onClick={() => {
                    setChatModelDraft(settings.aiChatModel ?? settings.aiModel ?? "")
                    setEditingChatModel(true)
                  }}
                >
                  <span>{settings.aiChatModel || settings.aiModel || "默认 qwen-plus"}</span>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">订单识别模式</span>
            <div className="settings-row-control">
              <div className="segment-control notification-segment" role="group" aria-label="订单识别模式">
                <button type="button" className={(settings.aiOrderMode ?? "accurate") === "accurate" ? "active" : ""} aria-pressed={(settings.aiOrderMode ?? "accurate") === "accurate"} onClick={() => patch({ aiOrderMode: "accurate" })}>准确</button>
                <button type="button" className={(settings.aiOrderMode ?? "accurate") === "fast" ? "active" : ""} aria-pressed={(settings.aiOrderMode ?? "accurate") === "fast"} onClick={() => patch({ aiOrderMode: "fast" })}>快速</button>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">订单识别模型</span>
            <div className="settings-row-control settings-api-key-control">
              {editingOrderModel ? (
                <div className="settings-secret-editor settings-model-editor">
                  <input
                    autoFocus
                    aria-label="订单识别模型 ID"
                    type="text"
                    value={orderModelDraft}
                    onChange={(event) => setOrderModelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveOrderModel()
                      if (event.key === "Escape") {
                        event.stopPropagation()
                        cancelOrderModelEdit()
                      }
                    }}
                    placeholder={(settings.aiOrderMode ?? "accurate") === "fast" ? "快速模式默认模型" : "准确模式默认模型"}
                  />
                  <button type="button" className="settings-secret-action" onClick={saveOrderModel}>确认</button>
                  <button type="button" className="settings-secret-action muted" onClick={cancelOrderModelEdit}>取消</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="editable-value settings-editable-value settings-model-value"
                  onClick={() => {
                    setOrderModelDraft(settings.aiOrderModel ?? settings.aiModel ?? "")
                    setEditingOrderModel(true)
                  }}
                >
                  <span>{settings.aiOrderModel || settings.aiModel || ((settings.aiOrderMode ?? "accurate") === "fast" ? "快速模式默认" : "准确模式默认")}</span>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App

// 补货弹窗组件
interface RestockModalProps {
  isOpen: boolean
  onClose: () => void
  item: ReplenishmentItem | null
  onConfirm: (itemId: string, option: PurchaseOption | null, qty: number, price: number, restockDate: number | undefined, platform?: string, pricingMode?: PricingMode, measureBaseAmount?: number, measureAmount?: number, measureUnit?: string, review?: string) => void
  // 无常购商品时，点击“添加商品”触发；不关闭本弹窗
  onAddPurchaseOption: (itemId: string) => void
  // 从补货弹窗录入新商品后，App 传入新商品 id，由本弹窗自动选中并填值
  preferredPurchaseOptionId?: string | null
  // 自动选中完成后回调，用于清空 preferred 状态，避免反复选中
  onPreferredPurchaseOptionConsumed?: () => void
}

function RestockModal({ isOpen, onClose, item, onConfirm, onAddPurchaseOption, preferredPurchaseOptionId, onPreferredPurchaseOptionConsumed }: RestockModalProps) {
  const [selectedOption, setSelectedOption] = useState<PurchaseOption | null>(null)
  const [qty, setQty] = useState<number | ''>('')
  const [price, setPrice] = useState<number | ''>('')
  const [restockDate, setRestockDate] = useState<string>(() => toDateInputValue(Date.now()))
  const [platform, setPlatform] = useState('')
  const [platformCustom, setPlatformCustom] = useState('')
  const [measureAmount, setMeasureAmount] = useState<number | ''>('')
  const [measureUnit, setMeasureUnit] = useState('')
  const [review, setReview] = useState('')
  const [error, setError] = useState('')
  // 标记当前选中是由 preferredPurchaseOptionId 触发，避免被通用的选中 effect 覆盖为默认值
  const preferredSelectingRef = useRef(false)

  // 选中采购选项时自动填充默认数量；价格、平台和评价属于当次补货事实，不自动带出。
  useEffect(() => {
    if (!selectedOption) return
    if (preferredSelectingRef.current) {
      preferredSelectingRef.current = false
      return
    }
    setQty(item?.defaultQty || 1)
    if (getPurchaseOptionPricingMode(selectedOption) === 'measure') {
      setMeasureUnit(getCompatibleMeasureUnits(selectedOption.measureUnit)[0]?.value || '')
    } else {
      setMeasureAmount('')
      setMeasureUnit('')
    }
  }, [selectedOption, item?.defaultQty])

  // 每次打开弹窗或切换物品时重置内部状态，避免显示上一次补货的残留值
  useEffect(() => {
    if (isOpen && item) {
      setSelectedOption(null)
      setQty('')
      setPrice('')
      setRestockDate(toDateInputValue(Date.now()))
      setPlatform('')
      setPlatformCustom('')
      setMeasureAmount('')
      setMeasureUnit('')
      setReview('')
      setError('')
      preferredSelectingRef.current = false
    }
  }, [isOpen, item?.id])

  // 监听 preferredPurchaseOptionId：当对应采购选项出现在 item.purchaseOptions 中时自动选中并填值
  useEffect(() => {
    if (!preferredPurchaseOptionId || !item) return
    const option = (item.purchaseOptions || []).find((o) => o.id === preferredPurchaseOptionId)
    if (!option) return
    preferredSelectingRef.current = true
    setSelectedOption(option)
    setQty(item.defaultQty || 1)
    if (getPurchaseOptionPricingMode(option) === 'measure') {
      setMeasureUnit(getCompatibleMeasureUnits(option.measureUnit)[0]?.value || '')
    } else {
      setMeasureAmount('')
      setMeasureUnit('')
    }
    onPreferredPurchaseOptionConsumed?.()
  }, [preferredPurchaseOptionId, item, onPreferredPurchaseOptionConsumed])

  if (!isOpen || !item) return null

  const purchaseOptions = item.purchaseOptions || []
  const unitText = selectedOption?.unit || item.unit || '件'
  const selectedPricingMode = getPurchaseOptionPricingMode(selectedOption || undefined)
  const selectedMeasureBaseAmount = selectedPricingMode === 'measure' ? getMeasureBaseAmount(selectedOption || undefined) : undefined
  const usesMeasurePricing = Boolean(selectedOption && selectedPricingMode === 'measure')
  const compatibleMeasureUnits = usesMeasurePricing ? getCompatibleMeasureUnits(selectedOption?.measureUnit) : []
  const finalPlatform = platform === '其他' ? platformCustom.trim() : platform
  const restockTimestamp = parseDateInputValue(restockDate)
  // canConfirm 不再强制 selectedOption：item 没有 purchaseOptions 时也能直接补货。
  // 仅 qty / price / restockDate 必填；measure 信息只在选择了按含量计价的常购商品时才要求。
  const canConfirm = canConfirmRestock({
    qty,
    price,
    restockDateValid: restockTimestamp !== undefined,
    usesMeasurePricing,
    measureAmount,
    measureUnit
  })
  const currentUnitPrice = selectedOption && price !== '' && qty !== '' && (!usesMeasurePricing || measureAmount !== '')
    ? getRestockUnitPriceInfo(item, selectedOption, {
        id: 'draft',
        at: Date.now(),
        price: Number(price),
        qty: Number(qty),
        purchasePricingMode: selectedPricingMode,
        purchaseMeasureBaseAmount: selectedMeasureBaseAmount,
        purchaseMeasureAmount: usesMeasurePricing ? Number(measureAmount) : undefined,
        purchaseMeasureUnit: usesMeasurePricing ? measureUnit : undefined
      })
    : null
  const selectedLowest = selectedOption ? getOptionHistoricalLowest(item, selectedOption) : null

  return (
    <div className="restock-modal-overlay">
      <div className="restock-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>补货 - {item.name}</h3>
          <button className="icon-button modal-close-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* 采购选项列表 */}
          <div className="restock-option-section">
            <div className="restock-product-picker">
              <div className="restock-product-scroll" aria-label="可选补货商品">
                {purchaseOptions.length > 0 ? purchaseOptions.map((option) => {
                  const lowestPrice = getOptionHistoricalLowest(item, option)
                  const latestReview = getOptionLatestReview(item, option)
                  const reviewPreview = latestReview ? getReviewPreview(latestReview) : null
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`restock-product-card ${selectedOption?.id === option.id ? 'is-selected' : ''}`}
                      onClick={() => setSelectedOption(option)}
                      aria-pressed={selectedOption?.id === option.id}
                    >
                      <span className="restock-product-main">
                        <span className="restock-product-name">{option.productName}</span>
                        {reviewPreview ? (
                          <span className={`restock-product-review${reviewPreview.isTruncated ? ' has-tooltip' : ''}`} tabIndex={reviewPreview.isTruncated ? 0 : undefined}>
                            「{reviewPreview.text}」
                            {reviewPreview.isTruncated && <span className="restock-product-review-tooltip">{latestReview}</span>}
                          </span>
                        ) : (
                          <span className="restock-product-meta">{getPurchaseOptionPricingMode(option) === 'measure' ? `按${formatPricingUnit(getMeasureBaseAmount(option), option.measureUnit)}比价` : `按${option.unit || item.unit || '件'}计价`}</span>
                        )}
                      </span>
                      <span className={`restock-product-anchor${lowestPrice ? ' has-price' : ''}`}>
                        <span aria-label="历史最低价"><b aria-hidden="true">↘</b></span>
                        <strong>{lowestPrice ? lowestPrice.label : '暂无价格记录'}</strong>
                      </span>
                    </button>
                  )
                }) : (
                  <div className="restock-product-empty">还没有常购商品</div>
                )}
              </div>
              <button
                type="button"
                className="restock-product-add-card"
                onClick={() => onAddPurchaseOption(item.id)}
              >
                <span aria-hidden="true">+</span>
                <strong>添加商品</strong>
              </button>
            </div>
          </div>

          {/* 数量和价格输入：无论是否选择采购选项都可填写，保证无选项时也能补货 */}
          <div className="restock-inputs">
            <div className="input-row">
              <label>补货日期：</label>
              <input
                type="date"
                value={restockDate}
                onChange={(e) => setRestockDate(e.target.value)}
              />
            </div>

            <div className="input-row">
              <label>购买平台：</label>
              <select value={platform} onChange={(e) => { setPlatform(e.target.value); if (e.target.value !== '其他') setPlatformCustom('') }}>
                <option value="">选填</option>
                {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {platform === '其他' && (
              <div className="input-row">
                <label>平台名称：</label>
                <input value={platformCustom} onChange={(e) => setPlatformCustom(e.target.value)} placeholder="选填" />
              </div>
            )}

            <div className="input-row">
              <label>采购数量：</label>
              <div className="restock-input-with-unit">
                <input
                  type="number"
                  min="1"
                  value={qty}
                  onChange={(e) => setQty(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="必填"
                />
                <span>{unitText}</span>
              </div>
            </div>

            {usesMeasurePricing && (
              <div className="input-row">
                <label>本次含量：</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={measureAmount}
                  onChange={(e) => setMeasureAmount(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="必填"
                />
                <select value={measureUnit} onChange={(e) => setMeasureUnit(e.target.value)} aria-label="本次含量单位">
                  <option value="">单位</option>
                  {compatibleMeasureUnits.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
                </select>
              </div>
            )}

            <div className="input-row">
              <label>采购价格：</label>
              <div className="restock-input-with-unit">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="必填"
                />
                <span>元</span>
              </div>
            </div>
            <div className="input-row">
              <label>商品评价：</label>
              <input value={review} onChange={(e) => setReview(e.target.value)} placeholder="选填" />
            </div>
            {currentUnitPrice && (
              <div className="restock-price-reference">
                <strong>本次单价 {currentUnitPrice.label}</strong>
                {selectedLowest && <span>{currentUnitPrice.value <= selectedLowest.value ? '低于或持平历史最低' : `高于历史最低 ${(currentUnitPrice.value - selectedLowest.value).toFixed(1)} 元/${currentUnitPrice.unit}`}</span>}
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (canConfirm && restockTimestamp !== undefined) {
                onConfirm(item.id, selectedOption, Number(qty), Number(price) || 0, restockTimestamp, finalPlatform || undefined, selectedPricingMode, selectedMeasureBaseAmount, usesMeasurePricing ? Number(measureAmount) : undefined, usesMeasurePricing ? measureUnit : undefined, review)
              } else {
                setError(usesMeasurePricing ? '请补全数量、含量和价格' : '请补全数量和价格')
              }
            }}
            disabled={!canConfirm}
          >
            确认补货
          </button>
        </div>
      </div>
    </div>
  )
}

interface RestockRecordEditModalProps {
  isOpen: boolean
  item: ReplenishmentItem | null
  record: RestockEvent | null
  onClose: () => void
  onSave: (recordId: string, patch: Pick<RestockEvent, "at" | "qty" | "price"> & Partial<Pick<RestockEvent, "platform" | "purchasePricingMode" | "purchaseMeasureBaseAmount" | "purchaseMeasureAmount" | "purchaseMeasureUnit" | "review">>) => void
}

function RestockRecordEditModal({ isOpen, item, record, onClose, onSave }: RestockRecordEditModalProps) {
  const [restockDate, setRestockDate] = useState("")
  const [qty, setQty] = useState<number | ''>('')
  const [price, setPrice] = useState<number | ''>('')
  const [platform, setPlatform] = useState('')
  const [platformCustom, setPlatformCustom] = useState('')
  const [measureAmount, setMeasureAmount] = useState<number | ''>('')
  const [measureUnit, setMeasureUnit] = useState('')
  const [review, setReview] = useState('')
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isOpen || !record) return
    setRestockDate(toDateInputValue(record.at))
    setQty(record.qty || 1)
    setPrice(record.price ?? 0)
    const knownPlatform = record.platform && platforms.includes(record.platform as typeof platforms[number])
    setPlatform(knownPlatform ? record.platform! : record.platform ? '其他' : '')
    setPlatformCustom(knownPlatform ? '' : record.platform || '')
    setMeasureAmount(record.purchaseMeasureAmount || '')
    setMeasureUnit(record.purchaseMeasureUnit || '')
    setReview(record.review || '')
    setError("")
  }, [isOpen, record?.id])

  if (!isOpen || !item || !record) return null

  const recordProductName = record.purchaseProductName || item.name
  const recordUnit = record.purchaseUnit || item.unit || '件'
  const recordPrice = Number(price) || 0
  const matchingOption = findRecordOption(item, record)
  const recordPricingMode = record.purchasePricingMode || (record.purchaseMeasureAmount ? "measure" : getPurchaseOptionPricingMode(matchingOption))
  const usesMeasurePricing = recordPricingMode === "measure"
  const recordMeasureBaseAmount = usesMeasurePricing ? (record.purchaseMeasureBaseAmount || getMeasureBaseAmount(matchingOption)) : undefined
  const compatibleMeasureUnits = usesMeasurePricing ? getCompatibleMeasureUnits(matchingOption?.measureUnit || record.purchaseMeasureUnit) : []
  const finalPlatform = platform === '其他' ? platformCustom.trim() : platform
  const draftUnitPrice = matchingOption && price !== '' && qty !== '' && (!usesMeasurePricing || measureAmount !== '')
    ? getRestockUnitPriceInfo(item, matchingOption, {
        ...record,
        price: Number(price),
        qty: Number(qty),
        purchasePricingMode: recordPricingMode,
        purchaseMeasureBaseAmount: recordMeasureBaseAmount,
        purchaseMeasureAmount: usesMeasurePricing ? Number(measureAmount) : undefined,
        purchaseMeasureUnit: usesMeasurePricing ? measureUnit : undefined
      })
    : null
  const recordReviewPreview = record.review ? getReviewPreview(record.review) : null

  function handleSubmit() {
    if (!record) return
    const parsedDate = parseDateInputValue(restockDate)
    const parsedQty = Number(qty)
    const parsedPrice = Number(price)
    const parsedMeasureAmount = Number(measureAmount)

    if (!parsedDate) {
      setError("请选择补货日期")
      return
    }
    if (!Number.isFinite(parsedQty) || parsedQty < 1) {
      setError("采购数量至少为 1")
      return
    }
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setError("采购价格不能小于 0")
      return
    }
    if (usesMeasurePricing && (!Number.isFinite(parsedMeasureAmount) || parsedMeasureAmount <= 0 || !measureUnit)) {
      setError("请填写本次含量，并选择同维度单位")
      return
    }

    onSave(record.id, {
      at: parsedDate,
      qty: parsedQty,
      price: parsedPrice,
      platform: finalPlatform || undefined,
      purchasePricingMode: recordPricingMode,
      purchaseMeasureBaseAmount: recordMeasureBaseAmount,
      purchaseMeasureAmount: usesMeasurePricing ? parsedMeasureAmount : undefined,
      purchaseMeasureUnit: usesMeasurePricing ? measureUnit || undefined : undefined,
      review
    })
  }

  return (
    <div className="restock-modal-overlay">
      <div className="restock-modal restock-record-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>修改补货记录 - {item.name}</h3>
          <button className="icon-button modal-close-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="restock-option-section restock-record-option-section">
            <div className="restock-product-picker restock-record-product-picker">
              <div className="restock-product-scroll" aria-label="补货商品">
                <button type="button" className="restock-product-card is-selected is-static" aria-pressed="true">
                  <span className="restock-product-main">
                    <span className="restock-product-name">{recordProductName}</span>
                    {recordReviewPreview ? (
                      <span className={`restock-product-review${recordReviewPreview.isTruncated ? ' has-tooltip' : ''}`} tabIndex={recordReviewPreview.isTruncated ? 0 : undefined}>
                        「{recordReviewPreview.text}」
                        {recordReviewPreview.isTruncated && <span className="restock-product-review-tooltip">{record.review}</span>}
                      </span>
                    ) : (
                      <span className="restock-product-meta">{usesMeasurePricing ? `按${formatPricingUnit(recordMeasureBaseAmount, matchingOption?.measureUnit || record.purchaseMeasureUnit)}比价` : `按${recordUnit}计价`}</span>
                    )}
                  </span>
                  <span className={`restock-product-anchor${draftUnitPrice ? ' has-price' : ''}`}>
                    <span aria-label="历史最低价"><b aria-hidden="true">↘</b></span>
                    <strong>{draftUnitPrice ? draftUnitPrice.label : `¥${formatCompactPrice(recordPrice)}/${recordUnit}`}</strong>
                  </span>
                </button>
              </div>
            </div>
          </div>

          <div className="restock-inputs">
            <div className="input-row">
              <label htmlFor="record-restock-date">补货日期：</label>
              <input
                id="record-restock-date"
                type="date"
                value={restockDate}
                onChange={(e) => setRestockDate(e.target.value)}
              />
            </div>

            <div className="input-row">
              <label htmlFor="record-restock-platform">购买平台：</label>
              <select id="record-restock-platform" value={platform} onChange={(e) => { setPlatform(e.target.value); if (e.target.value !== '其他') setPlatformCustom('') }}>
                <option value="">选填</option>
                {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {platform === '其他' && (
              <div className="input-row">
                <label htmlFor="record-restock-platform-custom">平台名称：</label>
                <input id="record-restock-platform-custom" value={platformCustom} onChange={(e) => setPlatformCustom(e.target.value)} placeholder="选填" />
              </div>
            )}

            <div className="input-row">
              <label htmlFor="record-restock-qty">采购数量：</label>
              <div className="restock-input-with-unit">
                <input
                  id="record-restock-qty"
                  type="number"
                  min="1"
                  value={qty}
                  onChange={(e) => setQty(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="必填"
                />
                <span>{recordUnit}</span>
              </div>
            </div>

            {usesMeasurePricing && (
              <div className="input-row">
                <label htmlFor="record-restock-measure">本次含量：</label>
                <input
                  id="record-restock-measure"
                  type="number"
                  min="0"
                  step="0.01"
                  value={measureAmount}
                  onChange={(e) => setMeasureAmount(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="必填"
                />
                <select value={measureUnit} onChange={(e) => setMeasureUnit(e.target.value)} aria-label="本次含量单位">
                  <option value="">单位</option>
                  {compatibleMeasureUnits.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
                </select>
              </div>
            )}

            <div className="input-row">
              <label htmlFor="record-restock-price">采购价格：</label>
              <div className="restock-input-with-unit">
                <input
                  id="record-restock-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="必填"
                />
                <span>元</span>
              </div>
            </div>
            <div className="input-row">
              <label htmlFor="record-restock-review">商品评价：</label>
              <input id="record-restock-review" value={review} onChange={(e) => setReview(e.target.value)} placeholder="选填" />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit}>保存修改</button>
        </div>
      </div>
    </div>
  )
}

// ---------- 订单截图批量导入 ----------

/** 同一天且价格一致的记录视为疑似重复导入 */
function hasSimilarRestockRecord(item: ReplenishmentItem, orderDate?: number, price?: number): boolean {
  if (!orderDate) return false
  return item.history.some((event) =>
    startOfDay(event.at) === orderDate && (price === undefined || event.price === price)
  )
}

/** 单次批量导入的截图数量上限，控制识别成本与确认列表长度 */
const MAX_ORDER_IMAGES = 5

type OrderImportRow = {
  key: string
  productName: string
  brandName?: string
  coreName?: string
  qty: number | ''
  price: number | ''
  measureAmount: number | ''
  measureUnit: string
  review: string
  date: string
  platform: string
  genericName?: string
  /** itemId | "__create__" | "__skip__" */
  targetItem: string
  /** "" (不指定) | optionId | "__newopt__" (新建常购商品) */
  targetOption: string
  /** 目标分类；"__newcat__" 表示使用 customCategory */
  category: string
  customCategory: string
  duplicate: boolean
}

export type OrderImportConfirmedRow = {
  productName: string
  brandName?: string
  coreName?: string
  qty: number
  price?: number
  measureAmount?: number
  measureUnit?: string
  review?: string
  restockDate?: number
  platform?: string
  genericName?: string
  targetItem: string
  targetOption: string
  /** 已解析的目标分类 */
  category: string
}

interface OrderImportModalProps {
  isOpen: boolean
  onClose: () => void
  items: ReplenishmentItem[]
  categories: string[]
  apiKey?: string
  model?: string
  recognitionMode: OrderRecognitionMode
  onOpenSettings: () => void
  onConfirm: (payload: { rows: OrderImportConfirmedRow[] }) => void
}

/** 该常购商品最近一次补货记录里的含量快照，用于预填（如皇家猫粮 L40 每袋 2kg） */
function latestMeasureForOption(item: ReplenishmentItem, optionId: string | undefined): { amount?: number; unit?: string } {
  if (!optionId) return {}
  for (let i = item.history.length - 1; i >= 0; i--) {
    const event = item.history[i]
    if (event.purchaseOptionId === optionId && event.purchaseMeasureAmount && event.purchaseMeasureUnit) {
      return { amount: event.purchaseMeasureAmount, unit: event.purchaseMeasureUnit }
    }
  }
  return {}
}

function OrderImportModal({ isOpen, onClose, items, categories, apiKey, model, recognitionMode, onOpenSettings, onConfirm }: OrderImportModalProps) {
  const [step, setStep] = useState<"pick" | "loading" | "review">("pick")
  const [error, setError] = useState("")
  const [rows, setRows] = useState<OrderImportRow[]>([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 弹窗关闭或重选图片后递增，丢弃已经在途的识别结果
  const requestTokenRef = useRef(0)

  useEffect(() => {
    if (isOpen) {
      setStep("pick")
      setError("")
      setRows([])
      setProgress({ done: 0, total: 0 })
      requestTokenRef.current++
    }
  }, [isOpen])

  function buildRowsFromOrder(order: ExtractedOrder, imageIndex: number): OrderImportRow[] {
    const defaultDate = toDateInputValue(order.orderDate ?? Date.now())
    const defaultCategory = categories.includes("其他") ? "其他" : (categories[0] || "其他")
    return order.lines.map((line, index) => {
      const matchedItem = (line.matchedItemName ? items.find((item) => item.name === line.matchedItemName) : undefined)
        || fuzzyMatchItem([line.coreName, line.productName, line.brandName, line.genericName], items)
      const matchedOption = matchedItem
        ? ((line.matchedOptionName ? (matchedItem.purchaseOptions || []).find((option) => option.productName === line.matchedOptionName) : undefined)
          || fuzzyMatchOption(matchedItem, [line.coreName, line.productName, line.brandName]))
        : undefined
      // 含量预填优先级：标题里识别出的规格 > 该常购商品最近一次记录的含量快照
      const historyMeasure = matchedItem && matchedOption ? latestMeasureForOption(matchedItem, matchedOption.id) : {}
      return {
        key: `img${imageIndex}_line${index}`,
        productName: line.productName,
        brandName: line.brandName,
        coreName: line.coreName,
        qty: line.qty,
        price: line.price ?? '',
        measureAmount: line.measureAmount ?? historyMeasure.amount ?? '',
        measureUnit: line.measureUnit ?? historyMeasure.unit ?? '',
        review: '',
        date: defaultDate,
        platform: order.platform || '',
        genericName: line.genericName,
        targetItem: matchedItem ? matchedItem.id : "__create__",
        // 匹配到物品但没有对应常购商品时，默认顺带新建常购商品（可在下拉改为不指定）
        targetOption: matchedItem
          ? (matchedOption ? matchedOption.id : ((line.coreName || line.brandName || line.productName) ? "__newopt__" : ""))
          : "",
        category: matchedItem?.category || defaultCategory,
        customCategory: "",
        duplicate: matchedItem ? hasSimilarRestockRecord(matchedItem, order.orderDate, line.price) : false
      }
    })
  }

  async function recognize(files: File[]) {
    if (!apiKey) {
      setError("还没有配置识别服务，请先在设置中填写订单识别 API Key。")
      return
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"))
    if (!imageFiles.length) return
    const limited = imageFiles.slice(0, MAX_ORDER_IMAGES)
    const skippedCount = imageFiles.length - limited.length
    const token = ++requestTokenRef.current
    setStep("loading")
    setError("")
    setProgress({ done: 0, total: limited.length })

    const catalog = [...items]
      .sort((a, b) => {
        const latestA = Math.max(a.updatedAt || 0, ...a.history.map((event) => event.at || 0))
        const latestB = Math.max(b.updatedAt || 0, ...b.history.map((event) => event.at || 0))
        return latestB - latestA
      })
      .map((item) => ({
        name: item.name,
        options: (item.purchaseOptions || []).map((option) => option.productName)
      }))
    // 并发识别，单张失败不阻塞其他截图
    const results = await Promise.all(limited.map(async (file) => {
      try {
        const dataUrl = await fileToCompressedDataUrl(file)
        return await extractOrderFromImage(apiKey, dataUrl, catalog, model, recognitionMode)
      } catch {
        return { ok: false as const, error: "图片读取失败" }
      } finally {
        if (token === requestTokenRef.current) {
          setProgress((current) => ({ ...current, done: current.done + 1 }))
        }
      }
    }))
    if (token !== requestTokenRef.current) return

    const nextRows = results.flatMap((result, imageIndex) => result.ok ? buildRowsFromOrder(result.order, imageIndex) : [])
    const failedCount = results.filter((result) => !result.ok).length
    if (!nextRows.length) {
      setStep("pick")
      const firstError = results.find((result) => !result.ok)
      setError(firstError && !firstError.ok ? firstError.error : "没有识别出商品条目，请换清晰的订单截图重试。")
      return
    }
    setRows(nextRows)
    const notices: string[] = []
    if (failedCount > 0) notices.push(`有 ${failedCount} 张截图识别失败，已跳过`)
    if (skippedCount > 0) notices.push(`超出单次 ${MAX_ORDER_IMAGES} 张上限，已忽略 ${skippedCount} 张`)
    setError(notices.join("；"))
    setStep("review")
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || [])
    if (files.length) void recognize(files)
    event.target.value = ''
  }

  // 支持直接粘贴截图
  useEffect(() => {
    if (!isOpen || step !== "pick") return
    function handlePaste(event: ClipboardEvent) {
      const files = Array.from(event.clipboardData?.items || [])
        .filter((entry) => entry.type.startsWith("image/"))
        .flatMap((entry) => {
          const file = entry.getAsFile()
          return file ? [file] : []
        })
      if (files.length) {
        event.preventDefault()
        void recognize(files)
      }
    }
    window.addEventListener("paste", handlePaste)
    return () => window.removeEventListener("paste", handlePaste)
  }, [isOpen, step, items, apiKey, model, categories])

  if (!isOpen) return null

  function updateRow(key: string, patch: Partial<OrderImportRow>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row))
  }

  const includedCount = rows.filter((row) => row.targetItem !== "__skip__" && row.qty !== '' && Number(row.qty) > 0).length

  function handleConfirm() {
    onConfirm({
      rows: rows
        .filter((row) => row.targetItem !== "__skip__" && row.qty !== '' && Number(row.qty) > 0)
        .map((row) => {
          const measureAmount = row.measureAmount === '' ? undefined : Math.max(0, Number(row.measureAmount)) || undefined
          return {
            productName: row.productName,
            brandName: row.brandName,
            coreName: row.coreName,
            qty: Math.max(1, Math.round(Number(row.qty))),
            price: row.price === '' ? undefined : Math.max(0, Number(row.price)),
            measureAmount,
            measureUnit: measureAmount && row.measureUnit ? row.measureUnit : undefined,
            review: row.review.trim() || undefined,
            restockDate: parseDateInputValue(row.date),
            platform: row.platform || undefined,
            genericName: row.genericName,
            targetItem: row.targetItem,
            targetOption: row.targetOption,
            category: row.category === "__newcat__" ? row.customCategory.trim() || "其他" : row.category
          }
        })
    })
  }

  return (
    <div className="restock-modal-overlay">
      <div className="restock-modal order-import-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3>从订单截图导入</h3>
          <button className="icon-button modal-close-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="modal-body">
          {step === "pick" && (
            <div className="order-import-pick">
              <div
                className="order-import-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const files = Array.from(event.dataTransfer.files).filter((entry) => entry.type.startsWith("image/"))
                  if (files.length) void recognize(files)
                }}
              >
                <button type="button" className="primary-button green" onClick={() => fileInputRef.current?.click()}>选择订单截图</button>
                <p className="order-import-hint">支持京东、拼多多、淘宝等订单页截图，一次最多 {MAX_ORDER_IMAGES} 张。</p>
                <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileChange} />
              </div>
              {!apiKey && (
                <p className="order-import-key-hint">
                  识别能力需要 API Key 才能使用。
                  <button type="button" className="text-button" onClick={onOpenSettings}>去设置填写</button>
                </p>
              )}
              {error && <p className="form-error" role="alert">{error}</p>}
            </div>
          )}

          {step === "loading" && (
            <div className="order-import-loading" role="status" aria-live="polite">
              <span className="order-import-spinner" aria-hidden="true" />
              <p>{progress.total > 1 ? `正在识别订单内容（${progress.done}/${progress.total} 张）…` : "正在识别订单内容…"}</p>
              <small>通常需要几秒到十几秒</small>
            </div>
          )}

          {step === "review" && (
            <div className="order-import-review">
              <div className="order-import-rows">
                {rows.map((row) => {
                  const resolvedCategory = row.category === "__newcat__" ? (row.customCategory.trim() || "其他") : row.category
                  const targetItemObj = items.find((item) => item.id === row.targetItem)
                  const categoryItems = items.filter((item) => item.category === resolvedCategory || item.id === row.targetItem)
                  const selectedOption = targetItemObj?.purchaseOptions?.find((option) => option.id === row.targetOption)
                  const unitLabel = selectedOption?.unit || targetItemObj?.unit || "件"
                  const editableName = row.coreName ?? row.brandName ?? row.productName
                  const coreLabel = editableName.trim() || row.brandName || row.productName
                  const matchStatus = row.targetItem === "__skip__"
                    ? "已跳过"
                    : row.targetItem === "__create__"
                      ? "将新建消耗品"
                      : selectedOption
                        ? "已匹配常购商品"
                        : row.targetOption === "__newopt__"
                          ? "将新建常购商品"
                          : "可能需要手动确认"
                  const measureUnitChoices = selectedOption?.measureUnit
                    ? getCompatibleMeasureUnits(selectedOption.measureUnit)
                    : measureUnitDefinitions
                  return (
                    <div key={row.key} className={`order-import-row${row.targetItem === "__skip__" ? " is-skipped" : ""}`}>
                      <div className="order-import-card-title">
                        <label className="order-import-name-field">
                          <span>商品名</span>
                          <input
                            type="text"
                            value={editableName}
                            aria-label="商品名"
                            title={row.productName}
                            onChange={(event) => updateRow(row.key, { coreName: event.target.value })}
                          />
                        </label>
                        <span className="order-import-match-status">{matchStatus}</span>
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
                                updateRow(row.key, {
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
                                onChange={(event) => updateRow(row.key, { customCategory: event.target.value })}
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
                                // 切换目标物品后重新做常购商品匹配；没有命中且有品牌名时默认顺带新建
                                const nextOption = nextItem
                                  ? fuzzyMatchOption(nextItem, [row.coreName, row.productName, row.brandName])
                                  : undefined
                                updateRow(row.key, {
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
                                onChange={(event) => updateRow(row.key, { targetOption: event.target.value })}
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
                            onChange={(event) => updateRow(row.key, { qty: event.target.value === '' ? '' : Number(event.target.value) })}
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
                            onChange={(event) => updateRow(row.key, { measureAmount: event.target.value === '' ? '' : Number(event.target.value) })}
                            placeholder="选填"
                          />
                          <select
                            value={row.measureUnit}
                            aria-label={`${coreLabel}含量单位`}
                            onChange={(event) => updateRow(row.key, { measureUnit: event.target.value })}
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
                            onChange={(event) => updateRow(row.key, { price: event.target.value === '' ? '' : Number(event.target.value) })}
                            placeholder="总价"
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
                            onChange={(event) => updateRow(row.key, { date: event.target.value })}
                          />
                        </label>
                        <label className="order-import-inline-field">
                          <span>平台</span>
                          <select
                            value={row.platform}
                            aria-label={`${coreLabel}购买平台`}
                            onChange={(event) => updateRow(row.key, { platform: event.target.value })}
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
                            onChange={(event) => updateRow(row.key, { review: event.target.value })}
                            placeholder="选填"
                          />
                        </label>
                      </div>

                      {row.duplicate && row.targetItem !== "__skip__" && (
                        <span className="order-import-duplicate-hint">当天已有相同记录，可能重复</span>
                      )}
                    </div>
                  )
                })}
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {step === "review" ? (
            <>
              <button className="btn btn-secondary" onClick={() => { setStep("pick"); setError("") }}>重新选图</button>
              <button className="btn btn-secondary" onClick={onClose}>取消</button>
              <button className="btn btn-primary" onClick={handleConfirm} disabled={includedCount === 0}>
                确认导入 {includedCount} 项
              </button>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={onClose}>取消</button>
          )}
        </div>
      </div>
    </div>
  )
}

function ItemEditorDialog({
  item,
  categories,
  daysUntilDepletion,
  isOpen,
  onClose,
  onRename,
  onMove,
  onDelete,
  onQuickEdit,
  onCalibrate
}: {
  item: ReplenishmentItem | null
  categories: string[]
  daysUntilDepletion: number
  isOpen: boolean
  onClose: () => void
  onRename: (id: string, newName: string) => void
  onMove: (id: string, newCategory: string) => void
  onDelete: (id: string) => void
  onQuickEdit: (item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays">>) => void
  onCalibrate: (item: ReplenishmentItem, remainingDays: number) => void
}) {
  const [name, setName] = useState(item?.name ?? "")
  const [category, setCategory] = useState(item?.category ?? "")
  const [nameError, setNameError] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const [inventoryDays, setInventoryDays] = useState<number | ''>(daysUntilDepletion)
  const [usageIntervalDays, setUsageIntervalDays] = useState<number | ''>(item?.cycleDays ?? '')
  const [bufferDays, setBufferDays] = useState<number | ''>(item?.bufferDays ?? '')

  // 组件始终挂载，需在早退判断之前调用 hooks；切换物品或重新打开时同步表单状态
  useEffect(() => {
    if (isOpen && item) {
      setName(item.name)
      setCategory(item.category)
      setNameError("")
      setInventoryDays(daysUntilDepletion)
      setUsageIntervalDays(item.cycleDays ?? '')
      setBufferDays(item.bufferDays ?? '')
    }
  }, [isOpen, item?.id])

  if (!isOpen || !item) return null

  function handleInventoryDaysBlur() {
    const parsed = Number(inventoryDays)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed !== daysUntilDepletion) {
      onCalibrate(item!, Math.round(parsed))
    } else if (inventoryDays === '' || !Number.isFinite(parsed)) {
      setInventoryDays(daysUntilDepletion)
    }
  }

  function handleUsageIntervalBlur() {
    const parsed = Number(usageIntervalDays)
    if (Number.isFinite(parsed) && parsed > 0 && parsed !== item!.cycleDays) {
      onQuickEdit(item!, { cycleDays: Math.max(1, Math.round(parsed)), bufferDays: Math.min(item!.bufferDays, Math.max(0, Math.round(parsed) - 1)) })
    } else if (usageIntervalDays === '' || !Number.isFinite(parsed) || parsed < 1) {
      setUsageIntervalDays(item!.cycleDays ?? '')
    }
  }

  function handleBufferDaysBlur() {
    const parsed = Number(bufferDays)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed !== item!.bufferDays) {
      onQuickEdit(item!, { bufferDays: Math.round(parsed) })
    } else if (bufferDays === '' || !Number.isFinite(parsed)) {
      setBufferDays(item!.bufferDays ?? '')
    }
  }

  const handleSave = () => {
    const normalizedName = name.trim()
    if (!normalizedName) {
      setNameError("请输入物品名称")
      nameInputRef.current?.focus()
      return
    }
    if (normalizedName !== item.name) {
      onRename(item.id, normalizedName)
    }
    if (category !== item.category) {
      onMove(item.id, category)
    }
    onClose()
  }

  const handleDelete = () => {
    setConfirmDelete(true)
  }

  const confirmDeleteAction = () => {
    onDelete(item.id)
    onClose()
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog-container item-editor-dialog">
        <div className="dialog-header">
          <h2>编辑物品</h2>
          <button className="icon-button close-btn" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="dialog-form">
          <div className="editor-grid">
            {/* 第1行：名称、分类 */}
            <div className="form-group">
              <label>消耗品名称</label>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (nameError && e.target.value.trim()) setNameError("")
                }}
                autoFocus
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? "item-editor-dialog-name-error" : undefined}
              />
              {nameError && <small id="item-editor-dialog-name-error" className="field-error" role="alert">{nameError}</small>}
            </div>

            <div className="form-group">
              <label>分类</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            {/* 第2行：提醒天数、库存周期 */}
            <div className="form-group">
              <label>提醒天数</label>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="0"
                  value={bufferDays}
                  onChange={(e) => setBufferDays(e.target.value === '' ? '' : Number(e.target.value))}
                  onBlur={() => handleBufferDaysBlur()}
                  placeholder="例如：3"
                />
                <span className="unit-label">天</span>
              </div>
            </div>

            <div className="form-group">
              <label>库存周期</label>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="0"
                  value={inventoryDays}
                  onChange={(e) => setInventoryDays(e.target.value === '' ? '' : Number(e.target.value))}
                  onBlur={() => handleInventoryDaysBlur()}
                  placeholder="例如：20"
                />
                <span className="unit-label">天</span>
              </div>
            </div>

            {/* 第3行：消耗周期 */}
            <div className="form-group">
              <label>消耗周期</label>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="1"
                  value={usageIntervalDays}
                  onChange={(e) => setUsageIntervalDays(e.target.value === '' ? '' : Number(e.target.value))}
                  onBlur={() => handleUsageIntervalBlur()}
                  placeholder="例如：30"
                />
                <span className="unit-label">天</span>
              </div>
            </div>
          </div>

          <div className="dialog-actions">
            {confirmDelete ? (
              <>
                <button className="quiet-button" onClick={() => setConfirmDelete(false)}>取消</button>
                <button className="danger-button" onClick={confirmDeleteAction}>确认删除</button>
              </>
            ) : (
              <>
                <button className="quiet-button danger" onClick={handleDelete}>删除</button>
                <div style={{ flex: 1 }} />
                <button className="quiet-button" onClick={onClose}>取消</button>
                <button className="primary-button green" onClick={handleSave}>保存</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const itemCreatorFieldHelp = {
  inventory: { label: '库存周期', description: '当前库存预计还能使用多少天。' },
  usage: { label: '消耗周期', description: '一次补货通常可以使用多少天。' },
  buffer: { label: '提醒天数', description: '预计用完前多少天提醒补货。' }
} as const

type ItemCreatorFieldHelpKey = keyof typeof itemCreatorFieldHelp

function ItemCreatorDialog({
  category,
  isOpen,
  onClose,
  onCreate
}: {
  category: string
  isOpen: boolean
  onClose: () => void
  onCreate: (item: { name: string; unit?: string; inventoryDays?: number; usageIntervalDays?: number; bufferDays?: number }) => void
}) {
  const [name, setName] = useState('')
  const [inventoryDays, setInventoryDays] = useState<number | ''>(30)
  const [usageIntervalDays, setUsageIntervalDays] = useState<number | ''>(30)
  const [bufferDays, setBufferDays] = useState<number | ''>('')
  const [activeFieldHelp, setActiveFieldHelp] = useState<ItemCreatorFieldHelpKey | null>(null)
  const [nameError, setNameError] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const normalizedName = name.trim()
    if (!normalizedName) {
      setNameError('请输入消耗品名称')
      nameInputRef.current?.focus()
      return
    }
    onCreate({
      name: normalizedName,
      inventoryDays: inventoryDays === '' ? undefined : inventoryDays,
      usageIntervalDays: usageIntervalDays === '' ? undefined : usageIntervalDays,
      bufferDays: bufferDays === '' ? undefined : bufferDays
    })
    onClose()
  }

  return (
    <>
      <div className="dialog-overlay">
        <div className="dialog-container item-creator-dialog">
          <div className="dialog-header">
            <h2>添加消耗品</h2>
            <button className="icon-button close-btn" onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="dialog-form">
            <div className="form-row item-creator-settings-grid">
              <div className="form-group">
                <label htmlFor="item-creator-name">名称</label>
                <input
                  ref={nameInputRef}
                  id="item-creator-name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (nameError && e.target.value.trim()) setNameError('')
                  }}
                  placeholder="例如：猫砂、洗衣液"
                  autoFocus
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={nameError ? "item-creator-name-error" : undefined}
                />
                {nameError && <small id="item-creator-name-error" className="field-error" role="alert">{nameError}</small>}
              </div>

              <div className="form-group">
                <div className="field-label-with-help">
                  <label htmlFor="item-creator-inventory-days">库存周期</label>
                  <button
                    type="button"
                    className="field-help-button"
                    aria-label={activeFieldHelp === 'inventory' ? "收起库存周期说明" : "查看库存周期说明"}
                    aria-expanded={activeFieldHelp === 'inventory'}
                    aria-controls="item-creator-inventory-help"
                    aria-describedby={activeFieldHelp === 'inventory' ? "item-creator-inventory-help" : undefined}
                    onClick={() => setActiveFieldHelp((current) => current === 'inventory' ? null : 'inventory')}
                    onBlur={() => setActiveFieldHelp((current) => current === 'inventory' ? null : current)}
                  >
                    ?
                  </button>
                  {activeFieldHelp === 'inventory' && (
                    <div id="item-creator-inventory-help" className="field-help-popover" role="tooltip">
                      {itemCreatorFieldHelp.inventory.description}
                    </div>
                  )}
                </div>
                <div className="input-with-unit">
                  <input
                    id="item-creator-inventory-days"
                    type="number"
                    min="0"
                    value={inventoryDays}
                    onChange={(e) => setInventoryDays(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="例如：20"
                  />
                  <span className="unit-label">天</span>
                </div>
              </div>

              <div className="form-group">
                <div className="field-label-with-help">
                  <label htmlFor="item-creator-usage-days">消耗周期</label>
                  <button
                    type="button"
                    className="field-help-button"
                    aria-label={activeFieldHelp === 'usage' ? "收起消耗周期说明" : "查看消耗周期说明"}
                    aria-expanded={activeFieldHelp === 'usage'}
                    aria-controls="item-creator-usage-help"
                    aria-describedby={activeFieldHelp === 'usage' ? "item-creator-usage-help" : undefined}
                    onClick={() => setActiveFieldHelp((current) => current === 'usage' ? null : 'usage')}
                    onBlur={() => setActiveFieldHelp((current) => current === 'usage' ? null : current)}
                  >
                    ?
                  </button>
                  {activeFieldHelp === 'usage' && (
                    <div id="item-creator-usage-help" className="field-help-popover" role="tooltip">
                      {itemCreatorFieldHelp.usage.description}
                    </div>
                  )}
                </div>
                <div className="input-with-unit">
                  <input
                    id="item-creator-usage-days"
                    type="number"
                    min="1"
                    value={usageIntervalDays}
                    onChange={(e) => setUsageIntervalDays(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="例如：30"
                  />
                  <span className="unit-label">天</span>
                </div>
              </div>

              <div className="form-group">
                <div className="field-label-with-help">
                  <label htmlFor="item-creator-buffer-days">提醒天数</label>
                  <button
                    type="button"
                    className="field-help-button"
                    aria-label={activeFieldHelp === 'buffer' ? "收起提醒天数说明" : "查看提醒天数说明"}
                    aria-expanded={activeFieldHelp === 'buffer'}
                    aria-controls="item-creator-buffer-help"
                    aria-describedby={activeFieldHelp === 'buffer' ? "item-creator-buffer-help" : undefined}
                    onClick={() => setActiveFieldHelp((current) => current === 'buffer' ? null : 'buffer')}
                    onBlur={() => setActiveFieldHelp((current) => current === 'buffer' ? null : current)}
                  >
                    ?
                  </button>
                  {activeFieldHelp === 'buffer' && (
                    <div id="item-creator-buffer-help" className="field-help-popover" role="tooltip">
                      {itemCreatorFieldHelp.buffer.description}
                    </div>
                  )}
                </div>
                <div className="input-with-unit">
                  <input
                    id="item-creator-buffer-days"
                    type="number"
                    min="0"
                    max={usageIntervalDays === '' ? undefined : Math.max(0, usageIntervalDays - 1)}
                    value={bufferDays}
                    onChange={(e) => setBufferDays(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="例如：3"
                  />
                  <span className="unit-label">天</span>
                </div>
              </div>
            </div>

            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={onClose}>取消</button>
              <button type="submit" className="primary-button green">添加</button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

interface PurchaseOptionModalProps {
  isOpen: boolean
  onClose: () => void
  option?: PurchaseOption | null
  onSave: (option: Omit<PurchaseOption, 'id'>) => void
}

function PurchaseOptionModal({ isOpen, onClose, option = null, onSave }: PurchaseOptionModalProps) {
  const [productName, setProductName] = useState('')
  const [productSpec, setProductSpec] = useState('')
  const [specUnitPreset, setSpecUnitPreset] = useState('')
  const [pricingMode, setPricingMode] = useState<PricingMode>('spec')
  const [measureUnit, setMeasureUnit] = useState('')
  const [measureBaseAmount, setMeasureBaseAmount] = useState<number | ''>(1)
  const [customUnitName, setCustomUnitName] = useState('')
  const [customUnitDimension, setCustomUnitDimension] = useState('count')
  const [customUnitFactor, setCustomUnitFactor] = useState<number | ''>(1)
  const [image, setImage] = useState<string | undefined>()
  const imageInputRef = useRef<HTMLInputElement>(null)

  const isEditing = option !== null

  useEffect(() => {
    if (!isOpen) return
    setProductName(option?.productName || '')
    const nextSpec = option?.unit || ''
    setProductSpec(nextSpec)
    setSpecUnitPreset(nextSpec ? (purchaseSpecUnitOptions.includes(nextSpec as typeof purchaseSpecUnitOptions[number]) ? nextSpec : '__custom__') : '')
    const nextPricingMode = option?.pricingMode || (option?.measureUnit ? 'measure' : 'spec')
    setPricingMode(nextPricingMode)
    const customUnit = parseCustomMeasureUnit(option?.measureUnit)
    setMeasureUnit(customUnit ? '__custom__' : option?.measureUnit || '')
    setMeasureBaseAmount(option?.measureBaseAmount || (option?.measureUnit ? getMeasureUnitDefinition(option.measureUnit)?.defaultBaseAmount || 1 : 1))
    setCustomUnitName(customUnit?.label || '')
    setCustomUnitDimension(customUnit?.dimension || 'count')
    setCustomUnitFactor(customUnit?.factor || 1)
    setImage(option?.image)
  }, [isOpen, option])

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setImage(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  const handleRemoveImage = () => {
    setImage(undefined)
    if (imageInputRef.current) imageInputRef.current.value = ''
  }

  const handleSubmit = () => {
    const normalizedProductName = productName.trim()
    const normalizedSpec = productSpec.trim()
    const isMeasureMode = pricingMode === 'measure'
    const finalMeasureUnit = measureUnit === '__custom__'
      ? encodeCustomMeasureUnit(customUnitName, customUnitDimension, Number(customUnitFactor))
      : measureUnit
    const finalBaseAmount = Number(measureBaseAmount)
    if (!normalizedProductName || !normalizedSpec) return
    if (isMeasureMode && (!finalMeasureUnit || !Number.isFinite(finalBaseAmount) || finalBaseAmount <= 0)) return
    if (isMeasureMode && measureUnit === '__custom__' && (!customUnitName.trim() || !Number.isFinite(Number(customUnitFactor)) || Number(customUnitFactor) <= 0)) return
    
    onSave({
      productName: normalizedProductName,
      unit: normalizedSpec,
      pricingMode,
      measureUnit: isMeasureMode ? finalMeasureUnit.trim() || undefined : undefined,
      measureBaseAmount: isMeasureMode ? finalBaseAmount : undefined,
      isDefault: option?.isDefault ?? false,
      link: option?.link,
      image: image || undefined,
    })
    onClose()
  }
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }
  
  if (!isOpen) return null
  const isMeasureMode = pricingMode === 'measure'
  const specUnitLabel = productSpec.trim() || '规格'
  const pricingUnitLabel = isMeasureMode
    ? measureUnit === '__custom__' ? customUnitName || '单位' : getMeasureUnitDisplay(measureUnit)
    : specUnitLabel
  const canSubmit = Boolean(productName.trim() && productSpec.trim()) && (
    pricingMode === 'spec' || (
      measureUnit && Number(measureBaseAmount) > 0 && (
        measureUnit !== '__custom__' || Boolean(customUnitName.trim() && Number(customUnitFactor) > 0)
      )
    )
  )
  
  return (
    <div className="modal-overlay">
      <div className="modal-container">
        <div className="modal-header">
          <h3>{isEditing ? '编辑商品' : '添加商品'}</h3>
          <button className="icon-button modal-close-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        
        <div className="modal-body">
          {/* 图片上传 */}
          <div className="form-row">
            <div className="form-group">
              <label>图片：</label>
              <div className="option-image-upload">
                {image ? (
                  <div className="option-image-preview">
                    <img src={image} alt="商品图片" />
                    <button
                      type="button"
                      className="option-image-remove"
                      onClick={handleRemoveImage}
                      title="移除图片"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="option-image-placeholder"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <span className="option-image-plus">+</span>
                    <span>添加图片</span>
                  </button>
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleImageChange}
                />
              </div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>商品名称：</label>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="例如：皇家猫粮 L40"
                autoFocus
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>规格：</label>
              <select
                value={specUnitPreset}
                onChange={(e) => {
                  const nextSpec = e.target.value
                  setSpecUnitPreset(nextSpec)
                  if (nextSpec !== '__custom__') setProductSpec(nextSpec)
                  else setProductSpec('')
                }}
                onKeyDown={handleKeyDown}
              >
                <option value="">选择规格</option>
                {purchaseSpecUnitOptions.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                <option value="__custom__">自定义规格</option>
              </select>
              {specUnitPreset === '__custom__' && (
                <input
                  className="spec-custom-input"
                  type="text"
                  value={productSpec}
                  onChange={(e) => setProductSpec(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="例如：套、条、组"
                />
              )}
            </div>
            <div className="form-group">
              <label>计价方式：</label>
              <div className="segment-control pricing-mode-control" role="group" aria-label="计价方式">
                <button type="button" className={pricingMode === 'spec' ? 'active' : ''} aria-pressed={pricingMode === 'spec'} onClick={() => setPricingMode('spec')}>{pricingModeLabels.spec}</button>
                <button type="button" className={pricingMode === 'measure' ? 'active' : ''} aria-pressed={pricingMode === 'measure'} onClick={() => setPricingMode('measure')}>{pricingModeLabels.measure}</button>
              </div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>常用计量单位：</label>
              {isMeasureMode ? (
                <select
                  value={measureUnit}
                  onChange={(e) => {
                    const nextUnit = e.target.value
                    setMeasureUnit(nextUnit)
                    const definition = getMeasureUnitDefinition(nextUnit)
                    if (definition) setMeasureBaseAmount(definition.defaultBaseAmount)
                  }}
                  onKeyDown={handleKeyDown}
                >
                  <option value="">选择单位</option>
                  {measureUnitDefinitions.map((unit) => (
                    <option key={unit.value} value={unit.value}>{unit.label}</option>
                  ))}
                  <option value="__custom__">自定义单位</option>
                </select>
              ) : (
                <input type="text" value={specUnitLabel} readOnly disabled aria-label="按规格计价单位" />
              )}
            </div>
            <div className="form-group">
              <label>计价口径：</label>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={isMeasureMode ? measureBaseAmount : 1}
                  onChange={(e) => setMeasureBaseAmount(e.target.value === '' ? '' : Number(e.target.value))}
                  disabled={!isMeasureMode}
                  placeholder="例如：100"
                />
                <span className="unit-label">{pricingUnitLabel}</span>
              </div>
            </div>
          </div>
          {isMeasureMode && measureUnit === '__custom__' && (
            <div className="form-row custom-measure-row">
              <div className="form-group">
                <label>自定义单位名：</label>
                <input value={customUnitName} onChange={(e) => setCustomUnitName(e.target.value)} placeholder="例如：斤、片、板" />
              </div>
              <div className="form-group">
                <label>所属维度：</label>
                <select value={customUnitDimension} onChange={(e) => setCustomUnitDimension(e.target.value)}>
                  <option value="mass">重量</option>
                  <option value="volume">容量</option>
                  <option value="count">计数</option>
                </select>
              </div>
              <div className="form-group field-wide">
                <label>换算关系：</label>
                <div className="custom-conversion-row">
                  <span>1 {customUnitName || '自定义单位'} =</span>
                  <input type="number" min="0.01" step="0.01" value={customUnitFactor} onChange={(e) => setCustomUnitFactor(e.target.value === '' ? '' : Number(e.target.value))} />
                  <span>{getMeasureDimensionBaseUnit(customUnitDimension)}</span>
                </div>
              </div>
            </div>
          )}
          {pricingMode === 'spec' && <p className="form-muted-note">按规格计价时，补货会直接计算每 {productSpec.trim() || '件'} 单价，不填写含量。</p>}
          {pricingMode === 'measure' && <p className="form-muted-note">按含量计价时，补货记录只会和同一计价方式的记录比较历史最低价。</p>}
        </div>
        
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button 
            className="btn btn-primary" 
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {isEditing ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ReviewEditModalProps {
  isOpen: boolean
  onClose: () => void
  record: RestockEvent | null
  itemName: string
  initialReview: string
  onSave: (review: string) => void
}

function ReviewEditModal({ isOpen, onClose, record, itemName, initialReview, onSave }: ReviewEditModalProps) {
  const [reviewText, setReviewText] = useState(initialReview)
  
  useEffect(() => {
    setReviewText(initialReview)
  }, [initialReview])
  
  const handleSubmit = () => {
    onSave(reviewText.trim())
    onClose()
  }
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }
  
  if (!isOpen || !record) return null
  
  return (
    <div className="modal-overlay">
      <div className="modal-container">
        <div className="modal-header">
          <h3>{record.review ? "编辑评价" : "添加评价"}</h3>
          <button className="icon-button modal-close-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        
        <div className="modal-body">
          <div className="form-group">
            <textarea
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入您的评价..."
              autoFocus
              className="review-textarea"
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button 
            className="btn btn-primary" 
            onClick={handleSubmit}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}

function CategoryWorkArea({ category, views, onAddItem, onRename, onDelete, onEdit, onSnooze, onRestock, onCalibrate, onQuickEdit, onApplySuggestion, onDismissSuggestion, onOpenItem, onOpenItemEditor, onRestockFromOption, showAddPurchaseModal, setShowAddPurchaseModal, addPurchaseOptionItemId, setAddPurchaseOptionItemId, editingPurchaseOption, setEditingPurchaseOption, editModalOpen, setEditModalOpen, onEditPurchaseOption, onDeletePurchaseOption, onSaveEditedOption, onEditRestockRecord }: {
  category: string
  views: ItemView[]
  onAddItem: () => void
  onRename: () => void
  onDelete: () => void
  onEdit: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onCalibrate: (item: ReplenishmentItem, remainingDays: number) => void
  onQuickEdit: (item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform" | "purchaseOptions">>) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onOpenItem: (item: ReplenishmentItem) => void
  onOpenItemEditor: (itemId: string) => void
  onRestockFromOption: (itemId: string, option: PurchaseOption) => void
  showAddPurchaseModal: boolean
  setShowAddPurchaseModal: React.Dispatch<React.SetStateAction<boolean>>
  addPurchaseOptionItemId: string | null
  setAddPurchaseOptionItemId: React.Dispatch<React.SetStateAction<string | null>>
  editingPurchaseOption: PurchaseOption | null
  setEditingPurchaseOption: React.Dispatch<React.SetStateAction<PurchaseOption | null>>
  editModalOpen: boolean
  setEditModalOpen: React.Dispatch<React.SetStateAction<boolean>>
  onEditPurchaseOption: (option: PurchaseOption) => void
  onDeletePurchaseOption: (itemId: string, optionId: string) => void
  onSaveEditedOption: (editedOption: PurchaseOption) => void
  onEditRestockRecord: (itemId: string, recordId: string) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<{ id: string; field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "platform" } | null>(null)
  const [editValue, setEditValue] = useState("")
  const [savedFieldKey, setSavedFieldKey] = useState<string | null>(null)
  const [showActionMenu, setShowActionMenu] = useState<string | null>(null) // 操作菜单显示状态
  const [historyExpanded, setHistoryExpanded] = useState<Set<string>>(new Set())
  const [purchaseOptionsExpanded, setPurchaseOptionsExpanded] = useState<Set<string>>(new Set())
  const [pendingDeleteOption, setPendingDeleteOption] = useState<{ itemId: string; optionId: string } | null>(null)
  const cardImageInputRef = useRef<HTMLInputElement>(null)
  const [cardImageUploadTarget, setCardImageUploadTarget] = useState<{ itemId: string; option: PurchaseOption } | null>(null)

  function handleCardImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !cardImageUploadTarget) return
    const reader = new FileReader()
    reader.onload = () => {
      onSaveEditedOption({
        ...cardImageUploadTarget.option,
        image: reader.result as string
      })
      setCardImageUploadTarget(null)
    }
    reader.readAsDataURL(file)
    if (cardImageInputRef.current) cardImageInputRef.current.value = ''
  }

  // Escape key to collapse expanded item
  useEffect(() => {
    if (expandedId === null) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setExpandedId(null)
        setEditingField(null)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [expandedId])

  // 点击外部关闭操作菜单
  useEffect(() => {
    if (!showActionMenu) return
    
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement
      // 如果点击的不是操作菜单或其子元素，则关闭菜单
      if (!target.closest('.action-menu') && !target.closest('.edit-option-btn')) {
        setShowActionMenu(null)
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showActionMenu])

  function toggleExpand(item: ReplenishmentItem, computed: ItemComputed) {
    if (expandedId === item.id) {
      setExpandedId(null)
      setEditingField(null)
    } else {
      setExpandedId(item.id)
      setEditingField(null)
    }
  }

  function startEditing(itemId: string, field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "platform", currentValue: number | string) {
    setEditingField({ id: itemId, field })
    setEditValue(String(currentValue))
  }

  function flashSaved(key: string) {
    setSavedFieldKey(key)
    setTimeout(() => setSavedFieldKey(null), 1200)
  }

  function saveEditing(item: ReplenishmentItem) {
    if (!editingField) return
    if (editingField.field === "link") {
      onQuickEdit(item, { link: editValue || undefined })
      flashSaved(`${item.id}-link`)
      setEditingField(null)
      return
    }
    if (editingField.field === "defaultQty") {
      const trimmed = editValue.trim()
      const num = Number(trimmed)
      onQuickEdit(item, { defaultQty: trimmed && Number.isFinite(num) && num > 0 ? Math.round(num) : undefined })
      flashSaved(`${item.id}-defaultQty`)
      setEditingField(null)
      return
    }
    const num = Number(editValue)
    if (isNaN(num) || num < 1) { setEditingField(null); return }
    if (editingField.field === "cycleDays") {
      onQuickEdit(item, { cycleDays: Math.max(1, num) })
      flashSaved(`${item.id}-cycleDays`)
    } else {
      onQuickEdit(item, { bufferDays: Math.max(0, num) })
      flashSaved(`${item.id}-bufferDays`)
    }
    setEditingField(null)
  }

  return (
    <div className="category-work-area">
      {/* header */}
      <div className="work-header">
        <div className="work-header-left">
          <h2 className="work-title">{category}</h2>
          <span className="work-meta">{views.length} 项</span>
        </div>
        <button className="primary-button green" onClick={onAddItem}>添加消耗品</button>
      </div>

      {/* item list */}
      <div className="work-item-list">
        {views.map(({ item, computed }) => (
          <div key={item.id} className={`category-item-group ${expandedId === item.id ? "is-expanded" : ""}`}>
            <div className={`category-item ${expandedId === item.id ? "is-expanded" : ""}`}>
              <div
                className="category-item-main"
                role="button"
                tabIndex={0}
                aria-expanded={expandedId === item.id}
                onClick={() => toggleExpand(item, computed)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    toggleExpand(item, computed)
                  }
                }}
              >
                {/* 左侧状态圆点 */}
                <span className={`status-dot ${computed.displayStatus}`} />
                <div className="category-item-copy">
                  <div className="item-title-row"><strong>{item.name}</strong></div>
                  <div className="category-item-meta-row">
                    <span className="category-item-status-action">{formatItemStatusText(item, computed)}</span>
                    <button
                      type="button"
                      className="inline-detail-action"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenItem(item)
                      }}
                      aria-label={`查看${item.name}详情`}
                    >
                      查看详情
                    </button>
                  </div>
                </div>
              </div>
              <button type="button" className="icon-button item-edit-btn-inline" onClick={() => onOpenItemEditor(item.id)} aria-label={`编辑${item.name}`}>
                <Icon name="edit" size={14} />
              </button>
              <span className={`status-label ${computed.displayStatus}`}>{computed.statusLabel}</span>
              <button type="button" className="category-item-expand" onClick={() => toggleExpand(item, computed)} aria-label={expandedId === item.id ? `收起${item.name}` : `展开${item.name}`} aria-expanded={expandedId === item.id}>
                <span className={`category-item-arrow ${expandedId === item.id ? "is-open" : ""}`}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></span>
              </button>
            </div>
            {expandedId === item.id && (
              <div className="category-item-detail">
                {item.source === "onboarding" && (
                  <div className="detail-section category-model-section">
                    <h4 className="section-title">初始化模型</h4>
                    <div className="category-model-grid">
                      <div><span>预测周期</span><strong>约 {item.cycleDays} 天</strong></div>
                      <div><span>置信度</span><strong>{item.confidence === "high" ? "高" : item.confidence === "medium" ? "中" : "低"}</strong></div>
                      <div className="category-model-note"><span>最近校准</span><strong>{item.modelNote || "基于家庭画像和库存状态估算"}</strong><small>{item.history.length < 2 ? `再记录 ${2 - item.history.length} 次补货后会更准。` : "已开始学习你家的真实周期。"}</small></div>
                    </div>
                  </div>
                )}
                
                {/* 区块2：常购商品 */}
                <div className="detail-section">
                  <h4 className="section-title">常购商品</h4>
                  <div className="section-content">
                    {(() => {
                      const options = item.purchaseOptions || []
                      const isOptionsExpanded = purchaseOptionsExpanded.has(item.id)
                      const SHELF_LIMIT = 6
                      const visibleOptions = isOptionsExpanded ? options : options.slice(0, SHELF_LIMIT)
                      const hasMoreOptions = options.length > SHELF_LIMIT
                      const handleAddOption = () => {
                        setAddPurchaseOptionItemId(item.id)
                        setShowAddPurchaseModal(true)
                      }
                      return (
                        <div>
                          <div className="purchase-shelf-grid">
	                            {visibleOptions.map(option => {
	                              const historicalLowest = getOptionHistoricalLowest(item, option)
	                              return (
                              <div
                                key={option.id}
                                className={`purchase-shelf-card${option.isDefault ? ' is-default' : ''}`}
                              >
                                {/* [默认] badge - 左上角 */}
                                {option.isDefault && (
                                  <span className="purchase-shelf-badge">默认</span>
                                )}

                                {/* 编辑图标（右上角，hover 出现） */}
                                <div className="purchase-shelf-edit-group">
                                  <button
                                    className="purchase-shelf-edit-btn"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setShowActionMenu(showActionMenu === option.id ? null : option.id)
                                    }}
                                    title="操作"
                                    aria-label={`管理${option.productName}`}
                                  >
                                    <svg
                                      className="action-icon"
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                      <path d="m15 5 4 4" />
                                    </svg>
                                  </button>
                                  {/* 操作菜单 */}
                                  {showActionMenu === option.id && (
                                    <div className="action-menu">
                                      <button
                                        className="action-menu-item"
                                        onClick={() => {
                                          onEditPurchaseOption(option)
                                          setShowActionMenu(null)
                                        }}
                                      >
                                        编辑
                                      </button>
                                      <button
                                        className="action-menu-item danger"
                                        onClick={() => {
                                          onDeletePurchaseOption(item.id, option.id)
                                          setShowActionMenu(null)
                                        }}
                                      >
                                        删除
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* 顶部区域：图片 + 商品信息 */}
                                <div className="purchase-shelf-top">
                                  {/* 图片区 */}
                                  <div className="purchase-shelf-image">
                                    {option.image ? (
                                      <img src={option.image} alt={option.productName} />
                                    ) : (
                                      <button
                                        type="button"
                                        className="purchase-shelf-image-placeholder"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setCardImageUploadTarget({ itemId: item.id, option })
                                          cardImageInputRef.current?.click()
                                        }}
                                        title="添加图片"
                                        aria-label={`为${option.productName}添加图片`}
                                      >
                                        <span className="purchase-shelf-image-plus">+</span>
                                      </button>
                                    )}
                                  </div>

	                                  {/* 商品信息 */}
	                                  <div className="purchase-shelf-info">
	                                    <p className="purchase-shelf-name">
	                                      <span className="purchase-shelf-product-name">{option.productName}</span>
	                                    </p>
	                                    <div className="purchase-shelf-platform-price">
	                                      <span className="purchase-shelf-price">{getPurchaseOptionPricingLabel(option, item)}</span>
	                                    </div>
	                                  </div>
	                                </div>

                                  <div className={`purchase-shelf-price-anchor${historicalLowest ? ' has-price' : ''}`}>
                                    <span className="price-anchor-label">历史最低</span>
                                    <strong>{historicalLowest ? historicalLowest.label : '暂无价格记录'}</strong>
                                  </div>

	                                {/* spacer */}
                                <span className="purchase-shelf-spacer" />

                                {/* 补货按钮 */}
                                <button
                                  type="button"
                                  className="purchase-shelf-restock-btn"
                                  onClick={() => onRestockFromOption(item.id, option)}
                                >
                                  按此选项补货
                                </button>
                              </div>
                              )
                            })}

                            {/* 添加选项虚线空卡 */}
                            <button
                              type="button"
                              className="purchase-shelf-add-card"
                              onClick={handleAddOption}
                            >
                              <span className="purchase-shelf-add-icon">+</span>
                              <span>添加商品</span>
                            </button>
                          </div>

                          {/* 查看更多 / 收起（网格下方居中） */}
                          {hasMoreOptions && (
                            <button
                              className="purchase-shelf-show-more"
                              onClick={() => {
                                setPurchaseOptionsExpanded(prev => {
                                  const next = new Set(prev)
                                  if (next.has(item.id)) {
                                    next.delete(item.id)
                                  } else {
                                    next.add(item.id)
                                  }
                                  return next
                                })
                              }}
                            >
                              {isOptionsExpanded ? '收起' : `查看更多 (${options.length - SHELF_LIMIT}) ›`}
                            </button>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
                
                {/* 区块3：补货记录 */}
                <div className="detail-section">
                  <h4 className="section-title">补货记录</h4>
                  <div className="section-content">
                    {item.history && item.history.length > 0 ? (
                      <div className="restock-history-list">
                        {(() => {
                          const sorted = item.history.slice().reverse()
                          const isExpanded = historyExpanded.has(item.id)
                          const visibleRecords = isExpanded ? sorted : sorted.slice(0, 5)
                          const hasMore = sorted.length > 5
                          return (
                            <>
                              {visibleRecords.map((record) => {
                                const recordProductName = record.purchaseProductName || item.name
                                const recordUnit = record.purchaseUnit || item.unit || '件'
                                const reviewPreview = record.review ? getReviewPreview(record.review) : null
                                return (
                                  <div key={record.id} className="restock-record compact">
                                    {/* 左侧：所有关键信息 */}
                                    <div className="record-info">
                                      {record.platform && <span className="purchase-shelf-platform record-platform-tag" data-platform={record.platform}>{record.platform}</span>}
                                      <span className="record-date">{formatFullDate(record.at)}</span>
                                      <span className="record-separator">·</span>
                                      <span className="record-product">{recordProductName}</span>
                                      {record.qty && (
                                        <>
                                          <span className="record-separator">·</span>
                                          <span className="record-qty">{record.qty} {recordUnit}</span>
                                        </>
                                      )}
                                      <span className="record-separator">·</span>
                                      <span className="record-price">¥{record.price?.toFixed(2) || '0.00'}</span>
                                      {reviewPreview && (
                                        <>
                                          <span className="record-separator">·</span>
                                          <span className={`record-review-inline${reviewPreview.isTruncated ? ' has-tooltip' : ''}`} tabIndex={reviewPreview.isTruncated ? 0 : undefined}>
                                            {reviewPreview.text}
                                            {reviewPreview.isTruncated && <span className="record-review-tooltip">{record.review}</span>}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                    <button
                                      type="button"
                                      className="icon-button restock-record-edit-btn"
                                      onClick={() => onEditRestockRecord(item.id, record.id)}
                                      aria-label={`修改${recordProductName}${formatFullDate(record.at)}的补货记录`}
                                    >
                                      <Icon name="edit" size={13} />
                                    </button>
                                  </div>
                                )
                              })}
                              {hasMore && (
                                <button
                                  className="history-toggle-btn"
                                  onClick={() => {
                                    setHistoryExpanded(prev => {
                                      const next = new Set(prev)
                                      if (next.has(item.id)) {
                                        next.delete(item.id)
                                      } else {
                                        next.add(item.id)
                                      }
                                      return next
                                    })
                                  }}
                                >
                                  {isExpanded ? '收起' : `查看更多 (${sorted.length - 5})`}
                                </button>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    ) : (
                      <p className="empty-hint">暂无补货记录</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
        {!views.length && <div className="empty-category">这个分类还没有记录</div>}
      </div>

      {/* 编辑商品弹窗 */}
      <PurchaseOptionModal
        isOpen={editModalOpen}
        onClose={() => {
          setEditModalOpen(false)
          setEditingPurchaseOption(null)
        }}
        option={editingPurchaseOption}
        onSave={(optionData) => {
          if (!editingPurchaseOption) return
          onSaveEditedOption({
            ...editingPurchaseOption,
            ...optionData
          })
        }}
      />

      {/* 卡片图片直传隐藏 input */}
      <input
        ref={cardImageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleCardImageChange}
      />
    </div>
  )
}

function Sidebar({ dueCount, categorySummaries, allItems, now, activeCategory, pendingDelete, onSelectCategory, onCreateCategory, onOpenSettings, onRenameCategory, onRequestDeleteCategory, onCancelDeleteCategory, onConfirmDeleteCategory }: {
  dueCount: number
  categorySummaries: Array<{ category: string; views: ItemView[]; urgent: number; warning: number }>
  allItems: ReplenishmentItem[]
  now: number
  activeCategory: string | null
  onSelectCategory: (category: string | null) => void
  onCreateCategory: () => void
  onOpenSettings: () => void
  onRenameCategory: (oldName: string, newName: string) => void
  pendingDelete: string | null
  onRequestDeleteCategory: (name: string) => void
  onCancelDeleteCategory: () => void
  onConfirmDeleteCategory: (name: string, options?: DeleteCategoryOptions) => void
}) {
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  // 非空分类删除流程的子状态：idle = 选择处理方式；move = 选择迁移目标；delete-items = 二次确认删除物品
  const [deleteMode, setDeleteMode] = useState<"idle" | "move" | "delete-items">("idle")
  const [moveTarget, setMoveTarget] = useState<string>("")

  // pendingDelete 变化时重置子状态（取消或切换到其他分类时回到初始）
  useEffect(() => {
    setDeleteMode("idle")
    setMoveTarget("")
  }, [pendingDelete])

  return (
    <nav className="sidebar">
      <button
        className={`sidebar-home ${!activeCategory ? "is-active" : ""}`}
        onClick={() => onSelectCategory(null)}
      >
        <span className="sidebar-home-icon">
          {dueCount > 0
            ? <span className="sidebar-due-badge">{dueCount}</span>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          }
        </span>
        <span className="sidebar-home-label">
          {dueCount > 0 ? `${dueCount} 项待处理` : "今天不用补货"}
        </span>
      </button>

      <div className="sidebar-divider" />
      <div className="sidebar-section-heading">
        <span className="sidebar-section-label">分类</span>
        <button
          type="button"
          className="sidebar-section-add"
          onClick={onCreateCategory}
          aria-label="新建分类"
          title="新建分类"
        >
          <Icon name="plus" size={13} />
        </button>
      </div>

      {categorySummaries.map(({ category, views, urgent, warning }) => {
        const dotStatus = urgent ? "urgent" : warning ? "warning" : "normal"
        const isEditing = editingCategory === category
        const isPendingDelete = pendingDelete === category
        return (
          <div key={category} className={`sidebar-item-wrapper ${activeCategory === category ? "is-active" : ""}`}>
            {/* 分类项主体 - 点击切换分类 */}
            {!isEditing && !isPendingDelete && (
              <button
                className="sidebar-item-main"
                onClick={() => onSelectCategory(category)}
              >
                <span className={`sidebar-dot ${dotStatus}`} />
                <span className="sidebar-item-name">{category}</span>
                <span className="sidebar-item-count">{views.length}</span>
              </button>
            )}
            
            {/* 始终保留在 DOM 中，鼠标或键盘聚焦时增强显示 */}
            {!isEditing && !isPendingDelete && (
              <button 
                className="sidebar-item-edit-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingCategory(category)
                  setEditName(category)
                }}
                aria-label="编辑分类"
              >
                <Icon name="edit" size={12} />
              </button>
            )}
            
            {/* 编辑模式 - 重命名 */}
            {isEditing && (
              <div className="sidebar-item-edit-mode">
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (editName.trim() && editName !== category) {
                        onRenameCategory(category, editName.trim())
                      }
                      setEditingCategory(null)
                    }
                    if (e.key === 'Escape') {
                      setEditingCategory(null)
                    }
                  }}
                  onBlur={() => {
                    if (editName.trim() && editName !== category) {
                      onRenameCategory(category, editName.trim())
                    }
                    setEditingCategory(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <button 
                  className="sidebar-item-delete-btn"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRequestDeleteCategory(category)
                    setEditingCategory(null)
                  }}
                  aria-label="删除分类"
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )}

            {/* 删除确认模式 - 两个删除入口共用这一处内联确认。
                非空分类必须显式选择迁移目标或勾选删除物品，避免一个轻量 confirm 误删真实数据。 */}
            {isPendingDelete && (
              <div className="sidebar-item-edit-mode sidebar-delete-confirm">
                <span className="sidebar-item-name">{category}</span>
                <div className="sidebar-delete-confirm-popover" onClick={(e) => e.stopPropagation()}>
                  {views.length === 0 ? (
                    <>
                      <span className="sidebar-delete-confirm-text">删除该分类？</span>
                      <button
                        className="sidebar-delete-confirm-cancel"
                        onClick={(e) => { e.stopPropagation(); onCancelDeleteCategory() }}
                      >取消</button>
                      <button
                        className="sidebar-delete-confirm-btn"
                        onClick={(e) => { e.stopPropagation(); onConfirmDeleteCategory(category) }}
                      >删除</button>
                    </>
                  ) : deleteMode === "idle" ? (
                    <>
                      <span className="sidebar-delete-confirm-text">该分类下有 {views.length} 个物品</span>
                      <button
                        className="sidebar-delete-confirm-cancel"
                        onClick={(e) => { e.stopPropagation(); onCancelDeleteCategory() }}
                      >取消</button>
                      {categorySummaries.some((c) => c.category !== category) && (
                        <button
                          className="sidebar-delete-confirm-cancel"
                          onClick={(e) => {
                            e.stopPropagation()
                            const others = categorySummaries.filter((c) => c.category !== category).map((c) => c.category)
                            setMoveTarget(others[0] || "")
                            setDeleteMode("move")
                          }}
                        >迁移到其他分类</button>
                      )}
                      <button
                        className="sidebar-delete-confirm-btn"
                        onClick={(e) => { e.stopPropagation(); setDeleteMode("delete-items") }}
                      >同时删除物品</button>
                    </>
                  ) : deleteMode === "move" ? (
                    <>
                      <span className="sidebar-delete-confirm-text">迁移到</span>
                      <select
                        className="sidebar-delete-confirm-select"
                        value={moveTarget}
                        onChange={(e) => setMoveTarget(e.target.value)}
                        aria-label="选择迁移目标分类"
                      >
                        {categorySummaries.filter((c) => c.category !== category).map((c) => (
                          <option key={c.category} value={c.category}>{c.category}</option>
                        ))}
                      </select>
                      <button
                        className="sidebar-delete-confirm-cancel"
                        onClick={(e) => { e.stopPropagation(); onCancelDeleteCategory() }}
                      >取消</button>
                      <button
                        className="sidebar-delete-confirm-btn"
                        disabled={!moveTarget}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (moveTarget) onConfirmDeleteCategory(category, { moveToCategory: moveTarget })
                        }}
                      >确认迁移并删除</button>
                    </>
                  ) : (
                    <>
                      <span className="sidebar-delete-confirm-text">将同时删除分类和 {views.length} 个物品，无法恢复</span>
                      <button
                        className="sidebar-delete-confirm-cancel"
                        onClick={(e) => { e.stopPropagation(); onCancelDeleteCategory() }}
                      >取消</button>
                      <button
                        className="sidebar-delete-confirm-btn"
                        onClick={(e) => { e.stopPropagation(); onConfirmDeleteCategory(category, { deleteItemsConfirmed: true }) }}
                      >确认删除</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}

      <RestockHeatmap items={allItems} now={now} />

      <button className="sidebar-settings" onClick={onOpenSettings}>
        <Icon name="settings" size={13} />
        设置
      </button>
    </nav>
  )
}
