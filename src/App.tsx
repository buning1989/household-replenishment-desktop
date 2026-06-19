import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { AnimatedIcon as Icon } from "./AnimatedIcon"
import catIcon from "./assets/cat-icon.png"
import {
  calibrateRemainingDays,
  calculateConsumption,
  calculatePriceAnchor,
  computeItem,
  createItem,
  DEFAULT_CYCLES,
  estimateRemainingQty,
  formatDate,
  formatPrice,
  formatUnitPrice,
  getLatestRating,
  nextSnoozeTime,
  restockItem,
  updateItemFromDraft
} from "./domain"
import { loadState, persistState } from "./store"
import type { AppState, ItemComputed, ItemDraft, PriceAnchor, Rating, RecentRestock, ReplenishmentItem, PurchaseOption, RestockEvent } from "./types"
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
function formatItemStatusText(item: ReplenishmentItem, computed: ItemComputed): string {
  const parts: string[] = []
  
  // 1. 剩余天数
  parts.push(`还剩约 ${Math.max(0, computed.daysUntilDepletion)} 天`)
  
  // 2. 补货间隔
  if (item.cycleDays) {
    parts.push(`每 ${item.cycleDays} 天补货`)
  }
  
  // 3. 提前提醒
  if (item.bufferDays) {
    parts.push(`提前 ${item.bufferDays} 天提醒`)
  }
  
  // 4. 上次补货日期
  if (item.lastRestockedAt) {
    const lastRestockDate = new Date(item.lastRestockedAt)
    const month = lastRestockDate.getMonth() + 1
    const day = lastRestockDate.getDate()
    parts.push(`上次补货 ${month}月${day}日`)
  }
  
  // 5. 默认购买量 + 计量单位
  const unit = item.unit || "件"
  if (item.defaultQty) {
    parts.push(`默认 ${item.defaultQty} ${unit}`)
  }
  
  return parts.join(' · ')
}

function cloneItem(item: ReplenishmentItem): ReplenishmentItem {
  return { ...item, history: item.history.map((event) => ({ ...event })) }
}

type ItemViewType = { item: ReplenishmentItem; computed: ItemComputed }

