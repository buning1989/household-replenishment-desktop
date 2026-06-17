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
import type { AppState, ItemComputed, ItemDraft, PriceAnchor, Rating, RecentRestock, ReplenishmentItem } from "./types"
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
  const [now, setNow] = useState(() => Date.now())
  // 标题滚动隐入兜底：作为 scroll-timeline 的 JS 兜底，保证标题一定能随滚动消失。
  const brandTitleRef = useRef<HTMLHeadingElement>(null)

  const itemViews = useMemo(() => state.items
    .map((item) => ({ item, computed: computeItem(item, now) }))
    .sort((a, b) => a.computed.dueAt - b.computed.dueAt), [now, state.items])
  const dueItems = itemViews.filter(({ item, computed }) => computed.isDue || (recentRestock && item.id === recentRestock.itemId))
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

  // 标题滚动隐入兜底：监听窗口滚动，按比例改透明度/位移/模糊。
  // 与 CSS 的 animation-timeline: scroll() 并存；若 CSS 生效则本逻辑被覆盖，二者无冲突。
  useEffect(() => {
    if (!brandTitleRef.current) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduce) return
    let raf = 0
    const apply = () => {
      raf = 0
      const node = brandTitleRef.current
      if (!node) return
      const y = window.scrollY
      const t = Math.min(1, Math.max(0, y / 72))   // 0→72px 完成隐入，与 CSS 区间一致
      node.style.opacity = String(1 - t)
      node.style.transform = `translateX(${-12 * t}px)`
      node.style.filter = t > 0 ? `blur(${(2 * t).toFixed(2)}px)` : "none"
    }
    function onScroll() { if (!raf) raf = window.requestAnimationFrame(apply) }
    apply()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => { window.removeEventListener("scroll", onScroll); if (raf) window.cancelAnimationFrame(raf) }
  }, [])

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
  }, [activeCategory, categoryCreatorOpen, categoryDialog, detailItemId, editingItem, settingsOpen])

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
    setRecentRestock({
      itemId: item.id,
      itemName: item.name,
      amount: "",
      qty: item.defaultQty ? String(item.defaultQty) : "",
      platform: item.platform || "",
      customPlatform: "",
      linkDraft: item.link || "",
      snapshot
    })
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

  function quickEditItem(item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform">>) {
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

  function rateRestockEvent(itemId: string, eventId: string, rating: Rating, review?: string) {
    updateItems([itemId], (item) => ({
      ...item,
      history: item.history.map((e) =>
        e.id === eventId ? { ...e, rating, review: review?.trim() || undefined } : e
      ),
      updatedAt: Date.now()
    }))
  }

  async function openPurchase(item: ReplenishmentItem) {
    if (!item.link) return
    if (window.desktop) await window.desktop.openExternal(item.link)
    else window.open(item.link, "_blank", "noopener,noreferrer")
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
          <div className="brand-mark"><img src={catIcon} alt="403家庭管家" className="brand-cat" /></div>
          <h1 className="brand-title" ref={brandTitleRef}>403家庭管家</h1>
        </div>
        <div className="top-actions">
          <button className="icon-button" aria-label="提醒设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
        </div>
      </header>

      <main>
        <CurrentTasks
          items={dueItems}
          recentRestock={recentRestock}
          allItems={itemViews}
          onPurchase={openPurchase}
          onRestock={handleRestock}
          onSnooze={handleSnooze}
          onUpdateRestock={(patch) => setRecentRestock((current) => current ? { ...current, ...patch } : current)}
          onSaveRestock={saveRestockAmount}
          onUndoRestock={undoRestock}
          onDismissRestock={() => setRecentRestock(null)}
          onApplySuggestion={applyCycleSuggestion}
          onDismissSuggestion={dismissSuggestion}
          onOpenItem={openItem}
        />

        <section className="category-section home-category-section" aria-labelledby="category-title">
          <div className="section-heading category-heading">
            <h3 id="category-title">分类</h3>
            <div className="category-heading-actions"><span>{state.categories.length} 组</span><button onClick={() => setCategoryCreatorOpen(true)}><Icon name="plus" size={15} />新建分类</button></div>
          </div>
          <div className="category-grid">
            {categorySummaries.map((summary) => <CategoryCard key={summary.category} {...summary} onOpen={() => setActiveCategory(summary.category)} onRename={(name) => renameCategory(summary.category, name)} onDelete={() => deleteCategory(summary.category)} />)}
          </div>
        </section>
      </main>

      {activeCategory && (
        <CategoryPanel
          category={activeCategory}
          views={itemViews.filter(({ item }) => item.category === activeCategory)}
          onClose={() => setActiveCategory(null)}
          onAddItem={() => addItemToCategory(activeCategory)}
          onRename={() => setCategoryDialog("rename")}
          onDelete={() => setCategoryDialog("delete")}
          onEdit={editFromDetail}
          onSnooze={handleSnooze}
          onPurchase={openPurchase}
          onRestock={handleRestock}
          onQuickEdit={quickEditItem}
          onApplySuggestion={applyCycleSuggestion}
          onDismissSuggestion={dismissSuggestion}
          onRateEvent={rateRestockEvent}
        />
      )}
      {detailItem && (
        <ItemDetailPanel
          key={detailItem.id}
          item={detailItem}
          computed={computeItem(detailItem, now)}
          onClose={() => setDetailItemId(null)}
          onEdit={editFromDetail}
          onSnooze={handleSnooze}
          onPurchase={openPurchase}
          onRestock={handleRestock}
          onCalibrate={calibrateItem}
          onApplySuggestion={applyCycleSuggestion}
          onDismissSuggestion={dismissSuggestion}
          onRateEvent={rateRestockEvent}
        />
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
          <h2>添加分类</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </div>
        <label className="field"><span>分类名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：宝宝用品" /></label>
        {duplicated && <p className="category-creator-tip error">这个分类已经有了</p>}
        <div className="category-creator-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!normalized || duplicated}>添加</button></div>
      </form>
    </div>
  )
}

type ItemView = { item: ReplenishmentItem; computed: ItemComputed }

function TaskActions({ item, onPurchase, onRestock, onSnooze }: {
  item: ReplenishmentItem
  onPurchase: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
}) {
  const latestRating = getLatestRating(item)
  return (
    <div className="task-actions">
      {latestRating === 1 && <span className="rating-warning" title="上次评价较差">⚠ 上次较差</span>}
      <button className="task-action purchase" disabled={!item.link} title={item.link ? undefined : "可在分类中添加常买链接"} onClick={() => onPurchase(item)}><Icon name="cart" />去补货</button>
      <button className="task-action done" onClick={() => onRestock(item)}><Icon name="check" />已买好</button>
      <button className="task-action" onClick={() => onSnooze(item)}><Icon name="clock" />明天提醒我</button>
    </div>
  )
}

function CurrentTasks({ items, recentRestock, allItems, onPurchase, onRestock, onSnooze, onUpdateRestock, onSaveRestock, onUndoRestock, onDismissRestock, onApplySuggestion, onDismissSuggestion, onOpenItem }: {
  items: ItemView[]
  recentRestock: RecentRestock | null
  allItems: ItemView[]
  onPurchase: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onUpdateRestock: (patch: Partial<RecentRestock>) => void
  onSaveRestock: () => void
  onUndoRestock: () => void
  onDismissRestock: () => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onOpenItem: (item: ReplenishmentItem) => void
}) {
  // 没有待处理事项时，展示更有意义的空状态
  if (!items.length) {
    // 找出最近需要关注的消耗品（按 dueAt 排序的前 5 个，排除已到期的）
    const upcomingItems = allItems
      .filter(({ computed }) => !computed.isDue)
      .slice(0, 5)

    return (
      <section className="current-section empty-current" aria-labelledby="current-title">
        {upcomingItems.length > 0 ? (
          <div className="upcoming-cards">
            {upcomingItems.map(({ item, computed }) => (
              <div key={item.id} className={`upcoming-card ${computed.status}`}>
                <button className="upcoming-card-info" onClick={() => onOpenItem(item)}>
                  <span className={`status-dot ${computed.status}`} />
                  <span className="upcoming-card-name">{item.name}</span>
                  <span className="upcoming-card-meta">{computed.remainingText}</span>
                </button>
                <div className="upcoming-card-actions">
                  <button className="upcoming-action-primary" onClick={() => onRestock(item)}>已买好</button>
                  <button className="upcoming-action" onClick={() => onSnooze(item)}>稍后提醒</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="all-good-msg">家里的消耗品都很充足，继续保持！</p>
        )}
      </section>
    )
  }

  const restockItem = recentRestock ? items.find(({ item }) => item.id === recentRestock.itemId) : null

  return (
    <section className="current-section" aria-labelledby="current-title">
      <div className="current-heading"><h2 id="current-title">当前待处理</h2><span>{items.length} 项</span></div>
      <div className="current-list">
        {items.map(({ item, computed }) => {
          const remainingQty = estimateRemainingQty(item)
          const latestRating = getLatestRating(item)
          return (
            <div key={item.id} className="current-card-group">
              <article className={`current-card ${computed.status}`}>
                <div className="current-card-copy">
                  <span className={`status-dot ${computed.status}`} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.category} · {computed.remainingText}
                      {item.platform && <span className="platform-tag">{item.platform}</span>}
                      {remainingQty && <span> · {remainingQty}</span>}
                    </small>
                  </span>
                </div>
                <TaskActions item={item} onPurchase={onPurchase} onRestock={onRestock} onSnooze={onSnooze} />
              </article>
              {recentRestock && item.id === recentRestock.itemId && restockItem && (
                <RestockReceiptInline
                  recentRestock={recentRestock}
                  item={restockItem.item}
                  computed={restockItem.computed}
                  onUpdate={onUpdateRestock}
                  onSave={onSaveRestock}
                  onUndo={onUndoRestock}
                  onDismiss={onDismissRestock}
                  onApplySuggestion={onApplySuggestion}
                  onDismissSuggestion={onDismissSuggestion}
                />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function RestockReceiptInline({ recentRestock, item, computed, onUpdate, onSave, onUndo, onDismiss, onApplySuggestion, onDismissSuggestion }: {
  recentRestock: RecentRestock
  item: ReplenishmentItem
  computed: ItemComputed
  onUpdate: (patch: Partial<RecentRestock>) => void
  onSave: () => void
  onUndo: () => void
  onDismiss: () => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
}) {
  const priceAnchor = calculatePriceAnchor(item.history)
  const unit = item.unit || "件"
  const showOtherPlatform = recentRestock.platform === "其他"

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
            <input aria-label="购买数量" type="number" min="1" value={recentRestock.qty} onChange={(event) => onUpdate({ qty: event.target.value })} placeholder="选填" />
            <b>{unit}</b>
          </div>
        </div>
        <div className="restock-inline-field">
          <span>购买平台</span>
          <select value={recentRestock.platform} onChange={(event) => onUpdate({ platform: event.target.value, customPlatform: "" })}>
            <option value="">未选择</option>
            {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {showOtherPlatform && <input type="text" value={recentRestock.customPlatform} onChange={(event) => onUpdate({ customPlatform: event.target.value })} placeholder="输入平台名称" />}
        </div>
        <div className="restock-inline-field">
          <span>购买链接</span>
          <input className="restock-inline-link" type="url" value={recentRestock.linkDraft} onChange={(event) => onUpdate({ linkDraft: event.target.value })} placeholder="选填" />
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
        <button className="receipt-undo" onClick={onUndo}>撤销</button>
        <button className="primary-button compact" onClick={onSave}>记下</button>
        <button className="quiet-button compact" onClick={onDismiss}>跳过</button>
      </div>
    </div>
  )
}

function CategoryCard({ category, views, urgent, warning, onOpen, onRename, onDelete }: {
  category: string
  views: ItemView[]
  urgent: number
  warning: number
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(category)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [popoverAlign, setPopoverAlign] = useState<"right" | "left">("right")
  const popoverRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

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
    <div className="category-card-wrap" ref={cardRef}>
      <button className={`category-card ${popoverOpen ? "is-active" : ""}`} onClick={onOpen}>
        <span className="category-card-top">
          <strong className="category-card-title">{category}</strong>
          <span className="category-card-actions">
            <span className="category-card-count">{views.length} 项</span>
            <span className="category-card-edit" onClick={openPopover}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg></span>
          </span>
        </span>
        <span className="category-card-bottom">
          <span className="category-card-signal">
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
        <div className={`category-card-popover ${popoverAlign}`} onClick={(e) => e.stopPropagation()} ref={popoverRef}>
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

function CategoryPanel({ category, views, onClose, onAddItem, onRename, onDelete, onEdit, onSnooze, onPurchase, onRestock, onQuickEdit, onApplySuggestion, onDismissSuggestion, onRateEvent }: {
  category: string
  views: ItemView[]
  onClose: () => void
  onAddItem: () => void
  onRename: () => void
  onDelete: () => void
  onEdit: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onPurchase: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onQuickEdit: (item: ReplenishmentItem, patch: Partial<Pick<ReplenishmentItem, "cycleDays" | "bufferDays" | "link" | "unit" | "defaultQty" | "platform">>) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onRateEvent: (itemId: string, eventId: string, rating: Rating, review?: string) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<{ id: string; field: "cycleDays" | "bufferDays" | "link" | "defaultQty" | "unit" | "platform" } | null>(null)
  const [editValue, setEditValue] = useState("")
  const [unitCustomId, setUnitCustomId] = useState<string | null>(null)
  const [ratingEventId, setRatingEventId] = useState<string | null>(null)
  const [ratingItemId, setRatingItemId] = useState<string | null>(null)
  const [ratingDraft, setRatingDraft] = useState<{ rating: Rating | null; review: string }>({ rating: null, review: "" })
  const [moreOpen, setMoreOpen] = useState(false)
  const urgent = views.filter(({ computed }) => computed.status === "urgent" && computed.isDue).length
  const warning = views.filter(({ computed }) => computed.status === "warning" && computed.isDue).length

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

  function saveEditing(item: ReplenishmentItem) {
    if (!editingField) return
    if (editingField.field === "link") {
      onQuickEdit(item, { link: editValue || undefined })
      setEditingField(null)
      return
    }
    if (editingField.field === "defaultQty") {
      const trimmed = editValue.trim()
      const num = Number(trimmed)
      onQuickEdit(item, { defaultQty: trimmed && Number.isFinite(num) && num > 0 ? Math.round(num) : undefined })
      setEditingField(null)
      return
    }
    const num = Number(editValue)
    if (isNaN(num) || num < 1) { setEditingField(null); return }
    if (editingField.field === "cycleDays") {
      onQuickEdit(item, { cycleDays: Math.max(1, num) })
    } else {
      onQuickEdit(item, { bufferDays: Math.max(0, num) })
    }
    setEditingField(null)
  }

  function submitRating(itemId: string, eventId: string) {
    if (!ratingDraft.rating) return
    onRateEvent(itemId, eventId, ratingDraft.rating, ratingDraft.review || undefined)
    setRatingEventId(null)
    setRatingItemId(null)
    setRatingDraft({ rating: null, review: "" })
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel category-panel">
        <div className="panel-header">
          <div className="panel-header-top">
            <h2>{category}</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="icon-button panel-more-btn" aria-label="更多操作" onClick={() => setMoreOpen(!moreOpen)}><Icon name="more" /></button>
              <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
            </div>
          </div>
          <div className="panel-header-bottom">
            <span className="category-summary-text">{views.length} 项</span>
            <button className="primary-button" onClick={onAddItem}><Icon name="plus" />添加消耗品</button>
          </div>
          {moreOpen && (
            <div className="panel-more-popover">
              <button onClick={() => { setMoreOpen(false); onRename() }}>重命名</button>
              <button className="danger" onClick={() => { setMoreOpen(false); onDelete() }}>删除</button>
            </div>
          )}
        </div>
        <div className="category-item-list">
          {views.map(({ item, computed }) => (
            <div key={item.id} className={`category-item-group ${expandedId === item.id ? "is-expanded" : ""}`}>
              <button className={`category-item ${expandedId === item.id ? "is-expanded" : ""}`} onClick={() => toggleExpand(item, computed)}>
                <span className={`status-dot ${computed.displayStatus}`} />
                <span className="category-item-copy"><strong>{item.name}</strong><small>{computed.remainingText}</small></span>
                <span className={`status-label ${computed.displayStatus}`}>{computed.statusLabel}</span>
                <span className={`category-item-arrow ${expandedId === item.id ? "is-open" : ""}`}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg></span>
              </button>
              {expandedId === item.id && (
                <div className="category-item-detail">
                  {computed.status !== "normal" && (
                    <div className="category-detail-actions">
                      <TaskActions item={item} onPurchase={onPurchase} onRestock={onRestock} onSnooze={onSnooze} />
                    </div>
                  )}
                  <div className="detail-facts-bar">
                    <div className="detail-fact">
                      <span>补货间隔</span>
                      {editingField?.id === item.id && editingField.field === "cycleDays" ? (
                        <div className="inline-edit">
                          <div className="input-suffix"><input autoFocus type="number" min="1" value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => saveEditing(item)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEditing(item) } if (e.key === "Escape") setEditingField(null) }} /><b>天</b></div>
                        </div>
                      ) : (
                        <button className="detail-fact-edit" onClick={() => startEditing(item.id, "cycleDays", item.cycleDays)}><strong>约 {item.cycleDays} 天</strong><Icon name="edit" size={13} /></button>
                      )}
                    </div>
                    <div className="detail-fact">
                      <span>提前提醒</span>
                      {editingField?.id === item.id && editingField.field === "bufferDays" ? (
                        <div className="inline-edit">
                          <div className="input-suffix"><input autoFocus type="number" min="0" value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => saveEditing(item)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEditing(item) } if (e.key === "Escape") setEditingField(null) }} /><b>天</b></div>
                        </div>
                      ) : (
                        <button className="detail-fact-edit" onClick={() => startEditing(item.id, "bufferDays", item.bufferDays)}><strong>{item.bufferDays} 天</strong><Icon name="edit" size={13} /></button>
                      )}
                    </div>
                    <div className="detail-fact">
                      <span>上次补货</span>
                      <strong>{formatDate(item.lastRestockedAt)}</strong>
                    </div>
                  </div>
                  <div className="detail-purchase-info">
                    <h3 className="detail-section-title">购买信息</h3>
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
                    <div className="detail-link-row">
                      <span className="detail-link-label">常买平台</span>
                      {editingField?.id === item.id && editingField.field === "platform" ? (
                        <div className="inline-edit inline-edit-wide">
                          <select autoFocus value={editValue} onChange={(e) => { const v = e.target.value; onQuickEdit(item, { platform: v || undefined }); setEditingField(null) }} onBlur={() => setEditingField(null)}>
                            <option value="">未选择</option>
                            {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                      ) : (
                        <button className="detail-link-value" onClick={() => { setEditingField({ id: item.id, field: "platform" }); setEditValue(item.platform || "") }}>
                          {item.platform ? <span className="detail-link-text">{item.platform}</span> : <span className="detail-link-empty">未设置，点击添加</span>}
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
                                <div className="rating-options">
                                  <button className={ratingDraft.rating === 3 ? "active" : ""} onClick={() => setRatingDraft({ ...ratingDraft, rating: 3 })}>👍 好评</button>
                                  <button className={ratingDraft.rating === 2 ? "active" : ""} onClick={() => setRatingDraft({ ...ratingDraft, rating: 2 })}>😐 一般</button>
                                  <button className={ratingDraft.rating === 1 ? "active" : ""} onClick={() => setRatingDraft({ ...ratingDraft, rating: 1 })}>👎 差评</button>
                                </div>
                                <input type="text" value={ratingDraft.review} onChange={(e) => setRatingDraft({ ...ratingDraft, review: e.target.value })} placeholder="备注（选填）" />
                                <button className="primary-button compact" onClick={() => submitRating(item.id, event.id)} disabled={!ratingDraft.rating}>保存</button>
                                <button className="quiet-button compact" onClick={() => { setRatingEventId(null); setRatingItemId(null) }}>取消</button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="detail-link-row">
                    <span className="detail-link-label">商品链接</span>
                    {editingField?.id === item.id && editingField.field === "link" ? (
                      <div className="inline-edit inline-edit-wide">
                        <input autoFocus type="url" value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => saveEditing(item)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEditing(item) } if (e.key === "Escape") setEditingField(null) }} placeholder="https://" />
                      </div>
                    ) : (
                      <button className="detail-link-value" onClick={() => startEditing(item.id, "link", item.link || "")}>
                        {item.link ? <span className="detail-link-text">{item.link}</span> : <span className="detail-link-empty">未设置，点击添加</span>}
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                  </div>
                  {item.suggestedCycleDays && (
                    <div className="suggestion">
                      <span>最近几次大约每 {item.suggestedCycleDays} 天补一次，要把原来的 {item.cycleDays} 天改掉吗？</span>
                      <button onClick={() => onApplySuggestion(item)}>调整</button>
                      <button className="text-button" onClick={() => onDismissSuggestion(item)}>暂不</button>
                    </div>
                  )}
                </div>
              )}
            </div>
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

function ItemDetailPanel({ item, computed, onClose, onEdit, onSnooze, onPurchase, onRestock, onCalibrate, onApplySuggestion, onDismissSuggestion, onRateEvent }: {
  item: ReplenishmentItem
  computed: ItemComputed
  onClose: () => void
  onEdit: (item: ReplenishmentItem) => void
  onSnooze: (item: ReplenishmentItem) => void
  onPurchase: (item: ReplenishmentItem) => void
  onRestock: (item: ReplenishmentItem) => void
  onCalibrate: (item: ReplenishmentItem, remainingDays: number) => void
  onApplySuggestion: (item: ReplenishmentItem) => void
  onDismissSuggestion: (item: ReplenishmentItem) => void
  onRateEvent: (itemId: string, eventId: string, rating: Rating, review?: string) => void
}) {
  const [calibrating, setCalibrating] = useState(false)
  const [remainingDays, setRemainingDays] = useState(String(Math.max(0, computed.daysUntilDepletion)))
  const [ratingEventId, setRatingEventId] = useState<string | null>(null)
  const [ratingDraft, setRatingDraft] = useState<{ rating: Rating | null; review: string }>({ rating: null, review: "" })

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
    if (!ratingDraft.rating) return
    onRateEvent(item.id, eventId, ratingDraft.rating, ratingDraft.review || undefined)
    setRatingEventId(null)
    setRatingDraft({ rating: null, review: "" })
  }

  return (
    <div className="overlay detail-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel detail-panel">
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
              <TaskActions item={item} onPurchase={onPurchase} onRestock={onRestock} onSnooze={onSnooze} />
            </div>
          )}
        </div>

        {/* 关键信息网格 */}
        <div className="detail-stats">
          <div className="detail-stat">
            <span className="detail-stat-label">补货间隔</span>
            <strong className="detail-stat-value">约 {item.cycleDays} 天</strong>
          </div>
          <div className="detail-stat">
            <span className="detail-stat-label">提前提醒</span>
            <strong className="detail-stat-value">{item.bufferDays} 天</strong>
          </div>
          <div className="detail-stat">
            <span className="detail-stat-label">上次补货</span>
            <strong className="detail-stat-value">{formatDate(item.lastRestockedAt)}</strong>
          </div>
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
                      <div className="rating-options">
                        <button className={ratingDraft.rating === 3 ? "active" : ""} onClick={() => setRatingDraft({ ...ratingDraft, rating: 3 })}>👍 好评</button>
                        <button className={ratingDraft.rating === 2 ? "active" : ""} onClick={() => setRatingDraft({ ...ratingDraft, rating: 2 })}>😐 一般</button>
                        <button className={ratingDraft.rating === 1 ? "active" : ""} onClick={() => setRatingDraft({ ...ratingDraft, rating: 1 })}>👎 差评</button>
                      </div>
                      <input type="text" value={ratingDraft.review} onChange={(e) => setRatingDraft({ ...ratingDraft, review: e.target.value })} placeholder="备注（选填）" />
                      <div className="rating-form-actions">
                        <button className="quiet-button compact" onClick={() => setRatingEventId(null)}>取消</button>
                        <button className="primary-button compact" onClick={() => submitRating(event.id)} disabled={!ratingDraft.rating}>保存</button>
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
    <div className="overlay editor-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel editor-panel">
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

          {/* 购买信息 */}
          <div className="editor-section">
            <h3 className="editor-section-title">购买信息 <em>选填</em></h3>
            <label className="field field-wide"><span>常买的商品链接</span><input type="url" value={draft.link} onChange={(event) => set("link", event.target.value)} placeholder="https://" /></label>
            <label className="field">
              <span>常买平台</span>
              <select value={draft.platform} onChange={(event) => set("platform", event.target.value)}>
                <option value="">未选择</option>
                {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          {/* 高级选项 */}
          <div className="editor-section">
            <label className="learning-toggle field-wide"><input type="checkbox" checked={!draft.learningEnabled} onChange={(event) => set("learningEnabled", !event.target.checked)} /><span>不再给出补货间隔调整建议</span></label>
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

function SettingsPanel({ state, onChange, onClose }: { state: AppState; onChange: (state: AppState) => void; onClose: () => void }) {
  const settings = state.settings
  function patch(values: Partial<typeof settings>) {
    onChange({ ...state, settings: { ...settings, ...values } })
  }
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="panel settings-panel">
        <div className="panel-header"><h2>提醒与预算</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <div className="settings-body">
          <div className="settings-row"><span className="settings-row-label">每月生活预算</span><div className="settings-row-control"><div className="input-prefix budget-input"><b>¥</b><input aria-label="每月生活预算" type="number" min="0" step="100" value={settings.monthlyBudget ?? ""} onChange={(event) => patch({ monthlyBudget: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)) })} placeholder="未设置" /></div></div></div>
          <div className="settings-row"><span className="settings-row-label">重复提醒间隔</span><div className="settings-row-control"><div className="segment-control"><button className={settings.reminderIntervalMinutes === 30 ? "active" : ""} onClick={() => patch({ reminderIntervalMinutes: 30 })}>30 分钟</button><button className={settings.reminderIntervalMinutes === 60 ? "active" : ""} onClick={() => patch({ reminderIntervalMinutes: 60 })}>60 分钟</button></div></div></div>
          <div className="settings-row"><span className="settings-row-label">勿扰时段</span><div className="settings-row-control"><div className="time-range"><input type="time" value={settings.quietStart} onChange={(event) => patch({ quietStart: event.target.value })} /><span>至</span><input type="time" value={settings.quietEnd} onChange={(event) => patch({ quietEnd: event.target.value })} /></div></div></div>
          <div className="settings-row"><span className="settings-row-label">空闲后暂停提醒</span><div className="settings-row-control"><div className="input-suffix short"><input type="number" min="1" max="30" value={settings.idleThresholdMinutes} onChange={(event) => patch({ idleThresholdMinutes: Number(event.target.value) })} /><b>分钟</b></div></div></div>
          <div className="settings-row"><span className="settings-row-label">明天几点提醒</span><div className="settings-row-control"><div className="input-suffix short"><input type="number" min="0" max="23" value={settings.snoozeUntilHour} onChange={(event) => patch({ snoozeUntilHour: Number(event.target.value) })} /><b>点</b></div></div></div>
          <div className="settings-row"><span className="settings-row-label">系统通知</span><div className="settings-row-control"><button className="quiet-button" onClick={() => window.desktop?.testNotification()}>发送测试</button></div></div>
        </div>
      </aside>
    </div>
  )
}

export default App
