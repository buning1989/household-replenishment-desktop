# 技术 Review 报告

> 项目：household-replenishment-desktop（403家庭管家）
> 审查日期：2026-06-18
> 审查范围：src/、electron/、package.json、tsconfig.json、vite.config.ts 等核心文件

---

## 一、总体判断

当前项目功能层面已基本成型，但工程质量存在明显问题，**不建议直接上线**。最严重的问题是 `App.tsx` 中存在违反 React Hooks 规则的代码（会导致运行时崩溃），以及补货流程完全绕过了 `domain.ts` 中的核心学习逻辑（`restockItem` 从未被调用），导致产品的"自动学习补货周期"这一核心卖点实际上已经失效。同时存在大量死代码，说明前一个开发者在重构补货弹窗时没有清理旧逻辑，新旧两套流程并存且互相冲突。架构层面，3158 行的 `App.tsx` 承载了几乎所有 UI 和业务逻辑，缺乏模块拆分，Electron 主进程没有 CSP、没有导航拦截、文件写入是非原子的同步操作，存在安全和数据一致性风险。最大技术债是**补货流程的双轨制和死代码**，最值得优先修复的方向是**统一补货流程、修复 Hooks 违规、清理死代码**。

---

## 二、P0 / P1 严重问题

### P0-1：`ItemEditorDialog` 违反 React Hooks 规则，会触发运行时崩溃

- **问题位置**：[src/App.tsx:1863-1866](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L1863-L1866)
- **问题类型**：代码质量 / 稳定性
- **严重程度**：P0
- **具体问题**：

```tsx
function ItemEditorDialog({ item, categories, isOpen, ... }) {
  if (!isOpen || !item) return null   // ← 条件 return 在 hooks 之前

  const [name, setName] = useState(item.name)        // ← hook 在条件 return 之后
  const [category, setCategory] = useState(item.category)
```

- **为什么是问题**：React 要求组件每次渲染时 hooks 的调用顺序必须一致。当 `isOpen` 从 `false` 变为 `true` 时，React 会检测到"本次渲染比上次多调用了 hooks"，直接抛出 `Rendered fewer hooks than expected` 错误，整个应用白屏。
- **可能后果**：用户点击侧栏的"编辑物品"按钮时，应用直接崩溃白屏，必须重启。
- **修复建议**：将 hooks 移到条件 return 之前。

---

### P0-2：补货流程完全绕过 `restockItem`，学习型补货周期建议功能失效

