import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { AnimatedIcon as Icon } from "./AnimatedIcon"
import { Dashboard } from "./Dashboard"
import {
  calculateMonthlySpend,
  calibrateRemainingDays,
  computeItem,
  createItem,
  DEFAULT_CYCLES,
  formatDate,
  nextSnoozeTime,
  restockItem,
  updateItemFromDraft
} from "./domain"
import { loadState, persistState } from "./store"
import type { AppState, ItemComputed, ItemDraft, ReplenishmentItem } from "./types"

const EMPTY_DRAFT: ItemDraft = {
  name: "",
  category: "厨房",
  cycleDays: 10,
  bufferDays: 2,
  link: "",
  remainingDays: "",
  learningEnabled: true
}

type RecentRestock = {
  itemId: string
  itemName: string
  amount: string
  snapshot: ReplenishmentItem
}

type PurchasePrompt = {
  itemId: string
  itemName: string
}

function cloneItem(item: ReplenishmentItem): ReplenishmentItem {
  return { ...item, history: item.history.map((event) => ({ ...event })) }
}

function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [editingItem, setEditingItem] = useState<ReplenishmentItem | null | undefined>(undefined)
  const [newItemCategory, setNewItemCategory] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [categoryCreatorOpen, setCategoryCreatorOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [categoryDialog, setCategoryDialog] = useState<"rename" | "delete" | null>(null)
  const [detailItemId, setDetailItemId] = useState<string | null>(null)
  const [focusIds, setFocusIds] = useState<string[]>([])
  const [recentRestock, setRecentRestock] = useState<RecentRestock | null>(null)
  const [purchasePrompt, setPurchasePrompt] = useState<PurchasePrompt | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const itemViews = useMemo(() => state.items
    .map((item) => ({ item, computed: computeItem(item, now) }))
    .sort((a, b) => a.computed.dueAt - b.computed.dueAt), [now, state.items])
  const urgentItems = itemViews.filter(({ computed }) => computed.status === "urgent" && computed.isDue)
  const warningItems = itemViews.filter(({ computed }) => computed.status === "warning" && computed.isDue)
  const statusSummary = useMemo(() => ({
    urgent: itemViews.filter(({ computed }) => computed.status === "urgent").length,
    warning: itemViews.filter(({ computed }) => computed.status === "warning").length,
    sufficient: itemViews.filter(({ computed }) => computed.status === "normal").length
  }), [itemViews])
  const monthlySpend = useMemo(() => calculateMonthlySpend(state.items, now), [now, state.items])
  const monthLabel = useMemo(() => new Intl.DateTimeFormat("zh-CN", { month: "long" }).format(now), [now])
  const detailItem = detailItemId ? state.items.find((item) => item.id === detailItemId) || null : null
  const categorySummaries = useMemo(() => state.categories.map((category) => {
    const views = itemViews.filter(({ item }) => item.category === category)
    return {
      category,
      views,
      urgent: views.filter(({ computed }) => computed.displayStatus === "urgent").length,
      warning: views.filter(({ computed }) => computed.displayStatus === "warning").length,
      ordered: views.filter(({ computed }) => computed.displayStatus === "ordered").length
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
    setFocusIds(payload.itemIds)
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
      else if (categoryMenuOpen) setCategoryMenuOpen(false)
      else if (detailItemId) setDetailItemId(null)
      else if (settingsOpen) setSettingsOpen(false)
      else if (editingItem !== undefined) {
        setEditingItem(undefined)
        setNewItemCategory(undefined)
      }
      else if (categoryCreatorOpen) setCategoryCreatorOpen(false)
      else if (activeCategory) setActiveCategory(null)
    }
    window.addEventListener("keydown", closeTopPanel)
    return () => window.removeEventListener("keydown", closeTopPanel)
  }, [activeCategory, categoryCreatorOpen, categoryDialog, categoryMenuOpen, detailItemId, editingItem, settingsOpen])

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
    const snapshot = cloneItem(item)
    updateItems([item.id], (current) => restockItem(current))
    setRecentRestock({ itemId: item.id, itemName: item.name, amount: "", snapshot })
    setPurchasePrompt((current) => current?.itemId === item.id ? null : current)
    setFocusIds([])
  }

  function undoRestock() {
    if (!recentRestock) return
    const snapshot = cloneItem(recentRestock.snapshot)
    updateItems([recentRestock.itemId], () => snapshot)
    setRecentRestock(null)
  }

  function saveRestockAmount() {
    if (!recentRestock || recentRestock.amount === "") return
    const amount = Math.max(0, Number(recentRestock.amount))
    updateItems([recentRestock.itemId], (item) => ({
      ...item,
      price: amount,
      history: item.history.map((event, index) => index === item.history.length - 1 ? { ...event, price: amount } : event),
      updatedAt: Date.now()
    }))
    setRecentRestock(null)
  }

  function handleSnooze(item: ReplenishmentItem) {
    const snoozeUntil = nextSnoozeTime(state.settings.snoozeUntilHour)
    updateItems([item.id], (current) => ({ ...current, snoozeUntil, updatedAt: Date.now() }))
  }

  function confirmOrdered() {
    if (!purchasePrompt) return
    updateItems([purchasePrompt.itemId], (item) => ({
      ...item,
      orderedAt: Date.now(),
      snoozeUntil: undefined,
      updatedAt: Date.now()
    }))
    setPurchasePrompt(null)
  }

  function calibrateItem(item: ReplenishmentItem, remainingDays: number) {
    updateItems([item.id], (current) => calibrateRemainingDays(current, remainingDays))
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
    setCategoryMenuOpen(false)
    setActiveCategory(null)
  }

  function deleteItem(item: ReplenishmentItem) {
    commit({ ...state, items: state.items.filter((current) => current.id !== item.id) })
    setDetailItemId(null)
    setEditingItem(undefined)
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

  async function openPurchase(item: ReplenishmentItem) {
    if (!item.link) return
    if (window.desktop) await window.desktop.openExternal(item.link)
    else window.open(item.link, "_blank", "noopener,noreferrer")
    setPurchasePrompt({ itemId: item.id, itemName: item.name })
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
        <div className="brand-block">
          <div className="brand-mark"><Icon name="bell" size={19} /></div>
          <h1>403家庭管家</h1>
        </div>
        <div className="top-actions">
          <button className="icon-button" aria-label="提醒设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
        </div>
      </header>

      <main>
        <Dashboard
          total={state.items.length}
          urgent={statusSummary.urgent}
          warning={statusSummary.warning}
          sufficient={statusSummary.sufficient}
          monthlySpend={monthlySpend}
          monthlyBudget={state.settings.monthlyBudget}
          monthLabel={monthLabel}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {(urgentItems.length > 0 || warningItems.length > 0) && (
          <section className="attention-section">
            {urgentItems.length > 0 && <AttentionGroup title="急需补货" tone="urgent" items={urgentItems} focusIds={focusIds} onOpen={openItem} onPurchase={openPurchase} />}
            {warningItems.length > 0 && <AttentionGroup title="快用完" tone="warning" items={warningItems} focusIds={focusIds} onOpen={openItem} onPurchase={openPurchase} />}
          </section>
        )}

        <section className="category-section">
          <div className="section-heading category-heading">
            <h3>家中清单</h3>
            <div className="category-heading-actions"><span>{state.items.length} 项</span><button onClick={() => setCategoryCreatorOpen(true)}><Icon name="plus" size={15} />新建分类</button></div>
          </div>
          <div className="category-grid">
            {categorySummaries.map((summary) => <CategoryCard key={summary.category} {...summary} onOpen={() => setActiveCategory(summary.category)} />)}
          </div>
        </section>
      </main>

      {activeCategory && (
        <CategoryPanel category={activeCategory} views={itemViews.filter(({ item }) => item.category === activeCategory)} menuOpen={categoryMenuOpen} onToggleMenu={() => setCategoryMenuOpen((open) => !open)} onClose={() => {
          setCategoryMenuOpen(false)
          setActiveCategory(null)
        }} onOpenItem={openItem} onAddItem={() => addItemToCategory(activeCategory)} onRename={() => {
          setCategoryMenuOpen(false)
          setCategoryDialog("rename")
        }} onDelete={() => {
          setCategoryMenuOpen(false)
          setCategoryDialog("delete")
        }} />
      )}
      {detailItem && (
        <ItemDetailPanel key={detailItem.id} item={detailItem} computed={computeItem(detailItem, now)} onClose={() => setDetailItemId(null)} onEdit={editFromDetail} onSnooze={handleSnooze} onPurchase={openPurchase} onCalibrate={calibrateItem} onApplySuggestion={applyCycleSuggestion} onDismissSuggestion={dismissSuggestion} />
      )}
      {editingItem !== undefined && (
        <ItemEditor item={editingItem} initialCategory={newItemCategory} categories={state.categories} onAddCategory={addCategory} onClose={() => {
          setEditingItem(undefined)
          setNewItemCategory(undefined)
        }} onSave={saveItem} onDelete={editingItem ? deleteItem : undefined} />
      )}
      {settingsOpen && <SettingsPanel state={state} onChange={commit} onClose={() => setSettingsOpen(false)} />}
      {categoryCreatorOpen && <CategoryCreator existingCategories={state.categories} onClose={() => setCategoryCreatorOpen(false)} onCreate={(name) => {
        const category = addCategory(name)
        if (!category) return false
        setCategoryCreatorOpen(false)
        return true
      }} />}
      {activeCategory && categoryDialog && <CategoryManagerDialog mode={categoryDialog} category={activeCategory} categories={state.categories} itemCount={state.items.filter((item) => item.category === activeCategory).length} onClose={() => setCategoryDialog(null)} onRename={(name) => renameCategory(activeCategory, name)} onDelete={(moveTo) => deleteCategory(activeCategory, moveTo)} />}
      {recentRestock && (
        <div className="restock-receipt" role="status">
          <div className="receipt-check"><Icon name="check" /></div>
          <div className="receipt-copy">
            <strong>{recentRestock.itemName} 已记录为补货</strong>
            <span>这一次总共花了多少？选填，不是单价。</span>
          </div>
          <button className="receipt-undo" onClick={undoRestock}>撤销</button>
          <div className="receipt-amount input-prefix">
            <b>¥</b>
            <input aria-label="本次补货总金额" type="number" min="0" step="0.01" value={recentRestock.amount} onChange={(event) => setRecentRestock({ ...recentRestock, amount: event.target.value })} placeholder="总金额" />
          </div>
          <button className="receipt-save" disabled={recentRestock.amount === ""} onClick={saveRestockAmount}>记下</button>
          <button className="row-icon-button" aria-label="不记录金额" onClick={() => setRecentRestock(null)}><Icon name="close" /></button>
        </div>
      )}
      {purchasePrompt && (
        <div className={`order-prompt ${recentRestock ? "with-receipt" : ""}`} role="status" aria-live="polite">
          <div className="order-prompt-copy"><strong>{purchasePrompt.itemName} 下单了吗？</strong><span>确认后先暂停提醒，3 天后还没到会再问你。</span></div>
          <button className="primary-button" onClick={confirmOrdered}>下单了</button>
          <button className="row-icon-button" aria-label="暂不确认下单" onClick={() => setPurchasePrompt(null)}><Icon name="close" /></button>
        </div>
      )}
    </div>
  )
}

function CategoryCreator({ existingCategories, onClose, onCreate }: {
  existingCategories: string[]
  onClose: () => void
  onCreate: (name: string) => boolean
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
    <div className="overlay category-creator-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="category-creator" onSubmit={submit}>
        <div className="category-creator-header">
          <div><p className="eyebrow">整理家中清单</p><h2>添加分类</h2></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </div>
        <label className="field"><span>分类名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：宝宝用品" /></label>
        <p className={duplicated ? "category-creator-tip error" : "category-creator-tip"}>{duplicated ? "这个分类已经有了" : "可以按房间、家人或生活习惯来分。"}</p>
        <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!normalized || duplicated}>添加</button></div>
      </form>
    </div>
  )
}

