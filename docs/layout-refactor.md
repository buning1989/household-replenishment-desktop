# 布局重构方案：左侧导航 + 右侧工作区

## 目标结构

```
┌─ topbar (52px，全宽) ──────────────────────────────────┐
│  🐱                                            ⚙        │
├─ sidebar (220px) ─┬─ work-area (1fr) ──────────────────┤
│  ✓ 今天不用补货   │                                     │
│  ─────────────   │  （首页：当前待处理卡片列表）         │
│  分类             │  （分类：消耗品列表 + 操作）          │
│  ○ 厨房     4    │                                     │
│  ○ 卫生间   2    │                                     │
│  ● 宠物     1    │                                     │
│  + 新建分类       │                                     │
└──────────────────┴─────────────────────────────────────┘
```

- topbar 只显示猫咪图标 + 设置按钮，**不显示应用名称文字**
- 左侧导航持久显示，点击分类直接在右侧切换内容，无弹层
- ItemDetailPanel、ItemEditor、SettingsPanel、CategoryCreator 保持 overlay 不变

---

## 回滚方式

```bash
git checkout 17c45f3 -- .
```

---

## 文件变更范围

| 文件 | 变更类型 |
|------|----------|
| `src/App.tsx` | 布局重组、新增 Sidebar 组件、CategoryPanel 改内联 |
| `src/styles.css` | 移除旧固定定位 topbar、新增 sidebar/work-area 样式 |

其余文件（domain、store、types、所有子组件内部逻辑）**不变**。

---

## src/App.tsx

### 1. 删除滚动动画

删除：
- `const brandTitleRef = useRef<HTMLHeadingElement>(null)`
- 监听 `window.scroll` 修改 `brandTitleRef` opacity/transform/filter 的整个 `useEffect`

### 2. 删除 Escape 键关闭分类

在 `closeTopPanel` 的 `useEffect` 里，删除：
```ts
else if (activeCategory) setActiveCategory(null)
// 或 else if (activeCategory) deferredClose(setCategoryPanelClosing, () => setActiveCategory(null))
```

### 3. 替换顶层 JSX

旧结构（删除）：
```jsx
<div className="app-shell">
  <header className="topbar">
    <div className="brand-block">
      <div className="brand-mark">...</div>
      <h1 className="brand-title" ref={brandTitleRef}>403家庭管家</h1>
    </div>
    <div className="top-actions">...</div>
  </header>
  <main>
    <CurrentTasks ... />
    <section className="category-section home-category-section" ...>
      <div className="category-grid">
        {categorySummaries.map(... <CategoryCard> ...)}
      </div>
    </section>
  </main>
  {activeCategory && <CategoryPanel ... />}   {/* ← 删除此行 */}
  {detailItem && <ItemDetailPanel ... />}
  ...
</div>
```

新结构（替换）：
```jsx
<div className="app-shell">
  <header className="topbar">
    <div className="brand-mark">
      <img src={catIcon} alt="家庭管家" className="brand-cat" />
    </div>
    <div className="top-actions">
      <button className="icon-button" aria-label="提醒设置" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" />
      </button>
    </div>
  </header>

  <div className="app-body">
    <Sidebar
      dueCount={dueItems.length}
      categorySummaries={categorySummaries}
      activeCategory={activeCategory}
      onSelectCategory={setActiveCategory}
      onCreateCategory={() => setCategoryCreatorOpen(true)}
    />
    <main className="work-area">
      {activeCategory ? (
        <CategoryWorkArea
          category={activeCategory}
          views={itemViews.filter(({ item }) => item.category === activeCategory)}
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
      ) : (
        <CurrentTasks
          items={dueItems}
          recentRestock={recentRestock}
          allItems={itemViews}
          onPurchase={openPurchase}
          onRestock={handleRestock}
          onSnooze={handleSnooze}
          onUpdateRestock={(patch) => setRecentRestock((c) => c ? { ...c, ...patch } : c)}
          onSaveRestock={saveRestockAmount}
          onUndoRestock={undoRestock}
          onDismissRestock={() => setRecentRestock(null)}
          onApplySuggestion={applyCycleSuggestion}
          onDismissSuggestion={dismissSuggestion}
          onOpenItem={openItem}
        />
      )}
    </main>
  </div>

  {/* overlays — 全部保留，不改动 */}
  {detailItem && <ItemDetailPanel ... />}
  {editingItem !== undefined && <ItemEditor ... />}
  {settingsOpen && <SettingsPanel ... />}
  {categoryCreatorOpen && <CategoryCreator ... />}
  {activeCategory && categoryDialog && <CategoryManagerDialog ... />}
</div>
```