- **问题位置**：
  - [src/App.tsx:655-677](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L655-L677)
  - [src/App.tsx:341-363](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L341-L363)
  - [src/domain.ts:137-159](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/domain.ts#L137-L159)
- **问题类型**：数据一致性 / 业务逻辑
- **严重程度**：P0
- **具体问题**：`restockItem` 是 domain 层的核心函数，负责计算 `intervalDays`、生成 `suggestedCycleDays`、清除 `snoozeUntil`、设置 `anchorEstimated: false`、用 `startOfDay(now)` 规范化 `lastRestockedAt`。但实际补货代码直接构造 `RestockEvent` 并 `updateItems`，完全没有调用 `restockItem`。
- **为什么是问题**：
  1. `intervalDays` 永远是 `undefined` → `weightedCycle` 无法计算 → 永远不会生成 `suggestedCycleDays`
  2. 补货后 `snoozeUntil` 不会被清除
  3. `lastRestockedAt` 用 `Date.now()` 而非 `startOfDay(now)`
- **可能后果**：产品的核心差异化功能（学习型补货）静默失效。
- **修复建议**：所有补货路径统一调用 `restockItem`。

---

### P0-3：`recentRestock` 整条流程是死代码

- **问题位置**：
  - [src/App.tsx:86](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L86)
  - [src/App.tsx:205-236](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L205-L236)
- **问题类型**：可维护性 / 死代码
- **严重程度**：P0
- **具体问题**：`setRecentRestock` 在整个代码库中只被赋值为 `null`，从未被赋值为非 null 值。
- **修复建议**：删除 `recentRestock` 相关的所有代码。

---

### P0-4：`handleConfirmRestock` 是死代码

- **问题位置**：
  - [src/App.tsx:417-448](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L417-L448)
  - [src/App.tsx:90-92](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L90-L92)
- **问题类型**：可维护性 / 死代码
- **严重程度**：P0
- **具体问题**：`handleConfirmRestock` 依赖的三个 state 从未被 `RestockModal` 使用。
- **修复建议**：删除相关代码。

---

### P0-5：双数据源可能数据丢失

- **问题位置**：
  - [src/store.ts:4](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/store.ts#L4)
  - [electron/main.js:28-47](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/electron/main.js#L28-L47)
- **问题类型**：数据一致性
- **严重程度**：P0
- **具体问题**：渲染进程读 `localStorage`，主进程读 `reminder-state.json`，localStorage 被清理后 demo 数据会覆盖真实数据。
- **修复建议**：以 `reminder-state.json` 为唯一数据源，`persistState` 中捕获异常。

---

### P1-1：Electron 安全配置不完整

- **问题位置**：[index.html](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/index.html)
- **问题类型**：安全
- **严重程度**：P1
- **具体问题**：没有 Content-Security-Policy、没有拦截 `will-navigate`、没有设置 `setWindowOpenHandler`。
- **修复建议**：添加 CSP meta 和导航拦截。

---

### P1-2：主进程状态变更同步写文件，可能阻塞 UI

- **问题位置**：[electron/main.js:32-39](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/electron/main.js#L32-L39)
- **问题类型**：性能
- **严重程度**：P1
- **具体问题**：`fs.writeFileSync` 是同步阻塞操作，写入不是原子操作。
- **修复建议**：改为异步写 + 防抖 + 原子写入。

---

### P1-3：没有任何测试

- **问题位置**：整个项目
- **问题类型**：可维护性 / 质量保障
- **严重程度**：P1
- **具体问题**：没有 `.test.ts` / `.spec.ts` 文件，`domain.ts` 中核心函数完全没有测试覆盖。
- **修复建议**：至少为 `domain.ts` 添加单元测试。

---

### P1-4：`App.tsx` 3158 行，单文件巨石架构

- **问题位置**：[src/App.tsx](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx)
- **问题类型**：架构 / 可维护性
- **严重程度**：P1
- **具体问题**：单文件包含 App 根组件 + 至少 15 个子组件。
- **修复建议**：按功能拆分为 `components/`、`hooks/`、`data/` 目录。

---

### P1-5：生产代码中残留 `console.log`

- **问题位置**：[src/App.tsx:604](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L604)、[L618](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L618)、[L626](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L626)
- **问题类型**：代码质量
- **严重程度**：P1
- **修复建议**：删除这三行 `console.log`。

---

### P1-6：设置项无输入校验

- **问题位置**：[src/App.tsx:1715-1718](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L1715-L1718)
- **问题类型**：异常处理
- **严重程度**：P1
- **具体问题**：`quietStart/End` 非法格式导致勿扰时段失效。
- **修复建议**：在 `persistState` / `loadState` 时做 schema 校验。

---

### P1-7：没有 Windows 构建脚本

- **问题位置**：[package.json:15](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/package.json#L15)
- **问题类型**：部署风险
- **严重程度**：P1
- **具体问题**：`scripts` 中只有 `package:mac`，没有 `package:win`。
- **修复建议**：添加 `"package:win": "npm run build && electron-builder --win nsis"`

---

## 三、P2 / P3 中低优先级问题

### P2-1：`domain.ts` 中 1300+ 行硬编码 demo 数据
- **问题位置**：[src/domain.ts:221-L1352](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/domain.ts#L221)
- **修复建议**：将 demo 数据移到 `data/demoData.ts`。

### P2-2：`addCardStateDemoItems` 会重复注入 demo 物品
- **问题位置**：[src/store.ts:29-46](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/store.ts#L29)
- **修复建议**：用版本号控制。

### P2-3：ID 生成方式不统一
- **问题位置**：[src/domain.ts:17-19](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/domain.ts#L17) vs [src/App.tsx:347](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L347)
- **修复建议**：统一使用 `crypto.randomUUID()`。

### P2-4：`window.confirm` 原生对话框，UX 不一致
- **问题位置**：[src/App.tsx:405](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L405) 等多处
- **修复建议**：统一使用自定义确认弹窗组件。

### P2-5：`persistState` 无防抖，频繁触发
- **问题位置**：[src/App.tsx:146-148](file:///Users/ning/Documents/Codex/生活小管家/household-replenishment-desktop/src/App.tsx#L146)
- **修复建议**：对 `persistState` 加 debounce（300-500ms）。

### P2-6：没有 ESLint / Prettier 配置
- **修复建议**：添加 ESLint + Prettier 配置。

---

## 四、架构层面的判断

当前架构**不适合项目继续发展**，主要瓶颈如下：

1. **单文件巨石架构**：3158 行的 `App.tsx` 包含所有组件、状态管理、业务逻辑。
2. **状态管理缺乏抽象**：所有状态都在 `App` 组件中通过 `useState` 管理。
3. **业务逻辑与 UI 耦合**：`domain.ts` 中的 `restockItem` 是正确的业务逻辑入口，但 UI 层绕过了它。
4. **数据层薄弱**：没有数据访问层抽象。
5. **Electron 主进程缺乏结构**：`main.js` 是平铺脚本，没有模块拆分。

---

## 五、上线前必须检查清单

- [ ] **修复 `ItemEditorDialog` 的 Hooks 违规**（P0-1）
- [ ] **统一补货流程为 `restockItem`**（P0-2）
- [ ] **清理 `recentRestock` / `handleConfirmRestock` 死代码**（P0-3、P0-4）
- [ ] **修复双数据源问题**（P0-5）
- [ ] **添加 CSP 和导航拦截**（P1-1）
- [ ] **删除 `console.log`**（P1-5）
- [ ] **验证设置项边界输入**（P1-6）
- [ ] **添加 Windows 构建脚本**（P1-7）
- [ ] **手动测试完整补货流程**

---

## 六、建议的修复顺序

### 第一阶段：必须立刻修（阻断性问题）

1. **修复 `ItemEditorDialog` Hooks 违规**（P0-1）—— 5 分钟
2. **统一补货流程调用 `restockItem`**（P0-2）—— 1-2 小时
3. **删除 `recentRestock`、`handleConfirmRestock` 等死代码**（P0-3、P0-4）—— 1 小时
4. **删除 `console.log`**（P1-5）—— 2 分钟

### 第二阶段：上线前建议修

5. **`persistState` 加异常捕获 + 防抖**（P0-5、P2-5）—— 30 分钟
6. **主进程 `saveState` 改异步 + 原子写入**（P1-2）—— 1 小时
7. **添加 CSP meta 和导航拦截**（P1-1）—— 30 分钟
8. **设置项输入校验**（P1-6）—— 1 小时
9. **添加 Windows 构建脚本**（P1-7）—— 10 分钟
10. **为 `domain.ts` 核心函数添加单元测试**（P1-3）—— 3-4 小时

### 第三阶段：后续迭代优化

11. **拆分 `App.tsx`**（P1-4）—— 2-3 天
12. **引入状态管理方案**（P2-9）—— 1-2 天
13. **统一数据源为主进程文件**（P0-5 彻底解决）—— 1-2 天
14. **添加 ESLint / Prettier**（P2-10）—— 1 小时
