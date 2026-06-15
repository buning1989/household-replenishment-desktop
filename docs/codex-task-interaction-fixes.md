# 优化任务：补货闭环与数据保护

## 背景与定位

本应用「403家庭管家」是一个安静的家庭补货提醒桌面应用（Electron + React + TypeScript + Vite），目录为 `household-replenishment-desktop/`。核心资产是每个物品的补货历史（`history`），它是周期学习机制（`domain.ts` 中 `weightedCycle` / `restockItem`）的数据源。本次优化目标：**修复真实使用场景中的交互断裂，防止脏数据进入补货历史**。不引入新依赖，不做架构重构，保持现有文案的「家庭管家」语气（亲切、口语化，避免库存管理术语）。

涉及文件：`src/App.tsx`、`src/domain.ts`、`src/types.ts`、`src/store.ts`、`electron/main.js`。

## 任务清单（按顺序实施）

### 1. 增加「已下单 / 在路上」中间态（最重要）

现状：用户收到提醒后点「去补货」打开购买链接（`App.tsx` 的 `openPurchase`），但下单后到货前的 1~3 天里，物品仍处于急需状态，每 30/60 分钟被重复提醒；若用户提前点「已补到家」，会把错误日期写入 `lastRestockedAt` 污染学习数据。

要求：
- 在 `ReplenishmentItem` 上新增可选字段 `orderedAt?: number`（下单时间）。
- 用户点「去补货」打开链接后，在应用内以非阻塞方式（参考现有 `restock-receipt` 回执条的形态）询问「下单了吗？」，确认则写入 `orderedAt`。
- 处于已下单状态的物品：主进程 `main.js` 的 `getDueItems` 不再将其计入提醒；界面上在原状态标签旁显示「在路上」之类的提示，待办区的主操作变为「已补到家」。
- 下单超过 3 天仍未确认到货时，恢复提醒，提醒文案改为确认到货语气（如「卫生纸到货了吗？」）。
- 点「已补到家」时清除 `orderedAt`。
- 注意 `electron/main.js` 与 `src/domain.ts` 中的到期判定逻辑是两份独立实现，两边都要同步修改。

### 2. 「已补到家」可撤销

现状：`handleRestock` 立即重写 `lastRestockedAt` 并追加 history 记录，误点无法挽回，且没有任何 UI 可删除历史记录。

要求：
- 在补货后弹出的回执条（`recentRestock` 区块）中增加「撤销」按钮，点击后恢复该物品补货前的完整状态（`lastRestockedAt`、`history`、`anchorEstimated`、`snoozeUntil`、`suggestedCycleDays` 全部还原）。
- 实现方式建议：`handleRestock` 时把补货前的 item 快照存入 `recentRestock` 状态，撤销即写回快照。回执条关闭（点 X、保存金额或被下一次补货顶替）后撤销机会消失，可接受。

### 3. 任意状态下都能记录补货

现状：详情面板的操作区被 `computed.status !== "normal"` 守卫，物品「充足」时无法记录补货，导致「打折顺手多买」这类场景没有入口。

要求：
- 详情面板（`ItemDetailPanel`）在任何状态下都显示「已补到家」按钮；「去补货」「稍后提醒」仍可保持仅非充足状态显示。

### 4. 剩余天数可随时校准

现状：「手头这些大概还能用多久」只在新建时可填（`ItemEditor` 中 `!item &&` 限制），估算偏差后用户无法纠偏。

要求：
- 在详情面板增加轻量校准入口（如「不太准？改一下还能用几天」），输入天数后按 `createItem` 中的锚点算法反推：`lastRestockedAt = addDays(now, -(cycleDays - remainingDays))`，并设置 `anchorEstimated = true`（校准产生的锚点是估算值，不应计入下一次的间隔学习）。
- 校准不追加 history 记录。

### 5. 修复名称输入静默覆盖周期

现状：`ItemEditor` 的 `handleName` 在每次按键时用 `DEFAULT_CYCLES` 匹配并重写 `cycleDays`。编辑已有物品时改名会把学习校准过的周期覆盖成出厂默认；新建时用户先改周期再改名也会被静默重置。

要求：
- 周期预填只在以下条件同时满足时触发：是新建（`item` 为 null）、且用户尚未手动修改过周期字段（用一个 touched 标记跟踪）。
- 编辑已有物品时改名绝不改动 `cycleDays`。

### 6. 浮层支持 Esc 关闭

现状：所有面板（分组、详情、编辑、设置）只能点遮罩外关闭。

要求：
- 按 Esc 关闭最上层浮层（层级顺序：编辑/设置 > 详情 > 分组）。编辑器内有未保存输入时 Esc 直接关闭也可接受，与点遮罩行为保持一致即可。

## 约束

- 不修改 `household-consumables-miniapp/`（历史小程序，禁止触碰）。
- 不引入新的 npm 依赖。
- 保持现有数据结构向后兼容：新字段全部可选，`store.ts` 的 `loadState` 需容忍旧数据中不存在的字段。
- 文案风格与现有一致（如「已补到家」「快用完了」），不要出现「库存」「SKU」等词。

## 验收

- `npm run typecheck` 通过，`npm run build` 成功。
- 手动核对场景：
  1. 点「去补货」→ 确认已下单 → 物品不再触发系统提醒、显示在路上状态 → 点「已补到家」恢复正常周期。
  2. 误点「已补到家」→ 回执条点「撤销」→ `lastRestockedAt` 与 history 与点击前完全一致。
  3. 充足物品的详情面板可以记录补货。
  4. 编辑物品改名后周期值不变。
  5. 旧版 localStorage 数据加载后应用正常运行。