type ItemView = { item: ReplenishmentItem; computed: ItemComputed }

function AttentionGroup({ title, tone, items, focusIds, onOpen, onPurchase }: {
  title: string
  tone: "warning" | "urgent"
  items: ItemView[]
  focusIds: string[]
  onOpen: (item: ReplenishmentItem) => void
  onPurchase: (item: ReplenishmentItem) => void
}) {
  return (
    <div className={`attention-group ${tone}`}>
      <div className="attention-heading"><div><span className={`status-dot ${tone}`} /><h3>{title}</h3></div><span>{items.length} 项</span></div>
      <div className="attention-list">
        {items.map(({ item, computed }) => (
          <article key={item.id} className={`attention-row ${focusIds.includes(item.id) ? "is-focused" : ""}`}>
            <button className="attention-open" onClick={() => onOpen(item)}>
              <span className="attention-copy"><strong>{item.name}</strong><small>{item.category} · {computed.remainingText}</small></span>
              <Icon name="arrow" size={17} />
            </button>
            {item.link && !computed.isOrdered && <button className="attention-purchase" onClick={() => onPurchase(item)}><Icon name="cart" />去补货</button>}
          </article>
        ))}
      </div>
    </div>
  )
}

function CategoryCard({ category, views, urgent, warning, ordered, onOpen }: {
  category: string
  views: ItemView[]
  urgent: number
  warning: number
  ordered: number
  onOpen: () => void
}) {
  const signal = !views.length
    ? { tone: "empty", label: "暂无记录" }
    : urgent
      ? { tone: "urgent", label: `${urgent} 项需要补货` }
      : warning
        ? { tone: "warning", label: `${warning} 项快用完` }
        : ordered
          ? { tone: "ordered", label: `${ordered} 项在路上` }
          : { tone: "normal", label: "充足" }

  return (
    <button className="category-card" onClick={onOpen}>
      <span className="category-card-top"><strong className="category-card-title">{category}</strong><span className="category-card-count">{views.length} 项</span></span>
      <span className="category-card-signal">
        <span className={`status-dot ${signal.tone}`} />
        <strong>{signal.label}</strong>
      </span>
    </button>
  )
}

