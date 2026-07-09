import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { AnimatedIcon as Icon } from "./AnimatedIcon"
import catIcon from "./assets/cat-icon.png?inline"
import managerAvatar from "./assets/manager-avatar.png"
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
  nextSnoozeTimeAfterHours,
  restockItem,
  startOfDay,
  updateRestockRecord,
  updateItemFromDraft
} from "./domain"
import { extractOrderFromImage, fileToCompressedDataUrl, fuzzyMatchItem, fuzzyMatchOption, type ExtractedOrder, type OrderRecognitionMode } from "./llm/orderImport"
import { answerHouseholdQuickly, askHouseholdAssistant, buildChatDateContext, buildHouseholdChatStarter, type ChatDateContext, type ChatMessageLink, type HouseholdChatMessage } from "./llm/householdChat"
import { buildManagerBriefing, buildManagerObservations } from "./agent/observations"
import { buildLocalClarification, buildLocalDraftFromText, buildNotificationRestockDraft, buildNotificationRestockMessage, describeAgentDraft, parseAgentResponse, reviseAgentDraft, type AgentClarification, type AgentDraft, type AgentDraftStatus, type OrderRow } from "./agent/drafts"
import { classifyBatchIntent, classifyAgentIntent } from "./agent/intent"
import { buildAgentDraftsFromOrderRows, commitAgentDraft, commitAgentDraftBatch, commitAgentPlan, mapOrderLinesToDrafts, type AgentMessageLink } from "./agent/executor"
import { buildAgentContextPack, supersedeOldPendingDraft } from "./agent/conversationContext"
import { composeBoundaryAnswer, composeDraftStatusLabel, composeFallbackMessage, composeMatchHintText, composeOrderImportSummary, composeOrderRecognizingMessage, composePendingReminder, composeProposalMessage, composeRevisedMessage, isProductNameRedundant } from "./agent/responseComposer"
import { classifyConversationBoundary } from "./agent/conversationBoundary"
import { computeRemainingDelay, getResponseTiming } from "./agent/responsePacing"
import {
  buildOrderImportRowsFromExtract,
  orderImportRowsToConfirmed,
  OrderImportReviewList,
  MAX_ORDER_IMAGES as ORDER_IMPORT_MAX_IMAGES,
  type OrderImportRow as SharedOrderImportRow,
  type OrderImportConfirmedRow as SharedOrderImportConfirmedRow
} from "./OrderImportReview"
import {
  measureUnitDefinitions,
  getMeasureUnitDefinition,
  getMeasureUnitLabel,
  getMeasureUnitShortLabel,
  getCompatibleMeasureUnits,
  convertMeasureAmount,
  encodeCustomMeasureUnit,
  parseCustomMeasureUnit,
  getMeasureBaseAmount as getOptionMeasureBaseAmount,
  type MeasureUnitDefinition
} from "./orderImportHelpers"
import { createHouseholdOrchestrator, isBatchIntentMarker, readTurnCommand } from "./agent/householdOrchestrator"
import type { AgentPlanCommand, AgentTurn } from "./agent/orchestrator"
import type { AgentPlan } from "./agent/actions"
import { loadState, persistState, reconcileState, takePendingLoadIssue, type PersistenceIssue } from "./store"
import { canConfirmRestock, applyDeleteCategory, calculateMonthlySpend } from "./pure-logic.mjs"
import type { AppState, DeleteCategoryOptions, ItemComputed, ItemDraft, PricingMode, Rating, ReplenishmentItem, PurchaseOption, RestockEvent } from "./types"
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
  // 任务四 A：会话级观察去重状态。同一会话内已展示过的观察（按 kind+itemId）不再重复出现；面板关闭时重置。
  const seenObservationKeysRef = useRef<Set<string>>(new Set())
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
    if (payload.action === "openChat" && payload.itemIds.length === 1) {
      const item = state.items.find((current) => current.id === payload.itemIds[0])
      if (item) {
        // 补丁 Bug2：append 而非整体替换，避免清空用户聊天历史。
        // 补丁规格：附带该物品的本地 restock 草稿，进入 pending 确认流程，用户回「确认」即可记单。
        const message = buildNotificationRestockMessage(item)
        const restockDraft = buildNotificationRestockDraft(item, Date.now())
        setHouseholdChatMessages((current) => [...current, {
          role: "assistant",
          content: message,
          agentDraft: restockDraft,
          draftStatus: "pending" as const,
          createdAt: Date.now()
        }])
      }
      setHouseholdChatOpen(true)
    }
    if (payload.action === "restock" && payload.itemIds.length === 1) {
      const item = state.items.find((current) => current.id === payload.itemIds[0])
      if (item) handleRestock(item)
    }
    if (payload.action === "snooze") {
      const snoozeUntil = nextSnoozeTimeAfterHours(state.settings.reminderIntervalHours)
      updateItems(payload.itemIds, (item) => ({ ...item, snoozeUntil, updatedAt: Date.now() }))
    }
  }), [state.items, state.settings.reminderIntervalHours])

  useEffect(() => {
    function closeTopPanel(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (pendingCategoryDelete) setPendingCategoryDelete(null)
      else if (categoryDialog) setCategoryDialog(null)
      else if (detailItemId) deferredClose(setDetailPanelClosing, () => setDetailItemId(null))
      else if (householdChatOpen) closeChatWithSessionUpdate()
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

  // 订单截图批量导入确认：把每一行转成 AgentDraft，推到对话作为待确认批量草稿。
  // 批量确认前不写入 state；用户在对话中逐条修正或「确认全部」后，由 commitAgentDraftBatch 统一写入。
  function handleOrderImportConfirm(payload: { rows: OrderImportConfirmedRow[] }) {
    const now = Date.now()
    const actionableRows = payload.rows.filter((row) => row.targetItem !== "__skip__" && row.qty > 0)
    setOrderImportOpen(false)
    if (!actionableRows.length) return
    const drafts = buildAgentDraftsFromOrderRows(actionableRows, state, now)
    if (!drafts.length) return
    const intro = `已从订单截图生成 ${drafts.length} 条待确认草稿。可以在下面逐条修正，或输入「全部确认」一次性写入。`
    setHouseholdChatMessages((current) => [...current, {
      role: "assistant",
      content: intro,
      agentDraftBatch: drafts,
      batchDraftStatuses: drafts.map(() => "pending" as const),
      createdAt: Date.now()
    }])
    setHouseholdChatOpen(true)
    setRestockToast({ itemName: `${drafts.length} 条待确认草稿` })
  }

  function saveEditedRestockRecord(itemId: string, recordId: string, patch: Pick<RestockEvent, "at" | "qty" | "price"> & Partial<Pick<RestockEvent, "platform" | "purchasePricingMode" | "purchaseMeasureBaseAmount" | "purchaseMeasureAmount" | "purchaseMeasureUnit" | "review">>) {
    updateItems([itemId], (current) => updateRestockRecord(current, recordId, patch))
    setEditingRestockRecord(null)
  }

  function handleSnooze(item: ReplenishmentItem) {
    const snoozeUntil = nextSnoozeTimeAfterHours(state.settings.reminderIntervalHours)
    updateItems([item.id], (current) => ({ ...current, snoozeUntil, updatedAt: Date.now() }))
  }

  function openChatWithBriefing() {
    // 欢迎语只在会话为空时出现；历史已有消息时不再自动追加，避免开合后重复简报。
    if (householdChatMessages.length > 0) {
      setHouseholdChatOpen(true)
      return
    }
    const dateContext = buildChatDateContext()
    const observations = buildManagerObservations(state, itemViews, dateContext)
    const briefing = buildManagerBriefing(observations, state.settings.lastChatSessionAt, dateContext, seenObservationKeysRef.current)
    if (briefing) {
      setHouseholdChatMessages((current) => {
        // 写入时去重：末条若已是相同内容的纯 assistant 消息，不再追加，防止重复回复。
        const last = current[current.length - 1]
        if (last && isPlainAssistantMessage(last) && last.content.trim() === briefing.trim()) return current
        return [...current, { role: "assistant", content: briefing, createdAt: Date.now() }]
      })
    }
    setHouseholdChatOpen(true)
  }

  function closeChatWithSessionUpdate() {
    commit({
      ...state,
      settings: {
        ...state.settings,
        lastChatSessionAt: Date.now()
      }
    })
    // 任务四 A：面板关闭，重置会话级观察去重状态
    seenObservationKeysRef.current = new Set()
    deferredClose(setHouseholdChatClosing, () => setHouseholdChatOpen(false))
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

  // 旧 ChatProposedAction 写入路径已下线：所有写入类意图统一走 AgentDraft → commitAgentDraft。
  // 旧 <action> / pendingActions 仅在 householdChat.ts 中保留兼容解析，不再作为主流程。
  function handleAgentDraftConfirm(agentDraft: AgentDraft): { summary: string; links: AgentMessageLink[]; observation?: string } {
    const dateContext = buildChatDateContext()
    const result = commitAgentDraft(state, agentDraft, Date.now(), dateContext, seenObservationKeysRef.current)
    if (result.state !== state) commit(result.state)
    return { summary: result.summary, links: result.links, observation: result.observation }
  }

  // 批量草稿确认：只写入 status !== "cancelled" 的草稿，复用共享 executor，不允许另写一套。
  function handleAgentDraftBatchConfirm(drafts: AgentDraft[]): { summary: string; links: AgentMessageLink[]; observation?: string } {
    if (!drafts.length) return { summary: "没有需要写入的草稿。", links: [] }
    const dateContext = buildChatDateContext()
    const result = commitAgentDraftBatch(state, drafts, Date.now(), dateContext, seenObservationKeysRef.current)
    if (result.state !== state) commit(result.state)
    return { summary: result.summary, links: result.links, observation: result.observation }
  }

  // AgentPlan 确认：所有写入复用 commitAgentPlan → applyAgentAction → domain 逻辑。
  // 不在 App.tsx 里手写新的 agent 写入路径；确认前不修改 state。
  function handleAgentPlanConfirm(plan: AgentPlan): { summary: string; links: AgentMessageLink[]; observation?: string } {
    const dateContext = buildChatDateContext()
    const result = commitAgentPlan(state, plan, Date.now(), dateContext, seenObservationKeysRef.current)
    if (result.state !== state) commit(result.state)
    return { summary: result.summary, links: result.links, observation: result.observation }
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
          onOpenChat={() => { if (!householdChatOpen) openChatWithBriefing() }}
          isChatOpen={householdChatOpen}
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
              onApplySuggestion={applyCycleSuggestion}
              onDismissSuggestion={dismissSuggestion}
              onOpenItem={openItem}
              onAddItem={() => {
                setCreatingCategory(state.categories[0] || null)
                setIsItemCreatorOpen(true)
              }}
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
      {(settingsOpen || settingsClosing) && <SettingsPanel state={state} onChange={commit} isClosing={settingsClosing} onClose={() => deferredClose(setSettingsClosing, () => setSettingsOpen(false))} />}
      {(householdChatOpen || householdChatClosing) && (
        <HouseholdChatPanel
          state={state}
          itemViews={itemViews}
	          messages={householdChatMessages}
	          onMessagesChange={setHouseholdChatMessages}
	          onQuestionSent={setHouseholdChatLastQuestion}
	          onConfirmDraft={handleAgentDraftConfirm}
          onConfirmBatch={handleAgentDraftBatchConfirm}
          onConfirmPlan={handleAgentPlanConfirm}
          onOpenItem={(itemId) => {
            closeChatWithSessionUpdate()
            setDetailItemId(itemId)
          }}
          onOpenCategory={(category) => {
            closeChatWithSessionUpdate()
            setActiveCategory(category)
          }}
          isClosing={householdChatClosing}
          onClose={closeChatWithSessionUpdate}
          onOpenSettings={() => {
            closeChatWithSessionUpdate()
            setSettingsOpen(true)
          }}
          orderImageApiKey={state.settings.aiApiKey}
          orderImageModel={state.settings.aiOrderModel ?? state.settings.aiModel}
          orderRecognitionMode={state.settings.aiOrderMode ?? "accurate"}
          seenObservationKeys={seenObservationKeysRef.current}
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

// 旧 ChatActionCard（ChatProposedAction 确认清单）已下线，统一由 AgentDraftCard 承担。

/** 管家小头像：透明 PNG 猫咪头像，与 403家庭管家品牌一致。 */
function ManagerAvatar() {
  return <img className="chat-manager-avatar" src={managerAvatar} alt="" aria-hidden="true" />
}

function isPlainAssistantMessage(message: HouseholdChatMessage) {
  return message.role === "assistant" &&
    !message.agentDraft &&
    !message.agentDraftBatch &&
    !message.orderImportRows &&
    !message.clarification &&
    !message.links?.length &&
    !message.imageAttachments?.length
}

function isDuplicatePlainAssistantMessage(previous: HouseholdChatMessage | undefined, current: HouseholdChatMessage) {
  return !!previous &&
    isPlainAssistantMessage(previous) &&
    isPlainAssistantMessage(current) &&
    previous.content.trim() === current.content.trim()
}

function AgentDraftCard({ draft, status, onConfirm, onCancel, onDraftChange }: {
  draft: AgentDraft
  status: AgentDraftStatus
  onConfirm: () => void
  onCancel: () => void
  onDraftChange?: (next: AgentDraft) => void
}) {
  const statusLabel = composeDraftStatusLabel(status, draft)
  const confirmLabel = draft.kind === "createItem"
    ? "就这么记"
    : draft.kind === "restock" ? "就这么记"
      : draft.kind === "createItemWithRestock" ? "就这么记"
        : "就这么挂"

  // 任务四 B1：默认态收据化摘要。一行主信息 + 一行次要信息，已填字段才展示，"未填写"不出现。
  function receiptLines(): { primary: string; secondary: string } {
    if (draft.kind === "createItem") {
      const primary = `${draft.itemName} · 分类 ${draft.category}`
      const secondary = `周期 ${draft.cycleDays} 天，提前 ${draft.bufferDays} 天提醒`
      return { primary, secondary }
    }
    if (draft.kind === "restock") {
      const qtyPart = draft.qty ? ` × ${draft.qty}${draft.unit || ""}` : ""
      const datePart = draft.restockDate ? ` · ${formatDate(draft.restockDate)}` : ""
      const primary = `${draft.itemName}${qtyPart}${datePart}`
      const parts: string[] = []
      if (draft.price !== undefined) parts.push(`¥${formatPrice(draft.price)}`)
      if (draft.platform) parts.push(draft.platform)
      if (draft.purchaseProductName && !isProductNameRedundant(draft.itemName, draft.purchaseProductName)) parts.push(draft.purchaseProductName)
      if (draft.review) parts.push(draft.review)
      if (draft.cycleDaysPatch) parts.push(`周期调整 ${draft.cycleDaysPatch} 天`)
      if (draft.purchaseMeasureAmount && draft.purchaseMeasureUnit) parts.push(`${draft.purchaseMeasureAmount}${draft.purchaseMeasureUnit}`)
      return { primary, secondary: parts.join(" · ") }
    }
    if (draft.kind === "createItemWithRestock") {
      const unit = draft.restock.unit || draft.item.unit
      const qtyPart = draft.restock.qty ? ` × ${draft.restock.qty}${unit || ""}` : ""
      const datePart = draft.restock.restockDate ? ` · ${formatDate(draft.restock.restockDate)}` : ""
      const primary = `${draft.item.itemName}${qtyPart} · 分类 ${draft.item.category}${datePart}`
      const parts: string[] = [`周期 ${draft.item.cycleDays} 天，提前 ${draft.item.bufferDays} 天提醒`]
      if (draft.restock.price !== undefined) parts.push(`¥${formatPrice(draft.restock.price)}`)
      if (draft.restock.platform) parts.push(draft.restock.platform)
      if (draft.addPurchaseOption?.productName || draft.restock.purchaseProductName) {
        const productName = draft.addPurchaseOption?.productName || draft.restock.purchaseProductName || ""
        if (!isProductNameRedundant(draft.item.itemName, productName)) parts.push(productName)
      }
      if (draft.restock.review) parts.push(draft.restock.review)
      if (draft.restock.purchaseMeasureAmount && draft.restock.purchaseMeasureUnit) {
        parts.push(`${draft.restock.purchaseMeasureAmount}${draft.restock.purchaseMeasureUnit}`)
      }
      return { primary, secondary: parts.join(" · ") }
    }
    // addPurchaseOption
    const primary = `${draft.productName} 挂到 ${draft.itemName}`
    const secondary = draft.unit || ""
    return { primary, secondary }
  }

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
        ["商品名", draft.purchaseProductName || "未填写"],
        ["购买日期", draft.restockDate ? formatDate(draft.restockDate) : "未填写"],
        ["评价", draft.review || "未填写"],
        ...(draft.purchaseMeasureAmount && draft.purchaseMeasureUnit ? [["规格", `${draft.purchaseMeasureAmount}${draft.purchaseMeasureUnit}`] as [string, string]] : []),
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
        ["商品名", draft.addPurchaseOption?.productName || draft.restock.purchaseProductName || "不登记"],
        ["购买日期", draft.restock.restockDate ? formatDate(draft.restock.restockDate) : "未填写"],
        ["评价", draft.restock.review || "未填写"],
        ...(draft.restock.purchaseMeasureAmount && draft.restock.purchaseMeasureUnit ? [["规格", `${draft.restock.purchaseMeasureAmount}${draft.restock.purchaseMeasureUnit}`] as [string, string]] : [])
      ]
    }
    return [
      ["常购商品", draft.productName],
      ["挂到", draft.itemName],
      ["单位", draft.unit || "沿用消耗品单位"]
    ]
  }

  // 内联快速编辑：只对 pending 状态开放，改完通过 onDraftChange 回传
  function patchRestock(patch: Partial<typeof draft & object>) {
    if (!onDraftChange) return
    if (draft.kind === "restock") onDraftChange({ ...draft, ...patch } as AgentDraft)
    else if (draft.kind === "createItemWithRestock") onDraftChange({ ...draft, restock: { ...draft.restock, ...patch } } as AgentDraft)
  }
  function patchItem(patch: Partial<typeof draft & object>) {
    if (!onDraftChange) return
    if (draft.kind === "createItem") onDraftChange({ ...draft, ...patch } as AgentDraft)
    else if (draft.kind === "createItemWithRestock") onDraftChange({ ...draft, item: { ...draft.item, ...patch } } as AgentDraft)
  }

  function toDateInput(ts?: number): string {
    if (!ts) return ""
    const d = new Date(ts)
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${d.getFullYear()}-${m}-${day}`
  }
  function fromDateInput(value: string): number | undefined {
    if (!value) return undefined
    const [y, m, d] = value.split("-").map(Number)
    if (!y || !m || !d) return undefined
    const date = new Date(y, m - 1, d)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  // 任务四 B1/B2：默认收据态 + 展开修改。编辑与确认逻辑不动。
  const [expanded, setExpanded] = useState(false)
  const editable = status === "pending" && onDraftChange
  const restockFields = draft.kind === "restock" ? draft : draft.kind === "createItemWithRestock" ? draft.restock : null
  const receipt = receiptLines()
  const matchHint = draft.kind === "restock" ? draft.matchHint : draft.kind === "createItemWithRestock" ? draft.restock.matchHint : undefined

  return (
    <div className={`chat-action-card is-${status}`}>
      <div className="chat-action-card-head">
        <span>{statusLabel}</span>
      </div>
      {/* B1：默认态紧凑摘要，一行主信息 + 一行次要信息，已填字段才展示 */}
      <p className="chat-action-receipt-primary">{receipt.primary}</p>
      {receipt.secondary && <p className="chat-action-receipt-secondary">{receipt.secondary}</p>}
      {matchHint && (
        <p className="chat-action-summary chat-action-hint-warn">
          {composeMatchHintText(matchHint)}
        </p>
      )}
      {/* B2：展开修改入口，展开后显示完整字段表 + 内联编辑 */}
      {editable && (
        <button
          type="button"
          className="chat-action-expand-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : "展开修改"}
        </button>
      )}
      {expanded && rows().map(([label, value]) => (
        <p key={label} className="chat-action-summary">
          <b>{label}</b>
          {value}
        </p>
      ))}
      {expanded && editable && restockFields && (
        <div className="chat-action-quickedit">
          <label className="chat-edit-field">
            <span>数量</span>
            <input
              type="number"
              min={1}
              value={restockFields.qty ?? ""}
              onChange={(e) => patchRestock({ qty: e.target.value ? Number(e.target.value) : undefined })}
              aria-label="编辑数量"
            />
          </label>
          <label className="chat-edit-field">
            <span>金额</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={restockFields.price ?? ""}
              onChange={(e) => patchRestock({ price: e.target.value ? Number(e.target.value) : undefined })}
              aria-label="编辑金额"
            />
          </label>
          <label className="chat-edit-field">
            <span>平台</span>
            <input
              type="text"
              value={restockFields.platform ?? ""}
              onChange={(e) => patchRestock({ platform: e.target.value || undefined })}
              aria-label="编辑平台"
            />
          </label>
          <label className="chat-edit-field">
            <span>日期</span>
            <input
              type="date"
              value={toDateInput(restockFields.restockDate)}
              onChange={(e) => patchRestock({ restockDate: fromDateInput(e.target.value) })}
              aria-label="编辑购买日期"
            />
          </label>
          <label className="chat-edit-field">
            <span>评价</span>
            <input
              type="text"
              value={restockFields.review ?? ""}
              placeholder="好用/不好用/猫不爱吃…"
              onChange={(e) => patchRestock({ review: e.target.value || undefined })}
              aria-label="编辑评价"
            />
          </label>
        </div>
      )}
      {expanded && editable && (draft.kind === "createItem" || draft.kind === "createItemWithRestock") && (
        <div className="chat-action-quickedit">
          <label className="chat-edit-field">
            <span>分类</span>
            <input
              type="text"
              value={draft.kind === "createItem" ? draft.category : draft.item.category}
              onChange={(e) => patchItem({ category: e.target.value || undefined })}
              aria-label="编辑分类"
            />
          </label>
          <label className="chat-edit-field">
            <span>周期</span>
            <input
              type="number"
              min={1}
              value={draft.kind === "createItem" ? draft.cycleDays : draft.item.cycleDays}
              onChange={(e) => patchItem({ cycleDays: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
              aria-label="编辑补货周期"
            />
          </label>
        </div>
      )}
      {status === "pending" && (
        <>
          <div className="chat-action-card-actions">
            <button type="button" className="quiet-button compact" onClick={onCancel}>先不记</button>
            <button type="button" className="primary-button compact green" onClick={onConfirm}>{confirmLabel}</button>
          </div>
          <small className="chat-action-hint">想调整的话直接说，比如「周期改成 90 天」或「平台是京东」，也能展开后直接改。</small>
        </>
      )}
      {status === "confirmed" && (
        <small className="chat-action-hint">已写入。点上方链接查看。</small>
      )}
    </div>
  )
}

/**
 * AgentPlanCard：多动作计划的确认卡片。
 *
 * 与 AgentDraftCard 的区别：
 *   - AgentDraftCard 是单条草稿（restock / createItem 等），有内联字段编辑
 *   - AgentPlanCard 是一组动作（建分类 / 设预算 / 改周期 等），只展示 + 确认/取消
 *
 * 确认前不写 state；确认后由 commitAgentPlan 统一执行。
 * 修订由对话完成（如「周期改成 45 天」），卡片本身不提供内联编辑。
 */
function AgentPlanCard({ plan, status, onConfirm, onCancel }: {
  plan: AgentPlan
  status: "pending" | "awaitingSecondConfirm" | "confirmed" | "cancelled" | "superseded"
  onConfirm: () => void
  onCancel: () => void
}) {
  const isHighRisk = plan.requiresSecondConfirm === true || plan.risk === "high"
  const statusLabel = status === "pending"
    ? (isHighRisk ? "高风险 · 准备处理" : "准备处理")
    : status === "awaitingSecondConfirm"
      ? "高风险 · 等待二次确认"
      : status === "confirmed"
        ? "已执行"
        : status === "cancelled"
          ? "已取消"
          : "已替代"

  return (
    <div className={`chat-action-card is-${status}${isHighRisk ? " is-high-risk" : ""}`}>
      <div className="chat-action-card-head">
        <span>{statusLabel}</span>
      </div>
      <ol className="chat-plan-action-list">
        {plan.actions.map((action, index) => (
          <li key={index}>{summarizeActionForCard(action)}</li>
        ))}
      </ol>
      {status === "pending" && (
        <>
          {isHighRisk && (
            <small className="chat-action-hint">这是高风险删除操作，确认后还需要你明确说「确认删除」才能执行。</small>
          )}
          <div className="chat-action-card-actions">
            <button type="button" className="quiet-button compact" onClick={onCancel}>先不处理</button>
            <button type="button" className="primary-button compact green" onClick={onConfirm}>
              {isHighRisk ? "继续确认" : "就这么执行"}
            </button>
          </div>
          {!isHighRisk && (
            <small className="chat-action-hint">想调整的话直接说，比如「预算改成 800」或「周期 45 天」。</small>
          )}
        </>
      )}
      {status === "awaitingSecondConfirm" && (
        <>
          <small className="chat-action-hint">这是高风险删除操作，操作不可撤销。请明确说「确认删除」执行，或「取消」放弃。</small>
          <div className="chat-action-card-actions">
            <button type="button" className="quiet-button compact" onClick={onCancel}>取消</button>
            <button type="button" className="primary-button compact red" onClick={onConfirm}>确认删除</button>
          </div>
        </>
      )}
      {status === "confirmed" && (
        <small className="chat-action-hint">已写入。点上方链接查看。</small>
      )}
    </div>
  )
}

/** AgentPlanCard 里每条动作的摘要。只读字段，不做 validation。 */
function summarizeActionForCard(action: import("./agent/actions").AgentAction): string {
  switch (action.type) {
    case "createCategory":
      return `新建分类「${action.name}」`
    case "createItem": {
      const parts = [`添加消耗品「${action.name}」 · 分类 ${action.category} · 周期 ${action.cycleDays} 天`]
      if (action.addPurchaseOption?.productName) parts.push(`常购商品 ${action.addPurchaseOption.productName}`)
      return parts.join(" · ")
    }
    case "updateItem": {
      const changes: string[] = []
      if (action.cycleDays !== undefined) changes.push(`周期 ${action.cycleDays} 天`)
      if (action.bufferDays !== undefined) changes.push(`提前 ${action.bufferDays} 天`)
      if (action.category) changes.push(`分类 ${action.category}`)
      if (action.unit) changes.push(`单位 ${action.unit}`)
      return `修改「${action.itemName || action.itemId}」：${changes.join("，") || "无变更"}`
    }
    case "addPurchaseOption":
      return `常购商品「${action.productName}」挂到「${action.itemName}」下`
    case "recordRestock": {
      const parts = [`记补货「${action.itemName}」`]
      if (action.qty) parts.push(`${action.qty}${action.unit || "件"}`)
      if (action.platform) parts.push(action.platform)
      if (action.price !== undefined) parts.push(`¥${action.price}`)
      return parts.join(" · ")
    }
    case "updateRestockRecord": {
      const changes: string[] = []
      if (action.patch.price !== undefined) changes.push(`价格 ¥${action.patch.price}`)
      if (action.patch.platform) changes.push(`平台 ${action.patch.platform}`)
      return `改补货记录：${changes.join("，") || "无变更"}`
    }
    case "setMonthlyBudget":
      return `本月预算设为 ¥${action.amount}`
    case "renameCategory":
      return `重命名分类：${action.oldName} → ${action.newName}`
    case "moveItem":
      return `把「${action.itemName || action.itemId}」移到分类「${action.targetCategory}」`
    case "updateItemUnit":
      return `「${action.itemName || action.itemId}」单位改为 ${action.unit}`
    case "updateItemReminder":
      return `「${action.itemName || action.itemId}」提前 ${action.bufferDays} 天提醒`
    case "updatePurchaseOption": {
      const changes: string[] = []
      if (action.patch.productName) changes.push(`名称 ${action.patch.productName}`)
      if (action.patch.unit) changes.push(`单位 ${action.patch.unit}`)
      if (action.patch.platform) changes.push(`平台 ${action.patch.platform}`)
      if (action.patch.price !== undefined) changes.push(`价格 ¥${action.patch.price}`)
      if (action.patch.link) changes.push("链接")
      if (action.patch.measureUnit) changes.push(`规格单位 ${action.patch.measureUnit}`)
      if (action.patch.measureBaseAmount !== undefined) changes.push(`规格基准 ${action.patch.measureBaseAmount}`)
      const target = action.productName || action.optionId || ""
      return `「${action.itemName || action.itemId}」·「${target}」：${changes.join("，") || "无变更"}`
    }
    case "setDefaultPurchaseOption":
      return `把「${action.itemName || action.itemId}」的默认常购商品设为「${action.productName || action.optionId}」`
    case "deletePurchaseOption":
      return `删除常购商品：「${action.itemName}」·「${action.productName || action.optionId}」`
    case "deleteRestockRecord": {
      const which = action.recordId
        ? `记录 ${action.recordId}`
        : action.dateHint
          ? `${action.dateHint}的补货记录`
          : action.price !== undefined
            ? `价格 ¥${action.price} 的补货记录`
            : "最近一条补货记录"
      return `删除补货记录：「${action.itemName}」· ${which}`
    }
    case "deleteItem":
      return `删除消耗品「${action.itemName}」（含历史记录、常购商品、提醒状态）`
    case "deleteCategory":
      return `删除分类「${action.categoryName}」`
    default:
      return "（未实现的动作）"
  }
}

/** 批量待确认草稿卡片：订单截图导入后在对话中展示，支持逐条跳过与全部确认。 */
function AgentDraftBatchCard({ drafts, statuses, result, skippedRows, uncertainRows, onConfirmBatch, onCancelBatch, onSkipIndex, onOpenItem }: {
  drafts: AgentDraft[]
  statuses: AgentDraftStatus[]
  result?: { summary: string; links: ChatMessageLink[] }
  skippedRows?: OrderRow[]
  uncertainRows?: OrderRow[]
  onConfirmBatch: () => void
  onCancelBatch: () => void
  onSkipIndex: (index: number) => void
  onOpenItem: (itemId: string) => void
}) {
  const hasPending = statuses.some((status) => status === "pending")
  const pendingCount = statuses.filter((status) => status === "pending").length
  const cancelledCount = statuses.filter((status) => status === "cancelled").length

  function draftLabel(draft: AgentDraft): string {
    if (draft.kind === "createItem") return draft.itemName
    if (draft.kind === "restock") return draft.itemName
    if (draft.kind === "createItemWithRestock") return draft.item.itemName
    return draft.productName
  }

  /** 卡片只展示管家口吻的字段：物品名/数量/平台/金额/日期。空字段不展示。 */
  function draftDetail(draft: AgentDraft): string {
    const parts: string[] = []
    if (draft.kind === "createItem") {
      if (draft.category) parts.push(draft.category)
      return parts.join(" · ")
    }
    if (draft.kind === "addPurchaseOption") {
      if (draft.productName) parts.push(draft.productName)
      return parts.join(" · ")
    }
    if (draft.kind === "restock") {
      if (draft.qty) parts.push(`${draft.qty}${draft.unit || ""}`)
      if (draft.platform) parts.push(draft.platform)
      if (draft.price !== undefined) parts.push(`¥${draft.price}`)
      if (draft.restockDate) parts.push(new Date(draft.restockDate).toLocaleDateString("zh-CN"))
      return parts.join(" · ")
    }
    // createItemWithRestock
    if (draft.restock.qty) parts.push(`${draft.restock.qty}${draft.restock.unit || ""}`)
    if (draft.restock.platform) parts.push(draft.restock.platform)
    if (draft.restock.price !== undefined) parts.push(`¥${draft.restock.price}`)
    if (draft.restock.restockDate) parts.push(new Date(draft.restock.restockDate).toLocaleDateString("zh-CN"))
    return parts.join(" · ")
  }

  function statusLabel(status: AgentDraftStatus): string {
    if (status === "pending") return "准备记"
    if (status === "confirmed") return "已记下"
    if (status === "cancelled") return "已跳过"
    return "已替代"
  }

  /** 跳过行的展示名：优先 coreName > brandName > productName */
  function rowLabel(row: OrderRow): string {
    return row.coreName || row.brandName || row.productName || "未命名"
  }

  /** 跳过行展示字段：数量/平台/金额（识别到才展示） */
  function rowDetail(row: OrderRow): string {
    const parts: string[] = []
    if (row.qty) parts.push(`${row.qty}${row.measureUnit || ""}`)
    if (row.platform) parts.push(row.platform)
    if (row.price !== undefined) parts.push(`¥${row.price}`)
    return parts.join(" · ")
  }

  return (
    <div className="chat-batch-card">
      <div className="chat-batch-card-header">
        <strong>这张订单里要记的消耗品（{drafts.length} 样）</strong>
        {hasPending && <small>可以逐条跳过，或输入「第二个跳过」「洗衣液数量改成 2」来修正。</small>}
      </div>
      <ol className="chat-batch-card-list">
        {drafts.map((draft, i) => {
          const status = statuses[i]
          const itemId = draft.kind === "restock" ? draft.itemId
            : draft.kind === "addPurchaseOption" ? draft.itemId
            : undefined
          return (
            <li key={i} className={`chat-batch-row is-${status}`}>
              <div className="chat-batch-row-main">
                <span className="chat-batch-row-index">{i + 1}</span>
                <div className="chat-batch-row-text">
                  <span className="chat-batch-row-name">{draftLabel(draft)}</span>
                  <span className="chat-batch-row-detail">{draftDetail(draft)}</span>
                  {draft.kind === "restock" && draft.matchHint && (
                    <span className="chat-batch-row-hint">{draft.matchHint}</span>
                  )}
                </div>
              </div>
              <div className="chat-batch-row-aside">
                <span className="chat-batch-row-status">{statusLabel(status)}</span>
                {status === "pending" && (
                  <button type="button" className="quiet-button compact" onClick={() => onSkipIndex(i)}>单条跳过</button>
                )}
                {status === "confirmed" && itemId && (
                  <button type="button" className="text-button compact" onClick={() => onOpenItem(itemId)}>查看</button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {uncertainRows && uncertainRows.length > 0 && (
        <div className="chat-batch-card-section chat-batch-card-uncertain">
          <strong>需要确认</strong>
          <small>这几样我不太确定归到哪个物品，怕记错。</small>
          <ul>
            {uncertainRows.map((row, i) => (
              <li key={`uncertain-${i}`} className="chat-batch-row is-uncertain">
                <div className="chat-batch-row-main">
                  <span className="chat-batch-row-text">
                    <span className="chat-batch-row-name">{rowLabel(row)}</span>
                    {rowDetail(row) && <span className="chat-batch-row-detail">{rowDetail(row)}</span>}
                    {row.reason && <span className="chat-batch-row-hint">{row.reason}</span>}
                  </span>
                </div>
                <span className="chat-batch-row-status">需要确认</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {skippedRows && skippedRows.length > 0 && (
        <div className="chat-batch-card-section chat-batch-card-skipped">
          <strong>跳过的</strong>
          <small>不像日常消耗品，我先不管。</small>
          <ul>
            {skippedRows.map((row, i) => (
              <li key={`skipped-${i}`} className="chat-batch-row is-skipped">
                <div className="chat-batch-row-main">
                  <span className="chat-batch-row-text">
                    <span className="chat-batch-row-name">{rowLabel(row)}</span>
                    {rowDetail(row) && <span className="chat-batch-row-detail">{rowDetail(row)}</span>}
                  </span>
                </div>
                <span className="chat-batch-row-status">跳过</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasPending && (
        <div className="chat-batch-card-actions">
          <button type="button" className="quiet-button compact" onClick={onCancelBatch}>先不记</button>
          <button type="button" className="primary-button compact green" onClick={onConfirmBatch}>
            就这么记（{pendingCount} 样）
          </button>
        </div>
      )}
      {!hasPending && result && (
        <small className="chat-action-hint">
          {cancelledCount > 0 ? `已记下 ${drafts.length - cancelledCount} 样，跳过 ${cancelledCount} 样。` : `已记下 ${drafts.length} 样。`}
        </small>
      )}
    </div>
  )
}

function HouseholdChatPanel({ state, itemViews, messages, onMessagesChange, onQuestionSent, onConfirmDraft, onConfirmBatch, onConfirmPlan, onOpenItem, onOpenCategory, onClose, onOpenSettings, isClosing, orderImageApiKey, orderImageModel, orderRecognitionMode, seenObservationKeys }: {
  state: AppState
  itemViews: ItemView[]
  messages: HouseholdChatMessage[]
  onMessagesChange: (messages: HouseholdChatMessage[]) => void
  onQuestionSent: (question: string) => void
  onConfirmDraft: (draft: AgentDraft) => { summary: string; links: AgentMessageLink[]; observation?: string }
  onConfirmBatch: (drafts: AgentDraft[]) => { summary: string; links: AgentMessageLink[]; observation?: string }
  onConfirmPlan: (plan: AgentPlan) => { summary: string; links: AgentMessageLink[]; observation?: string }
  onOpenItem: (itemId: string) => void
  onOpenCategory: (category: string) => void
  onClose: () => void
  onOpenSettings: () => void
  isClosing?: boolean
  orderImageApiKey?: string
  orderImageModel?: string
  orderRecognitionMode?: OrderRecognitionMode
  /** 任务四 A：会话级观察去重状态，由 App 维护、面板关闭时重置 */
  seenObservationKeys?: Set<string>
}) {
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  /** 响应节奏层：等待期间显示的场景化 loading 文案；为空时只显示轻微 typing 指示器 */
  const [loadingText, setLoadingText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 展开态：从右侧工作侧栏切换到更宽的对话面板，便于阅读长回复 */
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  // 管家决策层单例：所有对话路径统一经过 orchestrator.decide / normalizeLlmResponse
	  const orchestrator = useMemo(() => createHouseholdOrchestrator(), [])
	  const starter = buildHouseholdChatStarter(itemViews)
  const visibleMessages = useMemo(() => {
    const result: Array<{ message: HouseholdChatMessage; index: number }> = []
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const previous = result[result.length - 1]?.message
      if (isDuplicatePlainAssistantMessage(previous, message)) continue
      result.push({ message, index })
    }
    return result
  }, [messages])

  // —— 对话时间线：时间戳与跨日期分隔线（仅在渲染层计算，不写入 messages）——
  /** 取消息时间，缺失时用当前时间兜底，保证旧数据不报错。 */
  function messageTime(message: HouseholdChatMessage): number {
    return typeof message.createdAt === "number" ? message.createdAt : Date.now()
  }
  /** 是否同一天（基于用户本地时区）。 */
  function isSameLocalDay(a: number, b: number): boolean {
    return startOfDay(a) === startOfDay(b)
  }
  /** 24 小时制时间，例如 09:32。 */
  function formatClock(timestamp: number): string {
    const date = new Date(timestamp)
    const hh = String(date.getHours()).padStart(2, "0")
    const mm = String(date.getMinutes()).padStart(2, "0")
    return `${hh}:${mm}`
  }
  const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
  /** 日期分隔线文案：今天 / 昨天 / 本年 M月D日 周X / 跨年 YYYY年M月D日 周X。 */
  function formatDateDivider(timestamp: number): string {
    const now = Date.now()
    const target = new Date(timestamp)
    if (isSameLocalDay(timestamp, now)) return "今天"
    if (isSameLocalDay(timestamp, now - 86400000)) return "昨天"
    const month = target.getMonth() + 1
    const day = target.getDate()
    const weekday = WEEKDAY_LABELS[target.getDay()]
    if (target.getFullYear() === new Date(now).getFullYear()) {
      return `${month}月${day}日 ${weekday}`
    }
    return `${target.getFullYear()}年${month}月${day}日 ${weekday}`
  }
  /** 相邻两条可见消息是否跨天（前一条缺失视为需要分隔）。 */
  function shouldShowDateDivider(prev: HouseholdChatMessage | undefined, current: HouseholdChatMessage): boolean {
    if (!prev) return true
    return !isSameLocalDay(messageTime(prev), messageTime(current))
  }

  // loading 重复修复：transient message 已经承担 loading 指示，
  // 此时若末条可见消息是 transient，不再追加额外的 loading 气泡，避免双气泡。
  const lastVisibleIsTransient = visibleMessages.length > 0
    ? Boolean(visibleMessages[visibleMessages.length - 1].message.isTransient)
    : false
		  const quickQuestions = [
	    "家里现在有哪些快用完了？",
	    "洗衣液还能用多久？",
	    "我刚买了 2 瓶洗衣液",
	    "把猫粮提醒提前 3 天"
	  ]
	  function latestPendingDraftMessageIndex(list: HouseholdChatMessage[]): number {
	    for (let index = list.length - 1; index >= 0; index -= 1) {
	      if (list[index].role === "assistant" && list[index].draftStatus === "pending" && list[index].agentDraft) return index
	    }
	    return -1
	  }

  // AgentPlan 状态机：找到最近一条 planStatus 为 "pending" 或 "awaitingSecondConfirm" 的 agentPlan 消息。
  // 第三期：高风险 plan 第一次确认后进入 awaitingSecondConfirm，仍属于「待处理」。
  function latestPendingPlanMessageIndex(list: HouseholdChatMessage[]): number {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const status = list[index].planStatus
      if (list[index].role === "assistant" && list[index].agentPlan
          && (status === "pending" || status === "awaitingSecondConfirm")) return index
    }
    return -1
  }

	  // 文案统一由 responseComposer 生成；draftIntro / buildPendingDraftReminder / safeQueryFallback
	  // 已下线，全部收敛到 composeProposalMessage / composePendingReminder / composeFallbackMessage。

	  function confirmAgentDraft(messageIndex: number, baseMessages = messages) {
    const message = baseMessages[messageIndex]
    if (!message?.agentDraft) return
    const result = onConfirmDraft(message.agentDraft)
    // 任务四：写入后观察命中时，把口语化收尾拼接到结果消息末尾
    const content = result.observation
      ? `${result.summary} ${result.observation}`
      : result.summary
    onMessagesChange([
      ...baseMessages.map((current, index) => index === messageIndex
        ? { ...current, draftStatus: "confirmed" as const }
        : current),
      { role: "assistant" as const, content, links: result.links, createdAt: Date.now() }
    ])
  }

	  function cancelAgentDraft(messageIndex: number, baseMessages = messages) {
    onMessagesChange(baseMessages.map((message, index) => index === messageIndex
      ? { ...message, draftStatus: "cancelled" as const }
      : message))
  }

  // AgentPlan 确认：调用 onConfirmPlan 写入 state，标记 confirmed，追加结果消息。
  // 确认前不写入；写入后观察命中时拼接到结果消息末尾。
  function confirmAgentPlan(messageIndex: number, baseMessages = messages) {
    const message = baseMessages[messageIndex]
    if (!message?.agentPlan) return
    const result = onConfirmPlan(message.agentPlan)
    const content = result.observation
      ? `${result.summary} ${result.observation}`
      : result.summary
    onMessagesChange([
      ...baseMessages.map((current, index) => index === messageIndex
        ? {
            ...current,
            planStatus: "confirmed" as const,
            agentPlan: current.agentPlan ? { ...current.agentPlan, status: "confirmed" as const } : current.agentPlan
          }
        : current),
      { role: "assistant" as const, content, links: result.links, createdAt: Date.now() }
    ])
  }

  function cancelAgentPlan(messageIndex: number, baseMessages = messages) {
    onMessagesChange(baseMessages.map((message, index) => index === messageIndex
      ? {
          ...message,
          planStatus: "cancelled" as const,
          agentPlan: message.agentPlan ? { ...message.agentPlan, status: "cancelled" as const } : message.agentPlan
        }
      : message))
  }

  // 第三期：高风险 plan 第一次确认后推进到 awaitingSecondConfirm 状态。
  // 不执行任何写入，只改状态，等待用户二次「确认删除」。
  function advancePlanToSecondConfirm(messageIndex: number, baseMessages = messages) {
    onMessagesChange(baseMessages.map((message, index) => index === messageIndex
      ? {
          ...message,
          planStatus: "awaitingSecondConfirm" as const,
          agentPlan: message.agentPlan ? { ...message.agentPlan, status: "awaitingSecondConfirm" as const } : message.agentPlan
        }
      : message))
  }

  // 卡片内联编辑：直接替换 pending 草稿内容，不新增消息
  function reviseDraftInPlace(messageIndex: number, next: AgentDraft) {
    onMessagesChange(messages.map((message, index) => index === messageIndex && message.draftStatus === "pending"
      ? { ...message, agentDraft: next }
      : message))
  }

  // ---------- 批量草稿（订单截图导入）处理 ----------

  function latestPendingBatchMessageIndex(list: HouseholdChatMessage[]): number {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const msg = list[index]
      if (msg.role === "assistant" && msg.agentDraftBatch && msg.batchDraftStatuses &&
          msg.batchDraftStatuses.some((status) => status === "pending")) {
        return index
      }
    }
    return -1
  }

  function patchBatch(messageIndex: number, baseMessages: HouseholdChatMessage[], patch: {
    statuses?: AgentDraftStatus[]
    drafts?: AgentDraft[]
    result?: { summary: string; links: ChatMessageLink[] }
  }): HouseholdChatMessage[] {
    return baseMessages.map((message, index) => index === messageIndex
      ? {
          ...message,
          agentDraftBatch: patch.drafts ?? message.agentDraftBatch,
          batchDraftStatuses: patch.statuses ?? message.batchDraftStatuses,
          batchResult: patch.result ?? message.batchResult
        }
      : message)
  }

  function confirmBatch(messageIndex: number, baseMessages: HouseholdChatMessage[]) {
    const message = baseMessages[messageIndex]
    if (!message?.agentDraftBatch) return
    const draftsToCommit = message.agentDraftBatch.filter((_, i) => message.batchDraftStatuses?.[i] !== "cancelled")
    if (!draftsToCommit.length) {
      onMessagesChange([...patchBatch(messageIndex, baseMessages, { statuses: message.agentDraftBatch.map(() => "cancelled") }),
        { role: "assistant", content: "批量草稿已全部取消，没有写入任何内容。", createdAt: Date.now() }])
      return
    }
    const result = onConfirmBatch(draftsToCommit)
    const finalStatuses: AgentDraftStatus[] = message.agentDraftBatch.map((_, i) =>
      message.batchDraftStatuses?.[i] === "cancelled" ? "cancelled" : "confirmed")
    // 任务四：写入后观察命中时，把口语化收尾拼接到结果消息末尾
    const content = result.observation
      ? `${result.summary} ${result.observation}`
      : result.summary
    onMessagesChange([
      ...patchBatch(messageIndex, baseMessages, { statuses: finalStatuses, result: { summary: result.summary, links: result.links } }),
      { role: "assistant", content, links: result.links, createdAt: Date.now() }
    ])
  }

  function cancelBatch(messageIndex: number, baseMessages: HouseholdChatMessage[]) {
    const message = baseMessages[messageIndex]
    if (!message?.agentDraftBatch) return
    const statuses: AgentDraftStatus[] = message.agentDraftBatch.map(() => "cancelled")
    onMessagesChange([...patchBatch(messageIndex, baseMessages, { statuses }),
      { role: "assistant", content: "已取消全部待确认草稿，没有写入任何内容。", createdAt: Date.now() }])
  }

  function cancelBatchIndex(messageIndex: number, index: number, baseMessages: HouseholdChatMessage[]) {
    const message = baseMessages[messageIndex]
    if (!message?.agentDraftBatch || !message.batchDraftStatuses) return
    if (index < 0 || index >= message.agentDraftBatch.length) return
    if (message.batchDraftStatuses[index] !== "pending") return
    const statuses = message.batchDraftStatuses.map((status, i) => i === index ? "cancelled" as const : status)
    const draft = message.agentDraftBatch[index]
    const label = draft.kind === "createItem" ? draft.itemName
      : draft.kind === "addPurchaseOption" ? draft.productName
      : draft.kind === "restock" ? draft.itemName
      : draft.item.itemName
    onMessagesChange([...patchBatch(messageIndex, baseMessages, { statuses }),
      { role: "assistant", content: `已跳过第 ${index + 1} 条「${label}」。`, createdAt: Date.now() }])
  }

  // ---------- 订单截图导入（对话模式：复用 buildAgentDraftsFromOrderRows + commitAgentDraftBatch） ----------

  function patchOrderImport(messageIndex: number, baseMessages: HouseholdChatMessage[], patch: {
    rows?: SharedOrderImportRow[]
    status?: "pending" | "confirmed" | "cancelled"
    result?: { summary: string; links: ChatMessageLink[] }
  }): HouseholdChatMessage[] {
    return baseMessages.map((message, index) => index === messageIndex
      ? {
          ...message,
          orderImportRows: patch.rows ?? message.orderImportRows,
          orderImportStatus: patch.status ?? message.orderImportStatus,
          orderImportResult: patch.result ?? message.orderImportResult
        }
      : message)
  }

  function confirmOrderImport(messageIndex: number, baseMessages: HouseholdChatMessage[]) {
    const message = baseMessages[messageIndex]
    if (!message?.orderImportRows) return
    const confirmedRows = orderImportRowsToConfirmed(message.orderImportRows)
    if (confirmedRows.length === 0) {
      onMessagesChange([...patchOrderImport(messageIndex, baseMessages, { status: "cancelled" }),
        { role: "assistant", content: "没有要记的内容，我先不动。", createdAt: Date.now() }])
      return
    }
    // 复用 buildAgentDraftsFromOrderRows：与弹窗同一转换路径
    const drafts = buildAgentDraftsFromOrderRows(confirmedRows, state, Date.now())
    if (drafts.length === 0) {
      onMessagesChange([...patchOrderImport(messageIndex, baseMessages, { status: "cancelled" }),
        { role: "assistant", content: "没有要记的内容，我先不动。", createdAt: Date.now() }])
      return
    }
    // 复用 commitAgentDraftBatch：与弹窗同一写入路径
    const result = onConfirmBatch(drafts)
    // 任务四：写入后观察命中时，把口语化收尾拼接到结果消息末尾
    const content = result.observation
      ? `${result.summary} ${result.observation}`
      : result.summary
    onMessagesChange([
      ...patchOrderImport(messageIndex, baseMessages, { status: "confirmed", result: { summary: result.summary, links: result.links } }),
      { role: "assistant", content, links: result.links, createdAt: Date.now() }
    ])
  }

  function cancelOrderImport(messageIndex: number, baseMessages: HouseholdChatMessage[]) {
    onMessagesChange([...patchOrderImport(messageIndex, baseMessages, { status: "cancelled" }),
      { role: "assistant", content: "好，先不记。需要的时候再告诉我。", createdAt: Date.now() }])
  }

  function reviseBatchIndex(messageIndex: number, index: number, text: string, baseMessages: HouseholdChatMessage[]) {
    const message = baseMessages[messageIndex]
    if (!message?.agentDraftBatch || !message.batchDraftStatuses) return
    if (index < 0 || index >= message.agentDraftBatch.length) return
    if (message.batchDraftStatuses[index] !== "pending") return
    const revised = reviseAgentDraft(message.agentDraftBatch[index], text, state)
    if (!revised) {
      onMessagesChange([...baseMessages, { role: "assistant", content: `没能从这句话里解析出第 ${index + 1} 条的修订内容，请换一种说法。`, createdAt: Date.now() }])
      return
    }
    const drafts = message.agentDraftBatch.map((draft, i) => i === index ? revised : draft)
    onMessagesChange([...patchBatch(messageIndex, baseMessages, { drafts }),
      { role: "assistant", content: `已更新第 ${index + 1} 条草稿。`, createdAt: Date.now() }])
  }

  function reviseBatchAll(messageIndex: number, text: string, baseMessages: HouseholdChatMessage[]) {
    const message = baseMessages[messageIndex]
    if (!message?.agentDraftBatch || !message.batchDraftStatuses) return
    let anyRevise = false
    const drafts = message.agentDraftBatch.map((draft, i) => {
      if (message.batchDraftStatuses![i] !== "pending") return draft
      const revised = reviseAgentDraft(draft, text, state)
      if (revised) { anyRevise = true; return revised }
      return draft
    })
    if (!anyRevise) {
      onMessagesChange([...baseMessages, { role: "assistant", content: "没能从这句话里解析出修订内容，请换一种说法。", createdAt: Date.now() }])
      return
    }
    onMessagesChange([...patchBatch(messageIndex, baseMessages, { drafts }),
      { role: "assistant", content: "已更新全部待确认草稿。", createdAt: Date.now() }])
  }

  // ---------- 订单截图上传（对话内复用 orderImport + mapOrderLinesToDrafts） ----------

  /**
   * 处理用户在对话输入区上传的订单截图。
   * 流程：
   *   1. 读取图片 → 压缩 dataUrl
   *   2. 推一条用户消息（含 imageAttachments 缩略图）+ 一条「我看一下这张订单。」管家消息
   *   3. 调 extractOrderFromImage 识别
   *   4. 调 buildOrderImportRowsFromExtract 生成 OrderImportRow[]（与弹窗同一结构）
   *   5. 推一条带 orderImportRows 的管家消息，由 OrderImportReviewList mode="chat" 渲染
   *
   * 不直接写 state；用户在卡片点「就这么记」后才走 buildAgentDraftsFromOrderRows + commitAgentDraftBatch。
   */
  async function handleOrderImageUpload(file: File, caption: string) {
    if (!orderImageApiKey?.trim()) {
      setError("还没有配置识别服务，请先在设置中填写订单识别 API Key。")
      return
    }
    const text = caption.trim()
    const userContent = text || "帮我把这张订单记一下"
    let dataUrl: string
    try {
      dataUrl = await fileToCompressedDataUrl(file)
    } catch {
      setError("图片读取失败，换一张试试。")
      return
    }
    setError(null)
    // 用户消息（含缩略图）+ 管家「看一眼」transient 提示
    // transient 作为 loading 指示，识别完成后会被替换掉，不进入长期历史
    const userMessages: HouseholdChatMessage[] = [
      ...messages,
      {
        role: "user",
        content: userContent,
        imageAttachments: [{ name: file.name, dataUrl }],
        createdAt: Date.now()
      }
    ]
    const transient: HouseholdChatMessage = {
      role: "assistant",
      content: composeOrderRecognizingMessage(),
      isTransient: true,
      createdAt: Date.now()
    }
    onMessagesChange([...userMessages, transient])
    setLoading(true)
    // 构造 catalog：与 OrderImportModal 一致，按最近活跃度排序
    const catalog = [...state.items]
      .sort((a, b) => {
        const latestA = Math.max(a.updatedAt || 0, ...a.history.map((event) => event.at || 0))
        const latestB = Math.max(b.updatedAt || 0, ...b.history.map((event) => event.at || 0))
        return latestB - latestA
      })
      .map((item) => ({
        name: item.name,
        options: (item.purchaseOptions || []).map((option) => option.productName)
      }))
    const result = await extractOrderFromImage(orderImageApiKey, dataUrl, catalog, orderImageModel, orderRecognitionMode || "accurate")
    setLoading(false)
    setLoadingText(null)
    // 用最终消息替换 transient：base 用 userMessages（不含 transient）
    if (!result.ok) {
      onMessagesChange([...userMessages, { role: "assistant", content: result.error, createdAt: Date.now() }])
      return
    }
    const rows = buildOrderImportRowsFromExtract(result.order, state.items, state.categories, 0)
    if (rows.length === 0) {
      onMessagesChange([...userMessages, { role: "assistant", content: "我看了下这张订单，暂时没识别到需要管理的消耗品。", createdAt: Date.now() }])
      return
    }
    // 管家口吻总结：识别到几样，命中已有的有哪些，准备新建的有哪些
    const includedRows = rows.filter((row) => row.targetItem !== "__skip__")
    const skippedRows = rows.filter((row) => row.targetItem === "__skip__")
    const message = composeOrderImportSummary(rows, result.order.platform)
    onMessagesChange([
      ...userMessages,
      {
        role: "assistant",
        content: message,
        orderImportRows: rows,
        orderImportStatus: "pending",
        createdAt: Date.now()
      }
    ])
  }

  function onImageInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = Array.from(event.target.files || [])[0]
    if (file) void handleOrderImageUpload(file, draft)
    setDraft("")
    event.target.value = ""
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const lineHeight = 20
    const verticalPadding = 12
    const maxHeight = lineHeight * 3 + verticalPadding
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [draft])

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
	    const nextMessages: HouseholdChatMessage[] = [...messages, { role: "user", content: text, createdAt: Date.now() }]
    onMessagesChange(nextMessages)
    onQuestionSent(text)
    setDraft("")
    setError(null)
    // 批量草稿（订单导入）仍由外层处理，因为涉及 batchDraftStatuses 数组操作
    const pendingBatchMessageIndex = latestPendingBatchMessageIndex(messages)
    const pendingBatchMessage = pendingBatchMessageIndex >= 0 ? messages[pendingBatchMessageIndex] : undefined
    if (pendingBatchMessage) {
      const batchIntent = classifyBatchIntent(text)
      if (batchIntent) {
        if (batchIntent.intent === "batchConfirm") { confirmBatch(pendingBatchMessageIndex, nextMessages); return }
        if (batchIntent.intent === "batchCancel") { cancelBatch(pendingBatchMessageIndex, nextMessages); return }
        if (batchIntent.intent === "batchCancelIndex") { cancelBatchIndex(pendingBatchMessageIndex, batchIntent.index, nextMessages); return }
        if (batchIntent.intent === "batchReviseIndex") { reviseBatchIndex(pendingBatchMessageIndex, batchIntent.index, text, nextMessages); return }
        if (batchIntent.intent === "batchReviseAll") { reviseBatchAll(pendingBatchMessageIndex, text, nextMessages); return }
      }
    }
    const pendingMessageIndex = latestPendingDraftMessageIndex(messages)
    const pendingDraft = pendingMessageIndex >= 0 ? messages[pendingMessageIndex].agentDraft : undefined
    const pendingPlanMessageIndex = latestPendingPlanMessageIndex(messages)
    const pendingPlan = pendingPlanMessageIndex >= 0 ? messages[pendingPlanMessageIndex].agentPlan : undefined
    const dateContext = buildChatDateContext()

    // 统一管家决策层：所有路径都先经过 orchestrator.decide
    const decision = orchestrator.decide({
      text,
      state,
      itemViews,
      pendingDraft,
      pendingPlan,
      dateContext
    })

    // 响应节奏层：根据意图/turn/上下文决定这一轮的最小延迟和 loading 文案。
    // 用 transient assistant message 显示过程态，让用户看到「管家正在处理」。
    const pacingIntent = classifyAgentIntent(text, Boolean(pendingDraft || pendingPlan))
    const timing = getResponseTiming({
      text,
      intent: pacingIntent,
      turn: decision.kind === "sync" ? decision.turn : null,
      hasPendingDraft: Boolean(pendingDraft || pendingPlan)
    })

    if (decision.kind === "sync") {
      const turn = decision.turn
      // 批量意图标记：交回外层 batch 处理函数（应该在上面已处理，走到这里说明 batch 已失效）
      if (isBatchIntentMarker(turn)) {
        // 仍走节奏，避免秒回
        await waitWithTransient(nextMessages, timing)
        onMessagesChange([...nextMessages, { role: "assistant", content: composeFallbackMessage("no-answer"), createdAt: Date.now() }])
        return
      }
      // AgentPlan 命令（planConfirm / planAwaitingSecondConfirm / planSecondConfirm / planCancel）：
      // typed command，立即反馈，不显示思考
      const planCmd = readTurnCommand(turn)
      if (planCmd) {
        if (planCmd.command === "planConfirm" && pendingPlanMessageIndex >= 0) {
          confirmAgentPlan(pendingPlanMessageIndex, nextMessages)
          return
        }
        if (planCmd.command === "planSecondConfirm" && pendingPlanMessageIndex >= 0) {
          // 二次确认删除：执行写入并标记 confirmed
          confirmAgentPlan(pendingPlanMessageIndex, nextMessages)
          return
        }
        if (planCmd.command === "planAwaitingSecondConfirm" && pendingPlanMessageIndex >= 0) {
          // 第一次确认高风险 plan：只推状态，不执行写入
          advancePlanToSecondConfirm(pendingPlanMessageIndex, nextMessages)
          return
        }
        if (planCmd.command === "planCancel" && pendingPlanMessageIndex >= 0) {
          cancelAgentPlan(pendingPlanMessageIndex, nextMessages)
          return
        }
        // 其他 typed command（batch 类）走到这里说明 batch 已失效，给个兜底
        await waitWithTransient(nextMessages, timing)
        onMessagesChange([...nextMessages, { role: "assistant", content: composeFallbackMessage("no-answer"), createdAt: Date.now() }])
        return
      }
      if (turn.kind === "proposal" && pendingDraft && turn.executableDraft === pendingDraft) {
        // confirmDraft：立即反馈，不显示思考
        confirmAgentDraft(pendingMessageIndex, nextMessages)
        return
      }
      if (turn.kind === "cancelled") {
        // 取消：立即反馈，不显示思考
        cancelAgentDraft(pendingMessageIndex, nextMessages)
        return
      }
      // 其他 sync 路径（answer / clarification / 修订 / 普通 proposal / planProposal）：走节奏
      await waitWithTransient(nextMessages, timing)
      if (turn.kind === "planProposal") {
        // 旧 pendingPlan（若有）标 superseded，新 plan 标 pending
        const base = pendingPlanMessageIndex >= 0
          ? nextMessages.map((message, index) => index === pendingPlanMessageIndex
            ? { ...message, planStatus: "superseded" as const }
            : message)
          : nextMessages
        onMessagesChange([...base, { role: "assistant", content: turn.message, agentPlan: turn.plan, planStatus: "pending" as const, createdAt: Date.now() }])
        return
      }
      if (turn.kind === "proposal" && pendingDraft && turn.executableDraft !== pendingDraft) {
        // 修订：旧 pending 标 superseded，新 draft 标 pending
        const base = nextMessages.map((message, index) => index === pendingMessageIndex
          ? { ...message, draftStatus: "superseded" as const }
          : message)
        onMessagesChange([...base, { role: "assistant", content: turn.message, agentDraft: turn.executableDraft, draftStatus: "pending" as const, createdAt: Date.now() }])
        return
      }
      if (turn.kind === "proposal") {
        // 普通 proposal（新操作，非修订）：如果有 pendingPlan，标记 superseded
        const base = pendingPlanMessageIndex >= 0
          ? nextMessages.map((message, index) => index === pendingPlanMessageIndex
            ? { ...message, planStatus: "superseded" as const }
            : message)
          : nextMessages
        onMessagesChange([...base, { role: "assistant", content: turn.message, agentDraft: turn.executableDraft, draftStatus: "pending" as const, createdAt: Date.now() }])
        return
      }
      // answer / clarification：直接转消息（不打断 pending plan）
      onMessagesChange([...nextMessages, agentTurnToMessage(turn)])
      return
    }
    if (!state.settings.aiApiKey?.trim()) {
      setError("还没有设置 AI API Key。这个问题需要模型分析，设置后就可以继续问。")
      inputRef.current?.focus()
      return
    }
    // LLM 路径：transient message 承担真实等待 + 最小延迟
    // 1. 先追加 transient assistant message
    // 2. 发起 LLM 请求
    // 3. 实际耗时小于 minDelayMs 时补足
    // 4. 用最终 assistant message 替换 transient
    const transient: HouseholdChatMessage | null = timing.showLoading
      ? { role: "assistant", content: timing.loadingText ?? "", isTransient: true, createdAt: Date.now() }
      : null
    if (transient) {
      onMessagesChange([...nextMessages, transient])
      setLoading(true) // 禁用发送按钮，避免重复提交
    }
    const llmStart = Date.now()
    // 构造上下文包：LLM 只看 contextPack 里的内容，不再接收完整 messages
    // 注意：transient 消息不能进入 contextPack，否则会污染 LLM 上下文。
    // compactRecentMessages 已经会跳过 isTransient，这里直接传 nextMessages（不含 transient）。
    const contextPack = buildAgentContextPack({
      messages: nextMessages,
      currentUserText: text,
      state,
      itemViews,
      dateContext,
      seenObservationKeys
    })
    const result = await askHouseholdAssistant({
      apiKey: state.settings.aiApiKey,
      model: state.settings.aiChatModel ?? state.settings.aiModel,
      contextPack
    })
    // 实际耗时已超过 minDelayMs 时不再额外等待
    const remaining = computeRemainingDelay(timing.minDelayMs, Date.now() - llmStart)
    if (remaining > 0) await sleep(remaining)
    setLoading(false)
    setLoadingText(null)
    // 用最终消息替换 transient：baseMessages 不含 transient，直接追加最终消息即可
    const baseWithoutTransient = nextMessages
	    if (result.ok) {
	      const turn = orchestrator.normalizeLlmResponse(result.content.trim(), {
	        text, state, itemViews, pendingDraft, dateContext
	      })
	      if (!turn) {
	        // 非管家问题不再统一机械拒绝：按对话边界给自然回应。
	        // pendingDraft 存在时是写入意图失败，仍用 no-draft 文案。
	        const fallback = pendingDraft
	          ? composeFallbackMessage("no-draft")
	          : composeBoundaryAnswer(classifyConversationBoundary(text), text)
	        onMessagesChange([...baseWithoutTransient, { role: "assistant", content: fallback, createdAt: Date.now() }])
	        return
	      }
	      if (turn.kind === "proposal" && pendingDraft) {
	        // LLM 返回新 draft：旧 pending 标 superseded
	        const base = baseWithoutTransient.map((message, index) => index === pendingMessageIndex
	          ? { ...message, draftStatus: "superseded" as const }
	          : message)
	        onMessagesChange([...base, { role: "assistant", content: turn.message, agentDraft: turn.executableDraft, draftStatus: "pending" as const, createdAt: Date.now() }])
	        return
	      }
	      onMessagesChange([...baseWithoutTransient, agentTurnToMessage(turn)])
	    } else {
      // 任务四 A：LLM 失败/超时时用 answerHouseholdQuickly 作为兜底回答
      const fallbackAnswer = answerHouseholdQuickly(text, state, itemViews, dateContext, seenObservationKeys)
      if (fallbackAnswer) {
        onMessagesChange([...baseWithoutTransient, { role: "assistant", content: fallbackAnswer, createdAt: Date.now() }])
        return
      }
      // answerHouseholdQuickly 未命中：按对话边界给自然回应，不再统一 setError
      const boundaryFallback = composeBoundaryAnswer(classifyConversationBoundary(text), text)
      onMessagesChange([...baseWithoutTransient, { role: "assistant", content: boundaryFallback, createdAt: Date.now() }])
    }
  }

  /**
   * 响应节奏层辅助：sync 路径用 transient assistant message 显示过程态，等待 minDelayMs。
   * - timing.showLoading=false 或 minDelayMs<=0 时直接返回（confirm/cancel 立即反馈）
   * - 否则追加 transient message，等待后由调用方用最终消息替换（这里只负责等待和清理）
   */
  async function waitWithTransient(
    baseMessages: HouseholdChatMessage[],
    timing: { minDelayMs: number; loadingText?: string; showLoading: boolean }
  ) {
    if (timing.minDelayMs <= 0 || !timing.showLoading) return
    // 追加 transient message 显示过程态
    const transient: HouseholdChatMessage = {
      role: "assistant",
      content: timing.loadingText ?? "",
      isTransient: true,
      createdAt: Date.now()
    }
    onMessagesChange([...baseMessages, transient])
    setLoading(true) // 禁用发送按钮，避免重复提交
    await sleep(timing.minDelayMs)
    setLoading(false)
    setLoadingText(null)
    // 恢复为不含 transient 的基线，由调用方追加最终消息
    onMessagesChange(baseMessages)
  }

  /** 简单的 sleep 工具 */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 把 AgentTurn 映射成 HouseholdChatMessage。UI 只读 message + 附带字段，不直接读 executableDraft 字段表。 */
  function agentTurnToMessage(turn: AgentTurn): HouseholdChatMessage {
    const createdAt = Date.now()
    if (turn.kind === "answer") {
      return { role: "assistant", content: turn.message, createdAt }
    }
    if (turn.kind === "proposal") {
      return { role: "assistant", content: turn.message, agentDraft: turn.executableDraft, draftStatus: "pending" as const, createdAt }
    }
    if (turn.kind === "planProposal") {
      return { role: "assistant", content: turn.message, agentPlan: turn.plan, planStatus: "pending" as const, createdAt }
    }
    if (turn.kind === "clarification") {
      return {
        role: "assistant",
        content: turn.message,
        clarification: { question: turn.message, options: turn.options, provisional: turn.provisional },
        createdAt
      }
    }
    return { role: "assistant", content: turn.message, createdAt }
  }

	  function submit(event: FormEvent) {
    event.preventDefault()
    if (!loading) void sendMessage()
  }

  return (
    <div
      className={`overlay chat-overlay ${isClosing ? "is-closing" : ""}`}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <aside className={`panel chat-panel ${isClosing ? "is-closing" : ""}${expanded ? " is-expanded" : ""}`} role="dialog" aria-modal="true" aria-labelledby="household-chat-title">
        <div className="panel-header chat-panel-header">
          <div className="panel-header-info">
            <h2 id="household-chat-title">403管家</h2>
          </div>
          <div className="chat-panel-actions">
            <button
              type="button"
              className="icon-button chat-expand-btn"
              aria-label={expanded ? "收起为侧栏" : "展开对话"}
              aria-pressed={expanded}
              title={expanded ? "收起为侧栏" : "展开对话"}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 21 3 15 9 9" /><polyline points="15 3 21 9 15 15" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              )}
            </button>
            <button className="icon-button close-btn" aria-label="关闭家庭问答" onClick={onClose}><Icon name="close" size={16} /></button>
          </div>
        </div>

        <div className="chat-panel-body">
          <div className="chat-log" ref={logRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <strong>你可以直接问我家里还缺什么，也可以告诉我刚买了什么、什么快用完了。</strong>
                {starter ? <span className="chat-empty-hint">{starter}</span> : null}
                <div className="chat-suggestions">
                  {quickQuestions.map((question) => (
                    <button key={question} type="button" onClick={() => void sendMessage(question)} disabled={loading}>{question}</button>
                  ))}
                </div>
              </div>
            ) : (
	              visibleMessages.map(({ message, index }, visibleIndex) => {
                const prevVisible = visibleIndex > 0 ? visibleMessages[visibleIndex - 1].message : undefined
                const showDivider = shouldShowDateDivider(prevVisible, message)
                return (
                  <Fragment key={message.createdAt ? `${message.role}-${message.createdAt}-${index}` : `${message.role}-${index}`}>
                    {showDivider && (
                      <div className="chat-date-divider" role="separator" aria-label={formatDateDivider(messageTime(message))}>
                        <span>{formatDateDivider(messageTime(message))}</span>
                      </div>
                    )}
                    <div className={`chat-message ${message.role}${message.isTransient ? " is-transient" : ""}`}>
                  {message.role === "assistant" ? (
                    <>
                      <ManagerAvatar />
                      <div className="chat-message-stack">
                        {message.isTransient ? (
                          message.content ? (
                            <div className="chat-message-content muted">{message.content}</div>
                          ) : (
                            <div className="typing-dots" aria-label="管家正在输入">
                              <span />
                              <span />
                              <span />
                            </div>
                          )
                        ) : (
                          <>
                        {message.content && <div className="chat-message-content">{renderChatAnswer(message.content)}</div>}
	                    {message.agentDraft && (
		                      <AgentDraftCard
		                        draft={message.agentDraft}
		                        status={message.draftStatus || "pending"}
		                        onConfirm={() => confirmAgentDraft(index)}
		                        onCancel={() => cancelAgentDraft(index)}
		                        onDraftChange={(next) => reviseDraftInPlace(index, next)}
		                      />
	                    )}
	                    {message.agentPlan && (() => {
	                      const plan = message.agentPlan
	                      const currentStatus = message.planStatus || "pending"
	                      const isHighRisk = plan.requiresSecondConfirm === true || plan.risk === "high"
	                      return (
	                        <AgentPlanCard
	                          plan={plan}
	                          status={currentStatus}
	                          onConfirm={() => {
	                            // 第三期：高风险 plan 的 onConfirm 行为依赖当前 status
	                            //   pending + highRisk → 推进到 awaitingSecondConfirm（不执行）
	                            //   awaitingSecondConfirm → 执行写入并标记 confirmed
	                            //   普通 pending → 执行写入并标记 confirmed
	                            if (isHighRisk && currentStatus === "pending") {
	                              advancePlanToSecondConfirm(index)
	                            } else {
	                              confirmAgentPlan(index)
	                            }
	                          }}
	                          onCancel={() => cancelAgentPlan(index)}
	                        />
	                      )
	                    })()}
	                    {message.clarification && (
	                      <div className="chat-clarification-card">
	                        <div className="chat-clarification-options">
	                          {message.clarification.options.map((option) => (
	                            <button
	                              key={option.label}
	                              type="button"
	                              className="quiet-button compact"
	                              onClick={() => void sendMessage(option.hint || option.label)}
	                              disabled={loading}
	                            >
	                              {option.label}
	                            </button>
	                          ))}
	                        </div>
	                        <small className="chat-action-hint">点上面选项，或者直接打字告诉我。</small>
	                      </div>
	                    )}
	                    {message.orderImportRows && (
	                      <OrderImportReviewList
	                        rows={message.orderImportRows}
	                        items={state.items}
	                        categories={state.categories}
	                        mode="chat"
	                        onRowsChange={(nextRows) => {
	                          onMessagesChange(messages.map((msg, msgIndex) =>
	                            msgIndex === index ? { ...msg, orderImportRows: nextRows } : msg
	                          ))
	                        }}
	                        onSkipIndex={(rowIndex) => {
	                          const nextRows = (message.orderImportRows || []).map((row, rowIdx) =>
	                            rowIdx === rowIndex ? { ...row, targetItem: "__skip__" as const } : row
	                          )
	                          onMessagesChange(messages.map((msg, msgIndex) =>
	                            msgIndex === index ? { ...msg, orderImportRows: nextRows } : msg
	                          ))
	                        }}
	                        onConfirmBatch={() => confirmOrderImport(index, messages)}
	                        onCancelBatch={() => cancelOrderImport(index, messages)}
	                        result={message.orderImportResult}
	                        onOpenItem={onOpenItem}
	                      />
	                    )}
	                    {message.links && message.links.length > 0 && (
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
                          </>
                        )}
                            <div className="chat-message-time">{formatClock(messageTime(message))}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>{message.content}</p>
                      {message.imageAttachments && message.imageAttachments.length > 0 && (
                        <div className="chat-image-attachments">
                          {message.imageAttachments.map((attachment, attachIndex) => (
                            <img
                              key={attachIndex}
                              src={attachment.dataUrl}
                              alt={attachment.name}
                              className="chat-image-thumbnail"
                            />
                          ))}
                        </div>
                      )}
                      <div className="chat-message-time">{formatClock(messageTime(message))}</div>
                    </>
                  )}
                    </div>
                  </Fragment>
                )
              })
            )}
            {loading && !lastVisibleIsTransient && (
              <div className="chat-message assistant is-loading">
                <p>{loadingText || "…"}</p>
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
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              onChange={onImageInputChange}
              style={{ display: "none" }}
              aria-hidden="true"
            />
            <div className="chat-input-shell">
              <textarea
                id="household-chat-input"
                ref={inputRef}
                value={draft}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    if (!loading) void sendMessage()
                  }
                }}
                placeholder=""
              />
              <div className="chat-input-tools">
                <button
                  type="button"
                  className="chat-attach-button"
                  aria-label="上传订单截图"
                  title="上传订单截图"
                  disabled={loading}
                  onClick={() => imageInputRef.current?.click()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>订单截图</span>
                </button>
                <button type="submit" className="primary-button chat-send-button" disabled={loading}>
                  {loading && <span className="chat-send-spinner" aria-hidden="true" />}
                  发送
                </button>
              </div>
            </div>
          </div>
        </form>
      </aside>
    </div>
  )
}

const pricingModeLabels = {
  spec: "按规格计价",
  measure: "按含量计价"
} as const

const purchaseSpecUnitOptions = ["袋", "瓶", "包", "盒", "支", "卷", "桶", "罐", "个", "只", "片", "板", "箱", "提", "件"] as const

function getMeasureDimensionBaseUnit(dimension: string): string {
  if (dimension === "mass") return "克"
  if (dimension === "volume") return "毫升"
  return "个"
}

function getMeasureUnitDisplay(value?: string): string {
  return getMeasureUnitLabel(value)
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

function CurrentTasks({ items, snoozedItems, allItems, onRestock, onSnooze, onApplySuggestion, onDismissSuggestion, onOpenItem, onAddItem, onOpenOrderImport }: {
  items: ItemView[]
  snoozedItems: ItemView[]
  allItems: ItemView[]
  onRestock: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onOpenItem: (item: ReplenishmentItem) => void
  onAddItem: () => void
  onOpenOrderImport: () => void
}) {
  const hasCurrentTasks = items.length > 0
  const hasSnoozedTasks = snoozedItems.length > 0
  const hasAnyTasks = hasCurrentTasks || hasSnoozedTasks
  const hasNoItemsAtAll = allItems.length === 0
  const quickActions = hasNoItemsAtAll ? null : (
    <div className="home-quick-actions" aria-label="首页快捷操作">
      <button type="button" className="quiet-button order-import-trigger" onClick={onOpenOrderImport}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
        从订单截图导入
      </button>
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
              {items.map(({ item, computed }, i) => (
                <div key={item.id} className="current-card-group" style={{ "--index": i } as React.CSSProperties}>
                  <article className={`current-card ${computed.status}`}>
                    <button type="button" className="current-card-copy current-card-open" onClick={() => onOpenItem(item)} aria-label={`查看${item.name}详情`}>
                      <span className={`status-dot ${computed.status}`} />
                      <span>
                        <span className="current-card-title-row">
                          <strong className="current-item-title">{item.name}</strong>
                          <span className="current-category-badge">{item.category || "未分类"}</span>
                        </span>
                        <small>{formatItemStatusText(item, computed)}<span className="inline-detail-cue">查看详情</span></small>
                      </span>
                    </button>
                    <div className="current-card-controls">
                      <button className="task-snooze-link" onClick={() => onSnooze(item)}>稍后提醒</button>
                      <TaskActions item={item} onRestock={onRestock} />
                    </div>
                  </article>
                </div>
              ))}
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

function SettingsPanel({ state, onChange, onClose, isClosing }: { state: AppState; onChange: (state: AppState) => void; onClose: () => void; isClosing?: boolean }) {
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

/** 单次批量导入的截图数量上限，沿用共享常量 */
const MAX_ORDER_IMAGES = ORDER_IMPORT_MAX_IMAGES

type OrderImportRow = SharedOrderImportRow

export type OrderImportConfirmedRow = SharedOrderImportConfirmedRow

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
    return buildOrderImportRowsFromExtract(order, items, categories, imageIndex)
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
    onConfirm({ rows: orderImportRowsToConfirmed(rows) })
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
              <OrderImportReviewList
                rows={rows}
                items={items}
                categories={categories}
                mode="modal"
                onRowsChange={setRows}
              />
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

function Sidebar({ dueCount, categorySummaries, allItems, now, activeCategory, pendingDelete, onSelectCategory, onCreateCategory, onOpenSettings, onRenameCategory, onRequestDeleteCategory, onCancelDeleteCategory, onConfirmDeleteCategory, onOpenChat, isChatOpen }: {
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
  onOpenChat: () => void
  isChatOpen: boolean
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

      <button
        type="button"
        className={`sidebar-assistant ${isChatOpen ? "is-active" : ""}`}
        onClick={onOpenChat}
        aria-pressed={isChatOpen}
      >
        <span className="sidebar-assistant-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.6 8.6 0 0 1-7.7 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.5A8.4 8.4 0 0 1 4 11.6 8.6 8.6 0 0 1 12.6 3 8.4 8.4 0 0 1 21 11.5Z" /><path d="M8.5 10.5h7" /><path d="M8.5 14h4.5" /></svg>
        </span>
        <span className="sidebar-assistant-text">
          <span className="sidebar-assistant-title">问问管家</span>
          <span className="sidebar-assistant-sub">查询、记录、补货都可以问</span>
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