### 4. 新增 Sidebar 组件

添加在文件末尾 `export default App` 之前：

```tsx
function Sidebar({ dueCount, categorySummaries, activeCategory, onSelectCategory, onCreateCategory }: {
  dueCount: number
  categorySummaries: Array<{ category: string; views: ItemView[]; urgent: number; warning: number }>
  activeCategory: string | null
  onSelectCategory: (category: string | null) => void
  onCreateCategory: () => void
}) {
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
        return (
          <button
            key={category}
            className={`sidebar-item ${activeCategory === category ? "is-active" : ""}`}
            onClick={() => onSelectCategory(category)}
          >
            <span className={`sidebar-dot ${dotStatus}`} />
            <span className="sidebar-item-name">{category}</span>
            <span className="sidebar-item-count">{views.length}</span>
          </button>
        )
      })}

      <div className="sidebar-divider" />
      <button className="sidebar-add" onClick={onCreateCategory}>
        <Icon name="plus" size={13} />
        新建分类
      </button>
    </nav>
  )
}
```

### 5. 新增 CategoryWorkArea 组件

`CategoryWorkArea` 的 props 签名和全部内部逻辑（state、事件处理）与现有 `CategoryPanel` **完全相同**，只替换最外层容器：

- `CategoryPanel` 外层是 `<div className="overlay"><aside className="panel category-panel">...</aside></div>`
- `CategoryWorkArea` 外层改为 `<div className="category-work-area">...</div>`

内部结构：

```tsx
function CategoryWorkArea({ category, views, onAddItem, onRename, onDelete, ...samePropsAsCategoryPanel }) {
  // 完整复制 CategoryPanel 的所有 state：
  // expandedId, editingField, editValue, unitCustomId,
  // ratingEventId, ratingItemId, ratingDraft, moreOpen
  // 以及 toggleExpand, startEditing, saveEditing, submitRating 函数

  return (
    <div className="category-work-area">
      {/* header */}
      <div className="work-header">
        <div className="work-header-left">
          <h2 className="work-title">{category}</h2>
          <span className="work-meta">{views.length} 项</span>
        </div>
        <div className="work-header-right">
          <div style={{ position: "relative" }}>
            <button className="icon-button" aria-label="更多操作" onClick={() => setMoreOpen(!moreOpen)}>
              <Icon name="more" />
            </button>
            {moreOpen && (
              <div className="work-more-popover">
                <button onClick={() => { setMoreOpen(false); onRename() }}>重命名</button>
                <button className="danger" onClick={() => { setMoreOpen(false); onDelete() }}>删除</button>
              </div>
            )}
          </div>
          <button className="primary-button" onClick={onAddItem}>
            <Icon name="plus" />添加消耗品
          </button>
        </div>
      </div>

      {/* item list — 完整复制 CategoryPanel 中 <div className="category-item-list"> 的内容 */}
      <div className="work-item-list">
        {views.map(({ item, computed }) => (
          // 与 CategoryPanel 内的 category-item-group 完全相同
        ))}
        {!views.length && <div className="empty-category">这个分类还没有记录</div>}
      </div>
    </div>
  )
}
```

---

## src/styles.css

### 1. 替换/删除旧布局样式

删除或替换以下规则：

```css
/* 删除 */
.app-shell { min-height: 100vh; padding: 106px 24px 72px; }

/* 删除（固定定位透明浮动行，不再使用） */
.top-row { position: fixed; top: 0; ... pointer-events: none; ... }
.top-actions, .top-row > .brand-mark { pointer-events: auto; }

/* 删除（work-area 替代 main 的居中布局） */
main { max-width: 1040px; margin: 24px auto 0; }
.current-section { max-width: 1040px; margin: 30px auto 0; }

/* 删除（分类网格移至侧边栏，不再需要） */
.category-section, .home-category-section, .category-heading,
.section-heading, .category-grid { ... }
```