function CategoryPanel({ category, views, menuOpen, onToggleMenu, onClose, onOpenItem, onAddItem, onRename, onDelete }: {
  category: string
  views: ItemView[]
  menuOpen: boolean
  onToggleMenu: () => void
  onClose: () => void
  onOpenItem: (item: ReplenishmentItem) => void
  onAddItem: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const urgent = views.filter(({ computed }) => computed.status === "urgent" && computed.isDue).length
  const warning = views.filter(({ computed }) => computed.status === "warning" && computed.isDue).length
  const ordered = views.filter(({ computed }) => computed.isOrdered).length
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel category-panel">
        <div className="panel-header"><div><p className="eyebrow">家中清单</p><h2>{category}</h2></div><div className="panel-header-actions"><button className="primary-button" onClick={onAddItem}><Icon name="plus" />添加消耗品</button><div className="category-menu-wrap"><button className="icon-button" aria-label="管理分类" aria-expanded={menuOpen} onClick={onToggleMenu}><Icon name="more" /></button>{menuOpen && <div className="category-menu"><button onClick={onRename}><Icon name="edit" size={16} />重命名分类</button><button className="danger" onClick={onDelete}>删除分类</button></div>}</div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div></div>
        <div className="category-summary"><strong>{views.length}</strong><span>项</span>{urgent > 0 && <span className="category-summary-status"><i className="status-dot urgent" />{urgent} 急需</span>}{warning > 0 && <span className="category-summary-status"><i className="status-dot warning" />{warning} 快用完</span>}{ordered > 0 && <span className="category-summary-status"><i className="status-dot ordered" />{ordered} 在路上</span>}{views.length > 0 && urgent === 0 && warning === 0 && ordered === 0 && <span className="category-summary-status"><i className="status-dot" />充足</span>}</div>
        <div className="category-item-list">
          {views.map(({ item, computed }) => (
            <button key={item.id} className="category-item" onClick={() => onOpenItem(item)}>
              <span className={`status-dot ${computed.displayStatus}`} />
              <span className="category-item-copy"><strong>{item.name}</strong><small>{computed.remainingText}</small></span>
              <span className={`status-label ${computed.displayStatus}`}>{computed.statusLabel}</span>
              <Icon name="arrow" size={17} />
            </button>
          ))}
          {!views.length && <div className="empty-category">这个分类还没有记录</div>}
        </div>
      </aside>
    </div>
  )
}