function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [editingItem, setEditingItem] = useState<ReplenishmentItem | null | undefined>(undefined)
  const [newItemCategory, setNewItemCategory] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [categoryCreatorOpen, setCategoryCreatorOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<"rename" | "delete" | null>(null)
  const [detailItemId, setDetailItemId] = useState<string | null>(null)
  const [recentRestock, setRecentRestock] = useState<RecentRestock | null>(null)
  // Restock modal state
  const [restockModalOpen, setRestockModalOpen] = useState(false)
  const [restockModalItemId, setRestockModalItemId] = useState<string | null>(null)
  const [selectedPurchaseOption, setSelectedPurchaseOption] = useState<PurchaseOption | null>(null)
  const [restockQty, setRestockQty] = useState<number | ''>('')
  const [restockPrice, setRestockPrice] = useState<number | ''>('')
  const [now, setNow] = useState(() => Date.now())
  // Panel exit animation states
  const [categoryPanelClosing, setCategoryPanelClosing] = useState(false)
  const [detailPanelClosing, setDetailPanelClosing] = useState(false)
  const [editorClosing, setEditorClosing] = useState(false)
  const [settingsClosing, setSettingsClosing] = useState(false)
  const [categoryCreatorClosing, setCategoryCreatorClosing] = useState(false)
  const [categoryManagerClosing, setCategoryManagerClosing] = useState(false)
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
  function deferredClose(setClosing: (v: boolean) => void, actualClose: () => void, delay = 200) {
    setClosing(true)
    setTimeout(() => { setClosing(false); actualClose() }, delay)
  }

  const itemViews = useMemo(() => state.items
    .map((item) => ({ item, computed: computeItem(item, now) }))
    .sort((a, b) => a.computed.dueAt - b.computed.dueAt), [now, state.items])
  const dueItems = useMemo(() => {
    const filtered = itemViews.filter(({ item, computed }) =>
      computed.isDue || (recentRestock && item.id === recentRestock.itemId)
    )
    // 刚补货的物品用补货前的快照 dueAt 排序，避免因 dueAt 重置而沉到列表底部
    return filtered.sort((a, b) => {
      const aDueAt = recentRestock?.itemId === a.item.id
        ? computeItem(recentRestock.snapshot, now).dueAt
        : a.computed.dueAt
      const bDueAt = recentRestock?.itemId === b.item.id
        ? computeItem(recentRestock.snapshot, now).dueAt
        : b.computed.dueAt
      return aDueAt - bDueAt
    })
  }, [itemViews, recentRestock, now])
  const detailItem = detailItemId ? state.items.find((item) => item.id === detailItemId) || null : null
  const categorySummaries = useMemo(() => state.categories.map((category) => {
    const views = itemViews.filter(({ item }) => item.category === category)
    return {
      category,
      views,
      urgent: views.filter(({ computed }) => computed.displayStatus === "urgent").length,
      warning: views.filter(({ computed }) => computed.displayStatus === "warning").length
    }
  }), [itemViews, state.categories])

  useEffect(() => {
    persistState(state)
  }, [state])

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
      const snoozeUntil = nextSnoozeTime(state.settings.snoozeUntilHour)
      updateItems(payload.itemIds, (item) => ({ ...item, snoozeUntil, updatedAt: Date.now() }))
    }
  }), [state.items, state.settings.snoozeUntilHour])

  useEffect(() => {
    function closeTopPanel(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (categoryDialog) setCategoryDialog(null)
      else if (detailItemId) deferredClose(setDetailPanelClosing, () => setDetailItemId(null))
      else if (settingsOpen) deferredClose(setSettingsClosing, () => setSettingsOpen(false))
      else if (editingItem !== undefined) {
        deferredClose(setEditorClosing, () => { setEditingItem(undefined); setNewItemCategory(undefined) })
      }
      else if (categoryCreatorOpen) deferredClose(setCategoryCreatorClosing, () => setCategoryCreatorOpen(false), 150)
    }
    window.addEventListener("keydown", closeTopPanel)
    return () => window.removeEventListener("keydown", closeTopPanel)
  }, [categoryCreatorOpen, categoryDialog, detailItemId, editingItem, settingsOpen])

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
    setSelectedPurchaseOption(null)
    setRestockQty('')
    setRestockPrice('')
  }

  // 统一补货入口：所有补货流程都经由 domain.restockItem 完成状态迁移
  // （append history、计算 intervalDays、清除 snoozeUntil、周期学习等均由 domain 负责）
  function performRestock(itemId: string, qty?: number, price?: number, platform?: string) {
    updateItems([itemId], (current) => restockItem(current, Date.now(), price, qty, platform))
  }

  function undoRestock() {
    if (!recentRestock) return
    const snapshot = cloneItem(recentRestock.snapshot)
    updateItems([recentRestock.itemId], () => snapshot)
    setRecentRestock(null)
  }

  function saveRestockAmount() {
    if (!recentRestock) return
    const amount = recentRestock.amount ? Math.max(0, Number(recentRestock.amount)) : undefined
    const qty = recentRestock.qty ? Math.max(1, Number(recentRestock.qty)) : undefined
    const platform = recentRestock.platform === "其他" ? recentRestock.customPlatform.trim() : recentRestock.platform
    const linkDraft = recentRestock.linkDraft.trim() || undefined

    updateItems([recentRestock.itemId], (item) => {
      const newHistory = item.history.map((event, index) =>
        index === item.history.length - 1
          ? { ...event, price: amount, qty, platform: platform || undefined }
          : event
      )
      const updated: ReplenishmentItem = {
        ...item,
        price: amount ?? item.price,
        platform: platform || item.platform,
        link: linkDraft ?? item.link,
        history: newHistory,
        updatedAt: Date.now()
      }
      return updated
    })
    setRecentRestock(null)
  }

  function handleSnooze(item: ReplenishmentItem) {
    const snoozeUntil = nextSnoozeTime(state.settings.snoozeUntilHour)
    updateItems([item.id], (current) => ({ ...current, snoozeUntil, updatedAt: Date.now() }))
  }

  function calibrateItem(item: ReplenishmentItem, remainingDays: number) {
    updateItems([item.id], (current) => calibrateRemainingDays(current, remainingDays))
  }

  function quickEditItem(item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform" | "purchaseOptions">>) {
    updateItems([item.id], (current) => ({ ...current, ...patch, updatedAt: Date.now() }))
  }

  function saveItem(draft: ItemDraft) {
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

  function deleteCategory(category: string, moveTo?: string) {
    setState((current) => ({
      ...current,
      categories: current.categories.filter((name) => name !== category),
      items: moveTo
        ? current.items.map((item) => item.category === category ? { ...item, category: moveTo, updatedAt: Date.now() } : item)
        : current.items.filter((item) => item.category !== category),
      updatedAt: Date.now()
    }))
    setCategoryDialog(null)
    setActiveCategory(null)
  }

  function deleteItem(item: ReplenishmentItem) {
    commit({ ...state, items: state.items.filter((current) => current.id !== item.id) })
    setDetailItemId(null)
    setEditingItem(undefined)
  }

  function renameItem(id: string, newName: string) {
    setState(prev => ({
      ...prev,
      items: prev.items.map(item => 
        item.id === id ? { ...item, name: newName } : item
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
    // 经由 domain.restockItem 完成补货，避免手写 patch 绕过学习/状态机
    performRestock(itemId, item.defaultQty || 1, option.price, option.platform)
    setDetailItemId(null)
  }

  function handleAddPurchaseOption(itemId: string, optionData: Omit<PurchaseOption, 'id'>) {
    const option: PurchaseOption = {
      id: crypto.randomUUID(),
      ...optionData
    }
    
    updateItems([itemId], (current) => ({
      ...current,
      purchaseOptions: [...(current.purchaseOptions || []), option]
    }))
    
    // 关闭弹窗
    setShowAddPurchaseModal(false)
    setAddPurchaseOptionItemId(null)
  }

  // 保存编辑后的采购选项
  function handleSaveEditedOption(editedOption: PurchaseOption) {
    const item = state.items.find(i => i.purchaseOptions?.some(opt => opt.id === editedOption.id))
    if (!item) return
    
    updateItems([item.id], (current) => ({
      ...current,
      purchaseOptions: (current.purchaseOptions || []).map(opt => 
        opt.id === editedOption.id ? editedOption : opt
      )
    }))
    
    setEditModalOpen(false)
    setEditingPurchaseOption(null)
  }

  // 编辑采购选项
  function handleEditPurchaseOption(option: PurchaseOption) {
    setEditingPurchaseOption(option)
    setEditModalOpen(true)
  }

  // 删除采购选项
  function handleDeletePurchaseOption(itemId: string, optionId: string) {
    if (!window.confirm('确定要删除这个采购选项吗？')) return
    
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
    setSelectedPurchaseOption(null)
    setRestockQty('')
    setRestockPrice('')
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

  return (
    <div className="app-shell">
      <header className="topbar">
        {/* Topbar 保留用于拖拽窗口 */}
      </header>

      <div className="app-body">
        <Sidebar
          dueCount={dueItems.length}
          categorySummaries={categorySummaries}
          activeCategory={activeCategory}
          onSelectCategory={setActiveCategory}
          onCreateCategory={() => setCategoryCreatorOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onRenameCategory={renameCategory}
          onDeleteCategory={(name) => deleteCategory(name)}
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
              onDelete={() => setCategoryDialog("delete")}
              onEdit={editFromDetail}
              onSnooze={handleSnooze}
              onRestock={handleRestock}
              onQuickEdit={quickEditItem}
              onApplySuggestion={applyCycleSuggestion}
              onDismissSuggestion={dismissSuggestion}
              onRateEvent={rateRestockEvent}
              onOpenItemEditor={(itemId) => {
                setEditingItemId(itemId)
                setIsItemEditorDialogOpen(true)
              }}
              onRestockFromOption={handleRestockFromOption}
              showAddPurchaseModal={showAddPurchaseModal}
              setShowAddPurchaseModal={setShowAddPurchaseModal}
              addPurchaseOptionItemId={addPurchaseOptionItemId}
              setAddPurchaseOptionItemId={setAddPurchaseOptionItemId}
              onAddPurchaseOption={handleAddPurchaseOption}
              editingPurchaseOption={editingPurchaseOption}
              setEditingPurchaseOption={setEditingPurchaseOption}
              editModalOpen={editModalOpen}
              setEditModalOpen={setEditModalOpen}
              onEditPurchaseOption={handleEditPurchaseOption}
              onDeletePurchaseOption={handleDeletePurchaseOption}
              onSaveEditedOption={handleSaveEditedOption}
            />
          ) : (
            <CurrentTasks
              items={dueItems}
              recentRestock={recentRestock}
              allItems={itemViews}
              snoozeUntilHour={state.settings.snoozeUntilHour}
              onRestock={handleRestock}
              onSnooze={handleSnooze}
              onUpdateRestock={(patch) => setRecentRestock((current) => current ? { ...current, ...patch } : current)}
              onSaveRestock={saveRestockAmount}
              onUndoRestock={undoRestock}
              onDismissRestock={() => setRecentRestock(null)}
              onApplySuggestion={applyCycleSuggestion}
              onDismissSuggestion={dismissSuggestion}
              onOpenItem={openItem}
              onAddItem={() => {
                setCreatingCategory(state.categories[0] || null)
                setIsItemCreatorOpen(true)
              }}
            />
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
          onEdit={editFromDetail}
          onSnooze={handleSnooze}
          onRestock={handleRestock}
          onCalibrate={calibrateItem}
          onApplySuggestion={applyCycleSuggestion}
          onDismissSuggestion={dismissSuggestion}
          onRateEvent={rateRestockEvent}
        />
      )}
      {(editingItem !== undefined || editorClosing) && (
        <ItemEditor item={editingItem ?? null} initialCategory={newItemCategory} categories={state.categories} onAddCategory={addCategory} isClosing={editorClosing} onClose={() => deferredClose(setEditorClosing, () => {
          setEditingItem(undefined)
          setNewItemCategory(undefined)
        })} onSave={saveItem} onDelete={editingItem ? deleteItem : undefined} />
      )}
      {(settingsOpen || settingsClosing) && <SettingsPanel state={state} onChange={commit} isClosing={settingsClosing} onClose={() => deferredClose(setSettingsClosing, () => setSettingsOpen(false))} />}
      {isItemCreatorOpen && (
        <ItemCreatorDialog
          category={creatingCategory || ''}
          isOpen={isItemCreatorOpen}
          onClose={() => {
            setIsItemCreatorOpen(false)
            setCreatingCategory(null)
          }}
          onCreate={(itemData) => {
            console.log('App onCreate called with:', itemData)
            const newItem = createItem({
              name: itemData.name,
              category: creatingCategory || '其他',
              cycleDays: itemData.usageIntervalDays || 10,
              bufferDays: itemData.bufferDays !== undefined ? itemData.bufferDays : 2,
              unit: itemData.unit || '件',
              defaultQty: itemData.initialStock ? String(itemData.initialStock) : '',
              platform: itemData.platform || '',
              link: '',
              remainingDays: '',
              learningEnabled: true,
              price: itemData.price
            })
            console.log('Created newItem:', newItem)
            commit({
              ...state,
              items: [...state.items, newItem],
              categories: state.categories.includes(newItem.category)
                ? state.categories
                : [...state.categories, newItem.category]
            })
            console.log('State committed, new items count:', state.items.length + 1)
          }}
        />
      )}
      {(categoryCreatorOpen || categoryCreatorClosing) && <CategoryCreator existingCategories={state.categories} isClosing={categoryCreatorClosing} onClose={() => deferredClose(setCategoryCreatorClosing, () => setCategoryCreatorOpen(false), 150)} onCreate={(name) => {
        const category = addCategory(name)
        if (!category) return false
        setCategoryCreatorOpen(false)
        return true
      }} />}
      {activeCategory && categoryDialog && <CategoryManagerDialog mode={categoryDialog} category={activeCategory} categories={state.categories} itemCount={state.items.filter((item) => item.category === activeCategory).length} isClosing={categoryManagerClosing} onClose={() => deferredClose(setCategoryManagerClosing, () => setCategoryDialog(null), 150)} onRename={(name) => renameCategory(activeCategory, name)} onDelete={(moveTo) => deleteCategory(activeCategory, moveTo)} />}
      <ItemEditorDialog
        item={state.items.find(i => i.id === editingItemId) || null}
        categories={[...new Set(state.items.map(i => i.category))]}
        isOpen={isItemEditorDialogOpen}
        onClose={() => {
          setIsItemEditorDialogOpen(false)
          setEditingItemId(null)
        }}
        onRename={renameItem}
        onMove={moveItemToCategory}
        onDelete={deleteItemById}
      />
      
      {/* 补货弹窗 */}
      <RestockModal
        isOpen={restockModalOpen}
        onClose={handleCancelRestock}
        item={restockModalItemId ? state.items.find(i => i.id === restockModalItemId) || null : null}
        onConfirm={(itemId, option, qty, price) => {
          performRestock(itemId, qty, price || undefined, option?.platform)
          handleCancelRestock()
        }}
      />
    </div>
  )
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
    <div className={`overlay category-creator-overlay ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className={`category-creator ${isClosing ? "is-closing" : ""}`} onSubmit={submit}>
        <div className="category-creator-header">
          <h2>添加分类</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </div>
        <label className="field"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：宝宝用品" /></label>
        {duplicated && <p className="category-creator-tip error">这个分类已经有了</p>}
        <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!normalized || duplicated}>添加</button></div>
      </form>
    </div>
  )
}

type ItemView = { item: ReplenishmentItem; computed: ItemComputed }

function TaskActions({ item, onRestock, onUndo, isExpanded }: {
  item: ReplenishmentItem
  onRestock: (item: ReplenishmentItem) => void
  onUndo?: () => void
  isExpanded?: boolean
}) {
  const latestRating = getLatestRating(item)
  if (isExpanded && onUndo) {
    return (
      <div className="task-actions">
        <button className="task-action collapse" onClick={onUndo}>收起</button>
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

function CurrentTasks({ items, recentRestock, allItems, snoozeUntilHour, onRestock, onSnooze, onUpdateRestock, onSaveRestock, onUndoRestock, onDismissRestock, onApplySuggestion, onDismissSuggestion, onOpenItem, onAddItem }: {
  items: ItemView[]
  recentRestock: RecentRestock | null
  allItems: ItemView[]
  snoozeUntilHour: number
  onRestock: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onUpdateRestock: (patch: Partial<RecentRestock>) => void
  onSaveRestock: () => void
  onUndoRestock: () => void
  onDismissRestock: () => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onOpenItem: (item: ReplenishmentItem) => void
  onAddItem: () => void
}) {
  const [snoozedMap, setSnoozedMap] = useState<Map<string, number>>(new Map())

  function handleSnoozeWithFeedback(item: ReplenishmentItem) {
    onSnooze(item)
    const hour = snoozeUntilHour || 9
    setSnoozedMap(prev => new Map(prev).set(item.id, hour))
    setTimeout(() => {
      setSnoozedMap(prev => { const next = new Map(prev); next.delete(item.id); return next })
    }, 2000)
  }

  const restockItem = recentRestock ? items.find(({ item }) => item.id === recentRestock.itemId) : null

  const hasAny = items.length > 0
  const hasNoItemsAtAll = allItems.length === 0

  return (
    <section className="current-section" aria-labelledby="current-title">
      {hasAny && (
        <div className="current-heading"><h2 id="current-title">当前待处理</h2><span>{items.length > 0 ? `${items.length} 项` : ""}</span></div>
      )}

      {items.length > 0 && (
        <div className="current-list">
          {items.map(({ item, computed }, i) => {
            const remainingQty = estimateRemainingQty(item)
            const snoozeHour = snoozedMap.get(item.id)
            return (
              <div key={item.id} className="current-card-group" style={{ "--index": i } as React.CSSProperties}>
                <article className={`current-card ${computed.status}`}>
                  <div className="current-card-copy">
                    <span className={`status-dot ${computed.status}`} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {formatItemStatusText(item, computed)}
                        {remainingQty && <span> · {remainingQty}</span>}
                      </small>
                    </span>
                  </div>
                  <button className={`task-snooze-link ${snoozeHour ? "is-snoozed" : ""}`} onClick={() => handleSnoozeWithFeedback(item)}>{snoozeHour ? `已推迟到 ${snoozeHour} 点` : "稍后提醒"}</button>
                  <TaskActions item={item} onRestock={onRestock} isExpanded={recentRestock?.itemId === item.id} onUndo={recentRestock?.itemId === item.id ? onUndoRestock : undefined} />
                </article>
                {recentRestock && item.id === recentRestock.itemId && restockItem && (
                  <RestockReceiptInline
                    recentRestock={recentRestock}
                    item={restockItem.item}
                    computed={restockItem.computed}
                    onUpdate={onUpdateRestock}
                    onSave={onSaveRestock}
                    onApplySuggestion={onApplySuggestion}
                    onDismissSuggestion={onDismissSuggestion}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {hasNoItemsAtAll ? (
        <div className="all-good-msg">
          <img src={catIcon} alt="家庭管家" className="all-good-cat" />
          <strong style={{ fontSize: 18, color: "var(--ink)" }}>先添加一个你家经常忘记补货的东西</strong>
          <span style={{ color: "var(--faint)" }}>例如：纸巾、洗衣液、牙膏、猫粮</span>
          <button className="primary-button green" style={{ marginTop: 12 }} onClick={onAddItem}>添加消耗品</button>
        </div>
      ) : !hasAny && (
        <div className="all-good-msg">
          <img src={catIcon} alt="家庭管家" className="all-good-cat" />
          <span>家里的消耗品都很充足，继续保持！</span>
        </div>
      )}
    </section>
  )
}

function RestockReceiptInline({ recentRestock, item, computed, onUpdate, onSave, onApplySuggestion, onDismissSuggestion }: {
  recentRestock: RecentRestock
  item: ReplenishmentItem
  computed: ItemComputed
  onUpdate: (patch: Partial<RecentRestock>) => void
  onSave: () => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
}) {
  const priceAnchor = calculatePriceAnchor(item.history)
  const unit = item.unit || "件"

  // 计算当前单价和比价提示
  const currentPrice = recentRestock.amount ? Number(recentRestock.amount) : 0
  const currentQty = recentRestock.qty ? Number(recentRestock.qty) : 0
  const currentUnitPrice = currentPrice > 0 && currentQty > 0 ? currentPrice / currentQty : null

  let priceHint: { text: string; tone: "good" | "bad" | "neutral" } | null = null
  if (currentUnitPrice && priceAnchor.avgUnitPrice) {
    const diff = currentUnitPrice - priceAnchor.avgUnitPrice
    const percent = Math.abs(diff / priceAnchor.avgUnitPrice)
    if (percent >= 0.1) {
      if (diff < 0) {
        priceHint = { text: `比均价便宜 ¥${formatPrice(Math.abs(diff))}/${unit}`, tone: "good" }
      } else {
        priceHint = { text: `比均价贵了 ¥${formatPrice(diff)}/${unit}`, tone: "bad" }
      }
    }
  }

  return (
    <div className="restock-inline" role="status">
      <div className="restock-inline-fields">
        <div className="restock-inline-field">
          <span>本次花费</span>
          <div className="input-prefix receipt-amount">
            <b>¥</b>
            <input aria-label="本次补货总金额" type="number" min="0" step="0.01" value={recentRestock.amount} onChange={(event) => onUpdate({ amount: event.target.value })} placeholder="选填" />
          </div>
          {currentUnitPrice && <small className="unit-price-hint">单价 ¥{formatPrice(currentUnitPrice)}/{unit}</small>}
        </div>
        <div className="restock-inline-field">
          <span>购买数量</span>
          <div className="input-suffix">
            <input aria-label="购买数量" type="number" min="1" value={recentRestock.qty} onChange={(event) => onUpdate({ qty: event.target.value })} placeholder={item.defaultQty ? String(item.defaultQty) : "选填"} />
            <b>{unit}</b>
          </div>
        </div>
        <div className="restock-inline-field">
          <span>购买平台</span>
          <select value={recentRestock.platform} onChange={(event) => onUpdate({ platform: event.target.value, customPlatform: "" })}>
            <option value="">选填</option>
            {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {recentRestock.platform === "其他" && (
            <input type="text" value={recentRestock.customPlatform} onChange={(event) => onUpdate({ customPlatform: event.target.value })} placeholder="输入平台名称" />
          )}
        </div>
      </div>
      {priceHint && <div className={`price-comparison ${priceHint.tone}`}>{priceHint.text}</div>}
      {item.suggestedCycleDays && (
        <div className="restock-inline-suggestion">
          <span>最近几次大约每 {item.suggestedCycleDays} 天补一次，要把原来的 {item.cycleDays} 天改掉吗？</span>
          <button className="primary-button compact" onClick={() => onApplySuggestion(item)}>调整</button>
          <button className="text-button" onClick={() => onDismissSuggestion(item)}>暂不</button>
        </div>
      )}
      <div className="restock-inline-actions">
        <button className="primary-button compact" onClick={onSave}>确认</button>
      </div>
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
  const [confirmDelete, setConfirmDelete] = useState(false)
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
      ? { tone: "urgent" as const, label: `${urgent} 项需要补货` }
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
    setConfirmDelete(false)
    setNameValue(category)
  }

  function handleSaveName() {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== category) onRename(trimmed)
    setEditingName(false)
    setPopoverOpen(false)
  }

  function handleDelete() {
    if (hasItems) {
      setConfirmDelete(true)
    } else {
      onDelete()
      setPopoverOpen(false)
    }
  }

  function confirmDeleteAction() {
    onDelete()
    setPopoverOpen(false)
    setConfirmDelete(false)
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
          {confirmDelete ? (
            <div className="category-card-confirm">
              <p>该分类下还有消耗品，确认删除？</p>
              <div className="category-card-confirm-actions">
                <button className="quiet-button" onClick={() => { setConfirmDelete(false); setPopoverOpen(false) }}>取消</button>
                <button className="danger-button" onClick={confirmDeleteAction}>确认删除</button>
              </div>
            </div>
          ) : editingName ? (
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
  const [editingField, setEditingField] = useState<{ id: string; field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "unit" | "platform" } | null>(null)
  const [editValue, setEditValue] = useState("")
  const [unitCustomId, setUnitCustomId] = useState<string | null>(null)
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
      setUnitCustomId(null)
    } else {
      setExpandedId(item.id)
      setEditingField(null)
      setUnitCustomId(null)
    }
  }

  function startEditing(itemId: string, field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "unit" | "platform", currentValue: number | string) {
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
    <div className={`overlay ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
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
                      <span className="detail-link-label">计量单位</span>
                      {(() => {
                        const currentUnit = item.unit || "件"
                        const showCustom = unitCustomId === item.id || !units.includes(currentUnit as typeof units[number])
                        if (editingField?.id === item.id && editingField.field === "unit") {
                          return showCustom ? (
                            <div className="inline-edit inline-edit-wide">
                              <input autoFocus type="text" value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => { onQuickEdit(item, { unit: editValue.trim() || undefined }); setEditingField(null); setUnitCustomId(null) }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onQuickEdit(item, { unit: editValue.trim() || undefined }); setEditingField(null); setUnitCustomId(null) } if (e.key === "Escape") { setEditingField(null); setUnitCustomId(null) } }} placeholder="输入单位" />
                            </div>
                          ) : (
                            <div className="inline-edit inline-edit-wide">
                              <select autoFocus value={editValue} onChange={(e) => { if (e.target.value === "其他") { setUnitCustomId(item.id); setEditValue("") } else { onQuickEdit(item, { unit: e.target.value }); setEditingField(null) } }} onBlur={() => { if (unitCustomId !== item.id) setEditingField(null) }}>
                                {units.map((u) => <option key={u} value={u}>{u}</option>)}
                              </select>
                            </div>
                          )
                        }
                        return (
                          <button className="detail-link-value" onClick={() => { setEditingField({ id: item.id, field: "unit" }); setEditValue(showCustom ? currentUnit : currentUnit); setUnitCustomId(showCustom ? item.id : null) }}>
                            <span className="detail-link-text">{currentUnit}</span>
                            <Icon name="edit" size={13} />
                          </button>
                        )
                      })()}
                    </div>
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
                        const unit = item.unit || "件"
                        return (
                          <div key={event.id} className="history-row">
                            <span>{formatDate(event.at)}</span>
                            <small>
                              {event.intervalDays ? `相隔 ${event.intervalDays} 天` : "首次记录"}
                              {event.price !== undefined && ` · ¥${formatPrice(event.price)}`}
                              {event.qty && `（${event.qty}${unit}`}
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

function CategoryManagerDialog({ mode, category, categories, itemCount, onClose, onRename, onDelete, isClosing }: {
  mode: "rename" | "delete"
  category: string
  categories: string[]
  itemCount: number
  onClose: () => void
  onRename: (name: string) => void
  onDelete: (moveTo?: string) => void
  isClosing?: boolean
}) {
  const [name, setName] = useState(category)
  const moveTargets = categories.filter((name) => name !== category)
  const [moveTo, setMoveTo] = useState(moveTargets[0] || "")
  const [deleteItemsConfirmed, setDeleteItemsConfirmed] = useState(false)
  const normalized = name.trim()
  const duplicated = normalized !== category && categories.includes(normalized)

  function submitRename(event: FormEvent) {
    event.preventDefault()
    if (!normalized || normalized === category || duplicated) return
    onRename(normalized)
  }

  return (
    <div className={`overlay category-manager-overlay ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`category-manager-dialog ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="category-manager-title">
        <div className="category-creator-header"><h2 id="category-manager-title">{mode === "rename" ? "修改分类名称" : `删除"${category}"`}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        {mode === "rename" ? (
          <form onSubmit={submitRename}>
            <label className="field"><span>分类名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
            {duplicated && <p className="category-creator-tip error">这个分类已经有了</p>}
            <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!normalized || normalized === category || duplicated}>保存</button></div>
          </form>
        ) : itemCount === 0 ? (
          <div className="category-creator-actions"><button className="quiet-button" onClick={onClose}>取消</button><button className="danger-button" onClick={() => onDelete()}>删除分类</button></div>
        ) : (
          <div className="category-delete-options">
            <div className="category-move-box">
              <strong>移动 {itemCount} 项后删除</strong>
              {moveTargets.length > 0 ? <div className="category-move-controls"><select aria-label="移到其他分类" value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>{moveTargets.map((target) => <option key={target} value={target}>{target}</option>)}</select><button className="primary-button" onClick={() => onDelete(moveTo)}>移过去并删除</button></div> : <p className="category-creator-tip">还没有其他分类，暂时不能迁移。</p>}
            </div>
            <div className="category-delete-box">
              <strong>同时删除里面的内容</strong>
              <p>这会永久删除该分类及其中的 {itemCount} 项。</p>
              <label><input type="checkbox" checked={deleteItemsConfirmed} onChange={(event) => setDeleteItemsConfirmed(event.target.checked)} />我确认同时删除这些内容</label>
              <button className="danger-button" disabled={!deleteItemsConfirmed} onClick={() => onDelete()}>全部删除</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ItemDetailPanel({ item, computed, onClose, onEdit, onSnooze, onRestock, onCalibrate, onApplySuggestion, onDismissSuggestion, onRateEvent, isClosing }: {
  item: ReplenishmentItem
  computed: ItemComputed
  onClose: () => void
  onEdit: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onCalibrate: (item: ReplenishmentItem, remainingDays: number) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onRateEvent: (itemId: string, eventId: string, rating?: Rating, review?: string) => void
  isClosing?: boolean
}) {
  const [calibrating, setCalibrating] = useState(false)
  const [remainingDays, setRemainingDays] = useState(String(Math.max(0, computed.daysUntilDepletion)))
  const [ratingEventId, setRatingEventId] = useState<string | null>(null)
  const [ratingDraft, setRatingDraft] = useState<{ review: string }>({ review: "" })

  const priceAnchor = calculatePriceAnchor(item.history)
  const consumption = calculateConsumption(item)
  const remainingQty = estimateRemainingQty(item)
  const unit = item.unit || "件"
  const latestRating = getLatestRating(item)

  function submitCalibration(event: FormEvent) {
    event.preventDefault()
    if (remainingDays === "") return
    onCalibrate(item, Number(remainingDays))
    setCalibrating(false)
  }

  function submitRating(eventId: string) {
    if (!ratingDraft.review.trim()) return
    onRateEvent(item.id, eventId, undefined, ratingDraft.review)
    setRatingEventId(null)
    setRatingDraft({ review: "" })
  }

  return (
    <div className={`overlay detail-overlay ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className={`panel detail-panel ${isClosing ? "is-closing" : ""}`}>
        <div className="panel-header">
          <div className="panel-header-info">
            <span className="panel-header-eyebrow">{item.category}</span>
            <h2>{item.name}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </div>

        {/* 状态概览卡片 */}
        <div className="detail-hero">
          <div className="detail-hero-status">
            <span className={`status-dot large ${computed.displayStatus}`} />
            <div className="detail-hero-text">
              <span className="detail-hero-label">{computed.statusLabel}</span>
              <strong className="detail-hero-value">{computed.remainingText}</strong>
            </div>
          </div>
          {latestRating === 1 && <p className="rating-warning-text">上次购买评价较差，考虑更换品牌</p>}
          {computed.status !== "normal" && (
            <div className="detail-hero-actions">
              <TaskActions item={item} onRestock={onRestock} />
            </div>
          )}
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

        {/* 校准入口 */}
        <div className="detail-calibrate">
          {calibrating ? (
            <form className="calibrate-form" onSubmit={submitCalibration}>
              <label className="calibrate-field">
                <span>其实还能用</span>
                <div className="input-suffix">
                  <input autoFocus aria-label="实际还能使用天数" type="number" min="0" max={item.cycleDays} value={remainingDays} onChange={(event) => setRemainingDays(event.target.value)} />
                  <b>天</b>
                </div>
              </label>
              <div className="calibrate-actions">
                <button type="button" className="quiet-button compact" onClick={() => setCalibrating(false)}>取消</button>
                <button type="submit" className="primary-button compact" disabled={remainingDays === ""}>校准</button>
              </div>
            </form>
          ) : (
            <button className="calibrate-link" onClick={() => setCalibrating(true)}>
              <Icon name="clock" size={16} />
              <span>实际剩余天数不准？校准一下</span>
            </button>
          )}
        </div>

        {/* 价格参考 */}
        {priceAnchor.priceCount >= 1 && (
          <div className="detail-section">
            <h3 className="detail-section-title">价格参考</h3>
            <div className="price-anchor-grid">
              {priceAnchor.lowestUnitPrice && <div className="price-anchor-item"><span>最低</span><strong>{formatUnitPrice(priceAnchor.lowestUnitPrice, unit)}</strong></div>}
              {priceAnchor.avgUnitPrice && <div className="price-anchor-item"><span>平均</span><strong>{formatUnitPrice(priceAnchor.avgUnitPrice, unit)}</strong></div>}
              {priceAnchor.latestUnitPrice && <div className="price-anchor-item"><span>最近</span><strong>{formatUnitPrice(priceAnchor.latestUnitPrice, unit)}</strong></div>}
            </div>
          </div>
        )}

        {/* 补货间隔建议 */}
        {item.suggestedCycleDays && (
          <div className="detail-suggestion">
            <span>最近几次大约每 {item.suggestedCycleDays} 天补一次，要把原来的 {item.cycleDays} 天改掉吗？</span>
            <div className="detail-suggestion-actions">
              <button className="primary-button compact" onClick={() => onApplySuggestion(item)}>调整</button>
              <button className="text-button" onClick={() => onDismissSuggestion(item)}>暂不</button>
            </div>
          </div>
        )}

        {/* 补货历史 */}
        {item.history.length > 0 && (
          <div className="detail-section">
            <h3 className="detail-section-title">最近补货</h3>
            <div className="history-list">
              {item.history.slice(-4).reverse().map((event) => (
                <div key={event.id} className="history-item">
                  <div className="history-item-main">
                    <span className="history-item-date">{formatDate(event.at)}</span>
                    <span className="history-item-meta">
                      {event.intervalDays ? `${event.intervalDays} 天` : "首次"}
                      {event.price !== undefined && ` · ¥${formatPrice(event.price)}`}
                      {event.qty && ` · ${event.qty}${unit}`}
                    </span>
                  </div>
                  <div className="history-item-tags">
                    {event.platform && <span className="platform-tag">{event.platform}</span>}
                    {event.rating && <span className={`rating-tag rating-${event.rating}`}>{event.rating === 3 ? "👍" : event.rating === 2 ? "😐" : "👎"}</span>}
                    {!event.rating && (
                      <button className="rate-button" onClick={() => setRatingEventId(event.id)}>评价</button>
                    )}
                  </div>
                  {ratingEventId === event.id && (
                    <div className="rating-form">
                      <span>这次买的怎么样？</span>
                      <textarea className="review-textarea" value={ratingDraft.review} onChange={(e) => setRatingDraft({ review: e.target.value })} placeholder="请输入您的评价..." rows={4} />
                      <div className="rating-form-actions">
                        <button className="quiet-button compact" onClick={() => setRatingEventId(null)}>取消</button>
                        <button className="primary-button compact" onClick={() => submitRating(event.id)} disabled={!ratingDraft.review.trim()}>保存</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部操作 */}
        <div className="detail-footer">
          <button className="quiet-button" onClick={() => onEdit(item)}><Icon name="edit" />修改补货设置</button>
        </div>
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
  const [unitCustom, setUnitCustom] = useState(false)
  const cycleManuallyChanged = useRef(false)
  const [draft, setDraft] = useState<ItemDraft>(() => {
    const base: ItemDraft = item ? {
      name: item.name,
      category: item.category,
      cycleDays: item.cycleDays,
      bufferDays: item.bufferDays,
      link: item.link || "",
      remainingDays: "",
      learningEnabled: item.learningEnabled !== false,
      unit: item.unit || "件",
      defaultQty: item.defaultQty ? String(item.defaultQty) : "",
      platform: item.platform || ""
    } : { ...EMPTY_DRAFT, category: initialCategory || EMPTY_DRAFT.category }
    if (item && item.unit && !units.includes(item.unit as typeof units[number])) {
      setUnitCustom(true)
    }
    return base
  })

  const showUnitCustom = unitCustom || (!!item?.unit && !units.includes(item.unit as typeof units[number]))

  function set<K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function handleName(value: string) {
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
    if (!draft.name.trim() || !draft.category.trim()) return
    onSave(draft)
  }

  return (
    <div className={`overlay editor-overlay ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
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
            <label className="field field-wide"><span>消耗品名称</span><input autoFocus={Boolean(item)} value={draft.name} onChange={(event) => handleName(event.target.value)} placeholder="例如：卫生纸" /></label>
            <div className="field-row">
              <label className="field">
                <span>计量单位</span>
                <select value={showUnitCustom ? "其他" : draft.unit} onChange={(event) => {
                  if (event.target.value === "其他") {
                    setUnitCustom(true)
                    set("unit", "")
                  } else {
                    setUnitCustom(false)
                    set("unit", event.target.value)
                  }
                }}>
                  {units.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              {showUnitCustom && (
                <label className="field">
                  <span>自定义单位</span>
                  <input value={draft.unit} onChange={(event) => set("unit", event.target.value)} placeholder="输入单位" />
                </label>
              )}
              <label className="field">
                <span>默认购买量 <em>选填</em></span>
                <div className="input-suffix"><input type="number" min="1" value={draft.defaultQty} onChange={(event) => set("defaultQty", event.target.value)} placeholder="选填" /><b>{draft.unit || "件"}</b></div>
              </label>
            </div>
          </div>

          {/* 补货设置 */}
          <div className="editor-section">
            <h3 className="editor-section-title">补货设置</h3>
            <div className="field-row">
              <label className="field">
                <span>大约多久补一次</span>
                <div className="input-suffix"><input type="number" min="1" value={draft.cycleDays} onChange={(event) => handleCycle(Number(event.target.value))} /><b>天</b></div>
              </label>
              <label className="field">
                <span>提前几天提醒</span>
                <div className="input-suffix"><input type="number" min="0" max={Math.max(0, draft.cycleDays - 1)} value={Math.min(draft.bufferDays, Math.max(0, draft.cycleDays - 1))} onChange={(event) => set("bufferDays", Number(event.target.value))} /><b>天</b></div>
              </label>
            </div>
            {!item && <label className="field field-wide"><span>手头这些大概还能用多久 <em>选填</em></span><div className="input-suffix"><input type="number" min="0" value={draft.remainingDays} onChange={(event) => set("remainingDays", event.target.value)} placeholder="不确定就留空" /><b>天</b></div></label>}
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
                {item.history.slice(-3).reverse().map((event) => (
                  <div key={event.id} className="editor-history-item">
                    <b>{formatDate(event.at)}</b>
                    <span>{event.intervalDays ? `间隔 ${event.intervalDays} 天` : "首轮记录"}{event.price !== undefined ? ` · 共 ¥${event.price.toFixed(2)}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 底部操作 */}
          <div className="panel-footer">
            {item && onDelete ? <button type="button" className="danger-link" onClick={() => onDelete(item)}>删除消耗品</button> : <span />}
            <div className="panel-footer-actions">
              <button type="button" className="quiet-button" onClick={onClose}>取消</button>
              <button type="submit" className="primary-button">保存</button>
            </div>
          </div>
        </form>
      </aside>
    </div>
  )
}

function SettingsPanel({ state, onChange, onClose, isClosing }: { state: AppState; onChange: (state: AppState) => void; onClose: () => void; isClosing?: boolean }) {
  const settings = state.settings
  function patch(values: Partial<typeof settings>) {
    onChange({ ...state, settings: { ...settings, ...values } })
  }
  return (
    <div className={`overlay settings-overlay ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`settings-dialog ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-dialog-header"><h2 id="settings-title">提醒与预算</h2><button className="icon-button close-btn" aria-label="关闭" onClick={onClose}><Icon name="close" size={16} /></button></div>
        <div className="settings-body">
          <div className="settings-row"><span className="settings-row-label">每月生活预算</span><div className="settings-row-control"><input aria-label="每月生活预算" type="number" min="0" step="100" value={settings.monthlyBudget ?? ""} onChange={(event) => patch({ monthlyBudget: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)) })} placeholder="未设置" /></div></div>
          <div className="settings-row"><span className="settings-row-label">重复提醒间隔</span><div className="settings-row-control"><div className="segment-control"><button className={settings.reminderIntervalMinutes === 30 ? "active" : ""} onClick={() => patch({ reminderIntervalMinutes: 30 })}>30 分钟</button><button className={settings.reminderIntervalMinutes === 60 ? "active" : ""} onClick={() => patch({ reminderIntervalMinutes: 60 })}>60 分钟</button></div></div></div>
          <div className="settings-row"><span className="settings-row-label">勿扰时段</span><div className="settings-row-control"><div className="time-range"><input type="time" value={settings.quietStart} onChange={(event) => patch({ quietStart: event.target.value })} /><span>至</span><input type="time" value={settings.quietEnd} onChange={(event) => patch({ quietEnd: event.target.value })} /></div></div></div>
          <div className="settings-row"><span className="settings-row-label">明天几点提醒</span><div className="settings-row-control"><div className="input-suffix short"><input type="number" min="0" max="23" value={settings.snoozeUntilHour} onChange={(event) => patch({ snoozeUntilHour: Number(event.target.value) })} /><b>点</b></div></div></div>
          <div className="settings-row"><span className="settings-row-label">系统通知</span><div className="settings-row-control"><button className="quiet-button" onClick={() => window.desktop?.testNotification()}>发送测试</button></div></div>
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
  onConfirm: (itemId: string, option: PurchaseOption | null, qty: number, price: number) => void
}

function RestockModal({ isOpen, onClose, item, onConfirm }: RestockModalProps) {
  const [selectedOption, setSelectedOption] = useState<PurchaseOption | null>(null)
  const [qty, setQty] = useState<number | ''>('')
  const [price, setPrice] = useState<number | ''>('')

  // 选中采购选项时自动填充默认数量与价格；取消选择时保留用户已输入的内容
  useEffect(() => {
    if (selectedOption) {
      setQty(1)
      setPrice(selectedOption.price || '')
    }
  }, [selectedOption])

  // 每次打开弹窗或切换物品时重置内部状态，避免显示上一次补货的残留值
  useEffect(() => {
    if (isOpen && item) {
      setSelectedOption(null)
      setQty('')
      setPrice('')
    }
  }, [isOpen, item?.id])

  if (!isOpen || !item) return null

  const purchaseOptions = item.purchaseOptions || []
  const unitText = selectedOption?.unit || item.unit || '件'
  const canConfirm = !!qty && Number(qty) >= 1

  return (
    <div className="restock-modal-overlay" onClick={onClose}>
      <div className="restock-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>补货 - {item.name}</h3>
          <button className="icon-button modal-close-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* 采购选项列表 */}
          {purchaseOptions.length > 0 ? (
            <div className="purchase-option-list">
              {purchaseOptions.map((option) => {
                // 从补货记录中匹配该平台最近的有评价内容
                const latestReview = (item.history || [])
                  .find(e => e.platform === option.platform && e.review)

                return (
                  <button
                    key={option.id}
                    className={`purchase-option-item ${selectedOption?.id === option.id ? 'is-selected' : ''}`}
                    onClick={() => setSelectedOption(option)}
                  >
                    <div className="option-info">
                      <span className="option-name-platform">{option.productName} · {option.platform}</span>
                      {latestReview && <span className="option-review-text">{latestReview.review}</span>}
                    </div>
                    <div className="option-price">
                      ¥{option.price ? formatPrice(option.price) : '0.00'}/{option.unit || '件'}
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="empty-hint">暂无采购选项，可直接填写下方数量与价格完成补货</p>
          )}

          {/* 数量和价格输入：无论是否选择采购选项都可填写，保证无选项时也能补货 */}
          <div className="restock-inputs">
            <div className="input-row">
              <label>采购数量：</label>
              <input
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="例如：2"
              />
              <span className="unit-text">{unitText}</span>
            </div>

            <div className="input-row">
              <label>采购价格：</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="例如：50"
              />
              <span className="unit-text">元</span>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (canConfirm) {
                onConfirm(item.id, selectedOption, Number(qty), Number(price) || 0)
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

function ItemEditorDialog({
  item,
  categories,
  isOpen,
  onClose,
  onRename,
  onMove,
  onDelete
}: {
  item: ReplenishmentItem | null
  categories: string[]
  isOpen: boolean
  onClose: () => void
  onRename: (id: string, newName: string) => void
  onMove: (id: string, newCategory: string) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState(item?.name ?? "")
  const [category, setCategory] = useState(item?.category ?? "")

  // 组件始终挂载，需在早退判断之前调用 hooks；切换物品或重新打开时同步表单状态
  useEffect(() => {
    if (isOpen && item) {
      setName(item.name)
      setCategory(item.category)
    }
  }, [isOpen, item?.id])

  if (!isOpen || !item) return null

  const handleSave = () => {
    if (name !== item.name) {
      onRename(item.id, name)
    }
    if (category !== item.category) {
      onMove(item.id, category)
    }
    onClose()
  }
  
  const handleDelete = () => {
    if (window.confirm(`确定要删除"${item.name}"吗？`)) {
      onDelete(item.id)
      onClose()
    }
  }
  
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-container item-editor-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>编辑物品</h2>
          <button className="icon-button close-btn" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        
        <div className="dialog-form">
          <div className="form-group">
            <label>名称</label>
            <input 
              type="text" 
              value={name} 
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          
          <div className="form-group">
            <label>分类</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          
          <div className="dialog-actions">
            <button className="quiet-button danger" onClick={handleDelete}>删除</button>
            <div style={{ flex: 1 }} />
            <button className="quiet-button" onClick={onClose}>取消</button>
            <button className="primary-button" onClick={handleSave}>保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ItemCreatorDialog({
  category,
  isOpen, 
  onClose, 
  onCreate 
}: {
  category: string
  isOpen: boolean
  onClose: () => void
  onCreate: (item: { name: string; initialStock?: number; unit?: string; price?: number; platform?: string; usageIntervalDays?: number; bufferDays?: number }) => void
}) {
  const [name, setName] = useState('')
  const [initialStock, setInitialStock] = useState(1)
  const [unit, setUnit] = useState('个')
  const [price, setPrice] = useState<number | ''>('')
  const [platform, setPlatform] = useState('')
  const [usageIntervalDays, setUsageIntervalDays] = useState<number | ''>(30)
  const [bufferDays, setBufferDays] = useState<number | ''>('')
  
  if (!isOpen) return null
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onCreate({ 
      name, 
      initialStock, 
      unit, 
      price: price === '' ? undefined : price,
      platform: platform || undefined,
      usageIntervalDays: usageIntervalDays === '' ? undefined : usageIntervalDays,
      bufferDays: bufferDays === '' ? undefined : bufferDays
    })
    onClose()
  }
  
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-container item-creator-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>添加消耗品</h2>
          <button className="icon-button close-btn" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="dialog-form">
          <div className="form-group">
            <label>名称</label>
            <input 
              type="text" 
              value={name} 
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：猫砂、洗衣液"
              autoFocus
            />
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>初始数量</label>
              <input 
                type="number" 
                min="1"
                value={initialStock} 
                onChange={(e) => setInitialStock(Number(e.target.value))}
              />
            </div>
            
            <div className="form-group">
              <label>单位</label>
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="个">个</option>
                <option value="瓶">瓶</option>
                <option value="袋">袋</option>
                <option value="盒">盒</option>
                <option value="包">包</option>
                <option value="桶">桶</option>
              </select>
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>价格（可选）</label>
              <input 
                type="number" 
                min="0"
                step="0.01"
                value={price} 
                onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="例如：29.9"
              />
            </div>
            
            <div className="form-group">
              <label>购买平台（可选）</label>
              <input 
                type="text" 
                value={platform} 
                onChange={(e) => setPlatform(e.target.value)}
                placeholder="例如：淘宝、京东"
              />
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>消耗周期（天）</label>
              <div className="input-with-unit">
                <input 
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
              <label>提前提醒（天）</label>
              <div className="input-with-unit">
                <input 
                  type="number" 
                  min="0"
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
  )
}

interface EditPurchaseOptionModalProps {
  isOpen: boolean
  onClose: () => void
  option: PurchaseOption | null
  onSave: (editedOption: PurchaseOption) => void
}

interface AddPurchaseOptionModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (option: Omit<PurchaseOption, 'id'>) => void
}

function AddPurchaseOptionModal({ isOpen, onClose, onSave }: AddPurchaseOptionModalProps) {
  const [productName, setProductName] = useState('')
  const [platform, setPlatform] = useState('')
  const [unit, setUnit] = useState('')
  const [unitCustom, setUnitCustom] = useState('')
  const [price, setPrice] = useState<number | ''>('')
  
  const showUnitCustom = unit === '其他'

  const handleSubmit = () => {
    const finalUnit = showUnitCustom ? unitCustom : unit
    if (!productName || !platform || !finalUnit) return
    
    onSave({
      productName,
      platform,
      unit: finalUnit,
      price: price !== '' ? Number(price) : undefined,
      isDefault: false
    })
    
    // 重置表单
    setProductName('')
    setPlatform('')
    setUnit('')
    setUnitCustom('')
    setPrice('')
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
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>添加采购选项</h3>
          <button className="icon-button modal-close-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label>商品名称：</label>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="例如：维达超韧卫生纸"
                autoFocus
              />
            </div>
            
            <div className="form-group">
              <label>购买平台：</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                onKeyDown={handleKeyDown}
              >
                <option value="">选择平台</option>
                {platforms.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>计量单位：</label>
              <select
                value={showUnitCustom ? '其他' : unit}
                onChange={(e) => {
                  setUnit(e.target.value)
                  if (e.target.value !== '其他') setUnitCustom('')
                }}
                onKeyDown={handleKeyDown}
              >
                <option value="">选择单位</option>
                {units.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
              {showUnitCustom && (
                <input
                  type="text"
                  value={unitCustom}
                  onChange={(e) => setUnitCustom(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入自定义单位"
                  style={{ marginTop: '8px' }}
                />
              )}
            </div>
            
            <div className="form-group">
              <label>采购价格：</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                onKeyDown={handleKeyDown}
                placeholder="例如：59.9"
              />
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button 
            className="btn btn-primary" 
            onClick={handleSubmit}
            disabled={!productName || !platform || !(showUnitCustom ? unitCustom : unit)}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}

function EditPurchaseOptionModal({ isOpen, onClose, option, onSave }: EditPurchaseOptionModalProps) {
  const [productName, setProductName] = useState('')
  const [platform, setPlatform] = useState('')
  const [unit, setUnit] = useState('')
  const [unitCustom, setUnitCustom] = useState('')
  const [price, setPrice] = useState<number | ''>('')
  const [link, setLink] = useState('')
  
  const showUnitCustom = unit === '其他' || (!!option?.unit && !units.includes(option.unit as typeof units[number]))

  useEffect(() => {
    if (option) {
      setProductName(option.productName)
      setPlatform(option.platform)
      const isKnownUnit = units.includes(option.unit as typeof units[number])
      if (isKnownUnit) {
        setUnit(option.unit)
        setUnitCustom('')
      } else {
        setUnit('其他')
        setUnitCustom(option.unit)
      }
      setPrice(option.price || '')
      setLink(option.link || '')
    }
  }, [option])
  
  if (!isOpen || !option) return null
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>编辑采购选项</h3>
          <button className="icon-button modal-close-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        
        <div className="modal-body">
          <div className="form-group">
            <label>商品名称：</label>
            <input
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="例如：维达超韧卫生纸"
            />
          </div>
          
          <div className="form-group">
            <label>购买平台：</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">选择平台</option>
              {platforms.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>计量单位：</label>
              <select
                value={showUnitCustom ? '其他' : unit}
                onChange={(e) => {
                  setUnit(e.target.value)
                  if (e.target.value !== '其他') setUnitCustom('')
                }}
              >
                <option value="">选择单位</option>
                {units.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
              {showUnitCustom && (
                <input
                  type="text"
                  value={unitCustom}
                  onChange={(e) => setUnitCustom(e.target.value)}
                  placeholder="输入自定义单位"
                  style={{ marginTop: '8px' }}
                />
              )}
            </div>
            
            <div className="form-group">
              <label>采购价格：</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="例如：59.9"
              />
            </div>
          </div>
          
          <div className="form-group">
            <label>商品链接（可选）：</label>
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://..."
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button 
            className="btn btn-primary" 
            onClick={() => {
              const finalUnit = showUnitCustom ? unitCustom : unit
              onSave({
                ...option,
                productName,
                platform,
                unit: finalUnit,
                price: Number(price) || undefined,
                link: link || undefined
              })
            }}
          >
            保存
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
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

function CategoryWorkArea({ category, views, onAddItem, onRename, onDelete, onEdit, onSnooze, onRestock, onQuickEdit, onApplySuggestion, onDismissSuggestion, onRateEvent, onOpenItemEditor, onRestockFromOption, showAddPurchaseModal, setShowAddPurchaseModal, addPurchaseOptionItemId, setAddPurchaseOptionItemId, onAddPurchaseOption, editingPurchaseOption, setEditingPurchaseOption, editModalOpen, setEditModalOpen, onEditPurchaseOption, onDeletePurchaseOption, onSaveEditedOption }: {
  category: string
  views: ItemView[]
  onAddItem: () => void
  onRename: () => void
  onDelete: () => void
  onEdit: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onQuickEdit: (item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform" | "purchaseOptions">>) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onRateEvent: (itemId: string, eventId: string, rating?: Rating, review?: string) => void
  onOpenItemEditor: (itemId: string) => void
  onRestockFromOption: (itemId: string, option: PurchaseOption) => void
  showAddPurchaseModal: boolean
  setShowAddPurchaseModal: React.Dispatch<React.SetStateAction<boolean>>
  addPurchaseOptionItemId: string | null
  setAddPurchaseOptionItemId: React.Dispatch<React.SetStateAction<string | null>>
  onAddPurchaseOption: (itemId: string, optionData: Omit<PurchaseOption, 'id'>) => void
  editingPurchaseOption: PurchaseOption | null
  setEditingPurchaseOption: React.Dispatch<React.SetStateAction<PurchaseOption | null>>
  editModalOpen: boolean
  setEditModalOpen: React.Dispatch<React.SetStateAction<boolean>>
  onEditPurchaseOption: (option: PurchaseOption) => void
  onDeletePurchaseOption: (itemId: string, optionId: string) => void
  onSaveEditedOption: (editedOption: PurchaseOption) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<{ id: string; field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "unit" | "platform" } | null>(null)
  const [editValue, setEditValue] = useState("")
  const [unitCustomId, setUnitCustomId] = useState<string | null>(null)
  const [ratingEventId, setRatingEventId] = useState<string | null>(null)
  const [ratingItemId, setRatingItemId] = useState<string | null>(null)
  const [ratingDraft, setRatingDraft] = useState<{ review: string }>({ review: "" })
  const [savedFieldKey, setSavedFieldKey] = useState<string | null>(null)
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)
  const [editingUsageInterval, setEditingUsageInterval] = useState(false)
  const [editingReminderDays, setEditingReminderDays] = useState(false)
  const [tempUsageInterval, setTempUsageInterval] = useState<string | number>('')
  const [tempReminderDays, setTempReminderDays] = useState<string | number>('')
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null)
  const [tempReview, setTempReview] = useState('')
  const [showActionMenu, setShowActionMenu] = useState<string | null>(null) // 操作菜单显示状态
  const [historyExpanded, setHistoryExpanded] = useState<Set<string>>(new Set())
  
  // 评价弹窗状态
  const [reviewModalOpen, setReviewModalOpen] = useState(false)
  const [selectedRecord, setSelectedRecord] = useState<RestockEvent | null>(null)
  const [editingReviewText, setEditingReviewText] = useState('')
  const [currentItemName, setCurrentItemName] = useState('')
  const [currentItemId, setCurrentItemId] = useState<string | null>(null)

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
      setUnitCustomId(null)
    } else {
      setExpandedId(item.id)
      setEditingField(null)
      setUnitCustomId(null)
    }
  }

  function startEditing(itemId: string, field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "unit" | "platform", currentValue: number | string) {
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

  // 开始编辑补货间隔
  function handleStartEditUsageInterval(item: ReplenishmentItem) {
    setTempUsageInterval(item.cycleDays || '')
    setEditingUsageInterval(true)
  }

  // 保存补货间隔（清空或非法值时回退到当前值，避免写入 undefined 导致 computeItem 产生 NaN）
  function handleSaveUsageInterval(item: ReplenishmentItem) {
    const parsed = Number(tempUsageInterval)
    const newValue = Number.isFinite(parsed) && parsed > 0
      ? Math.max(1, Math.round(parsed))
      : item.cycleDays
    onQuickEdit(item, { cycleDays: newValue })
    setEditingUsageInterval(false)
  }

  // 开始编辑提前提醒
  function handleStartEditReminderDays(item: ReplenishmentItem) {
    setTempReminderDays(item.bufferDays || '')
    setEditingReminderDays(true)
  }

  // 保存提前提醒（清空或非法值时回退到当前值，避免写入 undefined 导致 computeItem 产生 NaN）
  function handleSaveReminderDays(item: ReplenishmentItem) {
    const parsed = Number(tempReminderDays)
    const newValue = Number.isFinite(parsed) && parsed >= 0
      ? Math.min(Math.max(0, item.cycleDays - 1), Math.round(parsed))
      : item.bufferDays
    onQuickEdit(item, { bufferDays: newValue })
    setEditingReminderDays(false)
  }

  // 取消编辑
  function handleCancelEdit() {
    setEditingUsageInterval(false)
    setEditingReminderDays(false)
    setTempUsageInterval('')
    setTempReminderDays('')
  }

  // 开始编辑评价
  function handleStartEditReview(recordId: string, currentReview: string | undefined) {
    setTempReview(currentReview || '')
    setEditingReviewId(recordId)
  }

  // 保存评价
  function handleSaveReview(itemId: string, recordId: string) {
    const newReview = tempReview.trim() === '' ? undefined : tempReview
    // 更新补货记录的评价
    onRateEvent(itemId, recordId, undefined, newReview)
    setEditingReviewId(null)
    setTempReview('')
  }

  // 取消编辑评价
  function handleCancelEditReview() {
    setEditingReviewId(null)
    setTempReview('')
  }

  // 打开评价弹窗
  function handleOpenReviewModal(record: RestockEvent, itemName: string, itemId: string) {
    setSelectedRecord(record)
    setCurrentItemName(itemName)
    setCurrentItemId(itemId)
    setEditingReviewText(record.review || '')
    setReviewModalOpen(true)
  }

  // 关闭评价弹窗
  function handleCloseReviewModal() {
    setReviewModalOpen(false)
    setSelectedRecord(null)
    setCurrentItemName('')
    setCurrentItemId(null)
    setEditingReviewText('')
  }

  // 从弹窗保存评价
  function handleSaveReviewFromModal(review: string) {
    if (!selectedRecord || !currentItemId) return
    
    const newReview = review.trim() || undefined
    onRateEvent(currentItemId, selectedRecord.id, undefined, newReview)
    
    handleCloseReviewModal()
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
          <div 
            key={item.id} 
            className={`category-item-group ${expandedId === item.id ? "is-expanded" : ""}`}
            onMouseEnter={() => setHoveredItemId(item.id)}
            onMouseLeave={() => setHoveredItemId(null)}
          >
            <button className={`category-item ${expandedId === item.id ? "is-expanded" : ""}`} onClick={() => toggleExpand(item, computed)}>
              {/* 左侧状态圆点 */}
              <span className={`status-dot ${computed.displayStatus}`} />
              <div className="category-item-copy">
                {/* 标题行：名称和编辑按钮并排 */}
                <div className="item-title-row">
                  <strong>{item.name}</strong>
                  {hoveredItemId === item.id && (
                    <button 
                      className="icon-button item-edit-btn-inline"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenItemEditor(item.id)
                      }}
                      aria-label="编辑物品"
                    >
                      <Icon name="edit" size={14} />
                    </button>
                  )}
                </div>
                <small>
                  {formatItemStatusText(item, computed)}
                </small>
              </div>
              <span className={`status-label ${computed.displayStatus}`}>{computed.statusLabel}</span>
              <span className={`category-item-arrow ${expandedId === item.id ? "is-open" : ""}`}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></span>
            </button>
            {expandedId === item.id && (
              <div className="category-item-detail">
                {/* 区块1：消耗设置 */}
                <div className="detail-section">
                  <h4 className="section-title">消耗设置</h4>
                  <div className="settings-inline-row">
                    {/* 补货间隔 */}
                    <div className="setting-row inline-setting">
                      <span className="setting-label">间隔：</span>
                      {editingUsageInterval ? (
                        <input
                          type="number"
                          min="1"
                          value={tempUsageInterval}
                          onChange={(e) => setTempUsageInterval(e.target.value === '' ? '' : Number(e.target.value))}
                          onBlur={() => handleSaveUsageInterval(item)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleSaveUsageInterval(item)
                            } else if (e.key === 'Escape') {
                              handleCancelEdit()
                            }
                          }}
                          autoFocus
                          className="inline-input"
                        />
                      ) : (
                        <button 
                          className="editable-value"
                          onClick={() => handleStartEditUsageInterval(item)}
                        >
                          {item.cycleDays || '未设置'} 天
                          <svg 
                            className="edit-icon-svg" 
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
                      )}
                    </div>

                    {/* 提前提醒 */}
                    <div className="setting-row inline-setting">
                      <span className="setting-label">提醒：</span>
                      {editingReminderDays ? (
                        <input
                          type="number"
                          min="0"
                          value={tempReminderDays}
                          onChange={(e) => setTempReminderDays(e.target.value === '' ? '' : Number(e.target.value))}
                          onBlur={() => handleSaveReminderDays(item)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleSaveReminderDays(item)
                            } else if (e.key === 'Escape') {
                              handleCancelEdit()
                            }
                          }}
                          autoFocus
                          className="inline-input"
                        />
                      ) : (
                        <button 
                          className="editable-value"
                          onClick={() => handleStartEditReminderDays(item)}
                        >
                          {item.bufferDays || '未设置'} 天
                          <svg 
                            className="edit-icon-svg" 
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
                      )}
                    </div>
                  </div>
                </div>
                
                {/* 区块2：补货设置（采购选项） */}
                <div className="detail-section">
                  <h4 className="section-title">补货设置</h4>
                  <div className="section-content">
                    {item.purchaseOptions && item.purchaseOptions.length > 0 ? (
                      <div className="purchase-options-list">
                        {item.purchaseOptions.map(option => (
                          <div 
                            key={option.id} 
                            className="purchase-option-card"
                            onDoubleClick={() => onRestockFromOption(item.id, option)}
                            title="双击记录补货"
                          >
                            <div className="option-info">
                              <strong>{option.productName}</strong>
                              <span className="option-meta">
                                {option.platform} · {option.unit}
                                {option.price && ` · ¥${option.price}`}
                              </span>
                            </div>
                            <div className="option-actions-wrapper">
                              {/* 编辑按钮 */}
                              <button 
                                className="icon-button edit-option-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setShowActionMenu(showActionMenu === option.id ? null : option.id)
                                }}
                                title="操作"
                              >
                                <svg 
                                  className="action-icon" 
                                  width="16" 
                                  height="16" 
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
                                      if (window.confirm('确定要删除这个采购选项吗？')) {
                                        onDeletePurchaseOption(item.id, option.id)
                                      }
                                      setShowActionMenu(null)
                                    }}
                                  >
                                    删除
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                        {/* 添加新选项的按钮 */}
                        <button 
                          className="secondary-button add-option-inline-btn"
                          onClick={() => {
                            setAddPurchaseOptionItemId(item.id)
                            setShowAddPurchaseModal(true)
                          }}
                        >
                          + 添加采购选项
                        </button>
                      </div>
                    ) : (
                      <div className="empty-purchase-options">
                        <p className="empty-hint">暂无采购选项</p>
                        <button 
                          className="primary-button green add-option-btn"
                          onClick={() => {
                            setAddPurchaseOptionItemId(item.id)
                            setShowAddPurchaseModal(true)
                          }}
                        >
                          添加采购选项
                        </button>
                      </div>
                    )}
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
                                return (
                                  <div key={record.id} className="restock-record compact">
                                    {/* 左侧：所有关键信息 */}
                                    <div className="record-info">
                                      <span className="record-date">{formatDate(record.at)}</span>
                                      <span className="record-separator">·</span>
                                      <span className="record-product">{item.name}</span>
                                      <span className="record-separator">·</span>
                                      <span className="record-platform">{record.platform || '—'}</span>
                                      {record.qty && (
                                        <>
                                          <span className="record-separator">·</span>
                                          <span className="record-qty">{record.qty} {item.unit || '件'}</span>
                                        </>
                                      )}
                                      <span className="record-separator">·</span>
                                      <span className="record-price">¥{record.price?.toFixed(2) || '0.00'}</span>
                                      <span className="record-separator">·</span>
                                      <span className="record-review-text">{record.review || '暂无评价'}</span>
                                    </div>
                                    
                                    {/* 右侧：评价按钮 */}
                                    <button 
                                      className="icon-button review-btn"
                                      onClick={() => handleOpenReviewModal(record, item.name, item.id)}
                                      title={record.review ? "编辑评价" : "添加评价"}
                                    >
                                      <svg 
                                        className="action-icon" 
                                        width="16" 
                                        height="16" 
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
      
      {/* 添加采购选项弹窗 */}
      <AddPurchaseOptionModal
        isOpen={showAddPurchaseModal}
        onClose={() => {
          setShowAddPurchaseModal(false)
          setAddPurchaseOptionItemId(null)
        }}
        onSave={(optionData) => {
          if (addPurchaseOptionItemId) {
            onAddPurchaseOption(addPurchaseOptionItemId, optionData)
          }
        }}
      />
      
      {/* 编辑采购选项弹窗 */}
      <EditPurchaseOptionModal
        isOpen={editModalOpen}
        onClose={() => {
          setEditModalOpen(false)
          setEditingPurchaseOption(null)
        }}
        option={editingPurchaseOption}
        onSave={onSaveEditedOption}
      />
      
      {/* 评价编辑弹窗 */}
      <ReviewEditModal
        isOpen={reviewModalOpen}
        onClose={handleCloseReviewModal}
        record={selectedRecord}
        itemName={currentItemName}
        initialReview={editingReviewText}
        onSave={handleSaveReviewFromModal}
      />
    </div>
  )
}

function Sidebar({ dueCount, categorySummaries, activeCategory, onSelectCategory, onCreateCategory, onOpenSettings, onRenameCategory, onDeleteCategory }: {
  dueCount: number
  categorySummaries: Array<{ category: string; views: ItemView[]; urgent: number; warning: number }>
  activeCategory: string | null
  onSelectCategory: (category: string | null) => void
  onCreateCategory: () => void
  onOpenSettings: () => void
  onRenameCategory: (oldName: string, newName: string) => void
  onDeleteCategory: (name: string) => void
}) {
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null)
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
      <span className="sidebar-section-label">分类</span>

      {categorySummaries.map(({ category, views, urgent, warning }) => {
        const dotStatus = urgent ? "urgent" : warning ? "warning" : "normal"
        const isEditing = editingCategory === category
        const isHovered = hoveredCategory === category
        
        return (
          <div 
            key={category}
            className={`sidebar-item-wrapper ${activeCategory === category ? "is-active" : ""}`}
            onMouseEnter={() => setHoveredCategory(category)}
            onMouseLeave={() => setHoveredCategory(null)}
          >
            {/* 分类项主体 - 点击切换分类 */}
            {!isEditing && (
              <button
                className="sidebar-item-main"
                onClick={() => onSelectCategory(category)}
              >
                <span className={`sidebar-dot ${dotStatus}`} />
                <span className="sidebar-item-name">{category}</span>
                <span className="sidebar-item-count">{views.length}</span>
              </button>
            )}
            
            {/* Hover 时显示的编辑按钮 */}
            {isHovered && !isEditing && (
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
            
            {/* 编辑模式 */}
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
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(`确定要删除分类"${category}"吗？该分类下的所有物品将被移至"其他"分类。`)) {
                      onDeleteCategory(category)
                      setEditingCategory(null)
                    }
                  }}
                  aria-label="删除分类"
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )}
          </div>
        )
      })}

      <div className="sidebar-divider" />
      <button className="sidebar-add" onClick={onCreateCategory}>
        <Icon name="plus" size={13} />
        新建分类
      </button>
      
      <button className="sidebar-settings" onClick={onOpenSettings}>
        <Icon name="settings" size={13} />
        设置
      </button>
    </nav>
  )
}