### 2. 新增布局样式

```css
/* ===== 整体布局 ===== */
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.topbar {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}
.topbar button, .topbar input { -webkit-app-region: no-drag; }

.brand-mark {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  background: transparent;
}
.brand-cat { width: 30px; height: 30px; object-fit: contain; }

.app-body {
  display: grid;
  grid-template-columns: 220px 1fr;
  flex: 1;
  overflow: hidden;
}

/* ===== Sidebar ===== */
.sidebar {
  border-right: 1px solid var(--line);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 10px 8px;
  gap: 2px;
}

.sidebar-home {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: var(--radius-small);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font-size: 13px;
  color: var(--ink);
  transition: background .12s;
}
.sidebar-home.is-active { background: var(--paper); border-color: var(--line); }
.sidebar-home:not(.is-active):hover { background: var(--hover); }
.sidebar-home-icon { width: 18px; height: 18px; display: grid; place-items: center; flex-shrink: 0; color: var(--muted); }
.sidebar-home-label { font-size: 12.5px; font-weight: 500; }
.sidebar-due-badge {
  min-width: 18px; height: 18px; border-radius: 9px;
  background: var(--urgent); color: #fff;
  font-size: 10px; font-weight: 700;
  display: grid; place-items: center; padding: 0 4px;
}

.sidebar-divider { height: 1px; background: var(--line); margin: 6px 2px; flex-shrink: 0; }
.sidebar-section-label {
  font-size: 10px; font-weight: 600; color: var(--faint);
  letter-spacing: .06em; padding: 4px 10px 2px;
  text-transform: uppercase;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-small);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font-size: 13px;
  color: var(--ink);
  transition: background .12s;
}
.sidebar-item.is-active { background: var(--paper); border-color: var(--line); }
.sidebar-item:not(.is-active):hover { background: var(--hover); }
.sidebar-dot { width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid #aaa; flex-shrink: 0; }
.sidebar-dot.warning { background: var(--warning); border-color: var(--warning); }
.sidebar-dot.urgent { background: var(--urgent); border-color: var(--urgent); }
.sidebar-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-item-count { font-size: 11px; color: var(--faint); flex-shrink: 0; }

.sidebar-add {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font-size: 12.5px;
  color: var(--faint);
  border-radius: var(--radius-small);
  transition: color .12s, background .12s;
}
.sidebar-add:hover { color: var(--ink); background: var(--hover); }

/* ===== Work Area ===== */
.work-area {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--paper);
}

/* 首页 CurrentTasks 在 work-area 内的 padding */
.work-area .current-section {
  max-width: 100%;
  margin: 0;
  padding: 24px 28px;
  overflow-y: auto;
  flex: 1;
}
.work-area .empty-current {
  padding: 24px 28px;
}

/* 分类工作区 */
.category-work-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.work-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  gap: 12px;
  background: var(--paper);
}
.work-header-left { display: flex; align-items: baseline; gap: 10px; }
.work-title { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }
.work-meta { font-size: 13px; color: var(--faint); }
.work-header-right { display: flex; align-items: center; gap: 8px; position: relative; }

.work-more-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  width: 140px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-small);
  background: var(--paper);
}
.work-more-popover button {
  display: block; width: 100%; text-align: left;
  padding: 7px 10px; border: 0; border-radius: 6px;
  background: transparent; font-size: 13px; color: var(--ink); cursor: pointer;
}
.work-more-popover button:hover { background: var(--hover); }
.work-more-popover button.danger { color: var(--urgent); }

.work-item-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 24px;
  display: flex;
  flex-direction: column;
  gap: 0;
}
```

---

## 验收标准

1. `npx tsc --noEmit` 无报错
2. topbar 只显示猫咪图标 + 设置按钮，无文字
3. 左侧导航持久显示所有分类，状态圆点准确反映 urgent/warning/normal
4. 点击分类名 → 右侧切换为该分类消耗品列表，无弹层
5. 点击"今天不用补货" → 右侧切回待处理视图
6. 添加/编辑消耗品、设置面板仍以 overlay 方式弹出
7. 分类重命名、删除对话框正常工作