function CategoryManagerDialog({ mode, category, categories, itemCount, onClose, onRename, onDelete }: {
  mode: "rename" | "delete"
  category: string
  categories: string[]
  itemCount: number
  onClose: () => void
  onRename: (name: string) => void
  onDelete: (moveTo?: string) => void
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
    <div className="overlay category-manager-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="category-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="category-manager-title">
        <div className="category-creator-header"><div><p className="eyebrow">管理分类</p><h2 id="category-manager-title">{mode === "rename" ? "修改分类名称" : `删除“${category}”`}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        {mode === "rename" ? (
          <form onSubmit={submitRename}>
            <label className="field"><span>分类名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
            <p className={duplicated ? "category-creator-tip error" : "category-creator-tip"}>{duplicated ? "这个分类已经有了" : "分类里的内容会一起更新到新名称。"}</p>
            <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!normalized || normalized === category || duplicated}>保存</button></div>
          </form>
        ) : itemCount === 0 ? (
          <div><p className="category-delete-copy">这个分类里还没有内容，可以直接删除。</p><div className="category-creator-actions"><button className="quiet-button" onClick={onClose}>取消</button><button className="danger-button" onClick={() => onDelete()}>删除分类</button></div></div>
        ) : (
          <div className="category-delete-options">
            <div className="category-move-box">
              <strong>保留这 {itemCount} 项</strong>
              <p>先移到其他分类，再删除“{category}”。</p>
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

function ItemDetailPanel({ item, computed, onClose, onEdit, onSnooze, onPurchase, onCalibrate, onApplySuggestion, onDismissSuggestion }: {
  item: ReplenishmentItem
  computed: ItemComputed
  onClose: () => void
  onEdit: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onPurchase: (item: ReplenishmentItem) => void
  onCalibrate: (item: ReplenishmentItem, remainingDays: number) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
}) {
  const [calibrating, setCalibrating] = useState(false)
  const [remainingDays, setRemainingDays] = useState(String(Math.max(0, computed.daysUntilDepletion)))

  function submitCalibration(event: FormEvent) {
    event.preventDefault()
    if (remainingDays === "") return
    onCalibrate(item, Number(remainingDays))
    setCalibrating(false)
  }

  return (
    <div className="overlay detail-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel detail-panel">
        <div className="panel-header"><div><p className="eyebrow">{item.category}</p><h2>{item.name}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <div className="detail-status">
          <div className="detail-status-heading"><span className={`status-dot ${computed.displayStatus}`} /><span>{computed.statusLabel}</span></div>
          <strong>{computed.remainingText}</strong>
          <small>{computed.isOrdered ? `下单于 ${formatDate(item.orderedAt!)}` : `预计 ${formatDate(computed.depletionAt)} 用完`}</small>
        </div>
        {(computed.status !== "normal" && ((item.link && !computed.isOrdered) || computed.isDue)) && <div className="detail-actions">
          {item.link && !computed.isOrdered && <button className="primary-button" onClick={() => onPurchase(item)}><Icon name="cart" />去补货</button>}
          {computed.isDue && <button className="quiet-button" onClick={() => onSnooze(item)}><Icon name="clock" />稍后提醒</button>}
        </div>}
        <div className="remaining-calibration">
          {calibrating ? (
            <form onSubmit={submitCalibration}>
              <label><span>其实还能用</span><div className="input-suffix"><input autoFocus aria-label="实际还能使用天数" type="number" min="0" max={item.cycleDays} value={remainingDays} onChange={(event) => setRemainingDays(event.target.value)} /><b>天</b></div></label>
              <button type="button" className="quiet-button" onClick={() => setCalibrating(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={remainingDays === ""}>校准</button>
            </form>
          ) : (
            <button className="calibrate-link" onClick={() => setCalibrating(true)}><Icon name="clock" size={16} />实际剩余天数不准？校准一下</button>
          )}
        </div>
        <div className="detail-facts">
          <div><span>补货间隔</span><strong>约 {item.cycleDays} 天</strong></div>
          <div><span>提前提醒</span><strong>{item.bufferDays} 天</strong></div>
          <div><span>上次补货</span><strong>{formatDate(item.lastRestockedAt)}</strong></div>
          <div><span>补货记录</span><strong>{item.history.length} 次</strong></div>
        </div>
        {item.suggestedCycleDays && (
          <div className="suggestion">
            <span>最近几次大约每 {item.suggestedCycleDays} 天补一次，要把原来的 {item.cycleDays} 天改掉吗？</span>
            <button onClick={() => onApplySuggestion(item)}>调整</button>
            <button className="text-button" onClick={() => onDismissSuggestion(item)}>暂不</button>
          </div>
        )}
        {item.history.length > 0 && <div className="detail-history"><h3>最近补货</h3>{item.history.slice(-4).reverse().map((event) => <div key={event.id}><span>{formatDate(event.at)}</span><small>{event.intervalDays ? `相隔 ${event.intervalDays} 天` : "首次记录"}{event.price !== undefined ? ` · ¥${event.price.toFixed(2)}` : ""}</small></div>)}</div>}
        <div className="detail-footer"><button className="quiet-button" onClick={() => onEdit(item)}><Icon name="edit" />修改补货设置</button></div>
      </aside>
    </div>
  )
}

function ItemEditor({ item, initialCategory, categories, onAddCategory, onClose, onSave, onDelete }: {
  item: ReplenishmentItem | null
  initialCategory?: string
  categories: string[]
  onAddCategory: (name: string) => string | undefined
  onClose: () => void
  onSave: (draft: ItemDraft) => void
  onDelete?: (item: ReplenishmentItem) => void
}) {
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState("")
  const [groupAdded, setGroupAdded] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const cycleManuallyChanged = useRef(false)
  const [draft, setDraft] = useState<ItemDraft>(() => item ? {
    name: item.name,
    category: item.category,
    cycleDays: item.cycleDays,
    bufferDays: item.bufferDays,
    link: item.link || "",
    remainingDays: "",
    learningEnabled: item.learningEnabled !== false
  } : { ...EMPTY_DRAFT, category: initialCategory || EMPTY_DRAFT.category })

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
    <div className="overlay editor-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel editor-panel">
        <div className="panel-header"><div><p className="eyebrow">{item ? "补货提醒" : "添加到清单"}</p><h2>{item ? `编辑 ${item.name}` : "添加消耗品"}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <form onSubmit={submit}>
          <label className="field field-wide">
            <span>归到哪里</span>
            <select autoFocus={!item} value={addingGroup ? "__new__" : draft.category} onChange={(event) => handleGroup(event.target.value)}>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
              <option value="__new__">＋ 新建分类</option>
            </select>
          </label>
          {groupAdded && <div className="group-added field-wide"><Icon name="check" size={15} />已添加并选中“{draft.category}”</div>}
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

          <label className="field field-wide"><span>消耗品名称</span><input autoFocus={Boolean(item)} value={draft.name} onChange={(event) => handleName(event.target.value)} placeholder="例如：卫生纸" /></label>

          <label className="field field-wide">
            <span>大约多久补一次</span>
            <div className="input-suffix"><input type="number" min="1" value={draft.cycleDays} onChange={(event) => handleCycle(Number(event.target.value))} /><b>天</b></div>
          </label>
          {!item && <label className="field field-wide"><span>手头这些大概还能用多久 <em>选填</em></span><div className="input-suffix"><input type="number" min="0" value={draft.remainingDays} onChange={(event) => set("remainingDays", event.target.value)} placeholder="不确定就留空" /><b>天</b></div></label>}

          <div className="more-settings field-wide">
            <button type="button" className="more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <span>更多设置</span><span className={moreOpen ? "more-arrow open" : "more-arrow"}>⌄</span>
            </button>
            {moreOpen && (
              <div className="more-content">
                <label className="field"><span>提前几天提醒</span><div className="input-suffix"><input type="number" min="0" max={Math.max(0, draft.cycleDays - 1)} value={Math.min(draft.bufferDays, Math.max(0, draft.cycleDays - 1))} onChange={(event) => set("bufferDays", Number(event.target.value))} /><b>天</b></div></label>
                <label className="field"><span>常买的商品链接 <em>选填</em></span><input type="url" value={draft.link} onChange={(event) => set("link", event.target.value)} placeholder="https://" /></label>
                <label className="learning-toggle"><input type="checkbox" checked={!draft.learningEnabled} onChange={(event) => set("learningEnabled", !event.target.checked)} /><span>不再给出补货间隔调整建议</span></label>
              </div>
            )}
          </div>
          {item && item.history.length > 0 && <div className="history-block"><span>最近补货</span>{item.history.slice(-3).reverse().map((event) => <div key={event.id}><b>{formatDate(event.at)}</b><span>{event.intervalDays ? `间隔 ${event.intervalDays} 天` : "首轮记录"}{event.price !== undefined ? ` · 共 ¥${event.price.toFixed(2)}` : ""}</span></div>)}</div>}
          <div className="panel-footer">{item && onDelete ? <button type="button" className="danger-link" onClick={() => onDelete(item)}>删除消耗品</button> : <span />}<div><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存</button></div></div>
        </form>
      </aside>
    </div>
  )
}

function SettingsPanel({ state, onChange, onClose }: { state: AppState; onChange: (state: AppState) => void; onClose: () => void }) {
  const settings = state.settings
  function patch(values: Partial<typeof settings>) {
    onChange({ ...state, settings: { ...settings, ...values } })
  }
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel settings-panel">
        <div className="panel-header"><div><p className="eyebrow">安静，但不会忘</p><h2>提醒与预算</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <div className="settings-group"><div><h3>每月生活预算</h3><p>用于首页看板，不会影响补货提醒。</p></div><div className="input-prefix budget-input"><b>¥</b><input aria-label="每月生活预算" type="number" min="0" step="100" value={settings.monthlyBudget ?? ""} onChange={(event) => patch({ monthlyBudget: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)) })} placeholder="未设置" /></div></div>
        <div className="settings-group"><div><h3>重复提醒</h3><p>只要还没处理，并且你正在电脑前。</p></div><div className="segmented compact"><button className={settings.reminderIntervalMinutes === 30 ? "active" : ""} onClick={() => patch({ reminderIntervalMinutes: 30 })}>30 分钟</button><button className={settings.reminderIntervalMinutes === 60 ? "active" : ""} onClick={() => patch({ reminderIntervalMinutes: 60 })}>60 分钟</button></div></div>
        <div className="settings-group"><div><h3>勿扰时段</h3><p>这段时间即便在电脑前也不弹提醒。</p></div><div className="time-range"><input type="time" value={settings.quietStart} onChange={(event) => patch({ quietStart: event.target.value })} /><span>至</span><input type="time" value={settings.quietEnd} onChange={(event) => patch({ quietEnd: event.target.value })} /></div></div>
        <div className="settings-group"><div><h3>离开电脑后暂停</h3><p>系统检测到空闲后停止弹窗，回来再继续。</p></div><div className="input-suffix short"><input type="number" min="1" max="30" value={settings.idleThresholdMinutes} onChange={(event) => patch({ idleThresholdMinutes: Number(event.target.value) })} /><b>分钟</b></div></div>
        <div className="settings-group"><div><h3>稍后提醒</h3><p>默认推迟到第二天的这个时间。</p></div><div className="input-suffix short"><input type="number" min="0" max="23" value={settings.snoozeUntilHour} onChange={(event) => patch({ snoozeUntilHour: Number(event.target.value) })} /><b>点</b></div></div>
        <div className="notification-test"><div className="brand-mark"><Icon name="bell" /></div><div><h3>测试系统通知</h3><p>确认 Mac 已经允许“403家庭管家”发送通知。</p></div><button className="quiet-button" onClick={() => window.desktop?.testNotification()}>发送测试</button></div>
        <p className="settings-note">关闭窗口后应用仍会留在菜单栏，继续计算提醒。</p>
      </aside>
    </div>
  )
}

export default App
