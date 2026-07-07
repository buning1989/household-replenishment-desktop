# 上线前修复 - 手动验证记录

> 日期：2026-06-22
> 分支：review/prelaunch-20260622
> 验证人：开发者

本文档记录无法在纯 Node 环境自动化的手动验证场景，主要涉及 Electron 主进程通知、React 组件交互和 IPC 通信。

---

## P1-1: 双数据源启动协调

### 验证 1：localStorage 损坏、主进程 JSON 正常

**步骤**：
1. 启动应用，添加若干物品，确保数据已持久化
2. 打开 DevTools → Application → Local Storage，手动修改 `household_replenishment_desktop_v1` 为非法 JSON（如 `{broken`）
3. 重启应用

**预期**：
- 应用正常启动，显示主进程 `reminder-state.json` 中的数据
- 控制台无报错
- DevTools 中 localStorage 仍保留损坏数据（已备份）

**状态**：✅ 已通过代码审查验证（reconcileState 在 localStorage 解析失败时返回 createInitialState，主进程数据有效时优先恢复）

### 验证 2：localStorage 为空、主进程 JSON 正常

**步骤**：
1. 启动应用，添加物品
2. 清空 localStorage（DevTools → Application → Clear storage）
3. 重启应用

**预期**：
- 应用显示主进程数据，不丢失

**状态**：✅ 已通过自动化测试验证（tests/prelaunch-fixes.test.ts）

### 验证 3：浏览器模式仍可正常启动和保存

**步骤**：
1. 运行 `npm run dev:web`
2. 在浏览器中打开应用，添加物品

**预期**：
- 应用正常启动，数据保存到 localStorage
- 无 window.desktop.loadState 调用

**状态**：✅ 已通过自动化测试验证（tests/prelaunch-fixes.test.ts - 浏览器模式测试）

---

## P1-2: 分类安全删除

### 验证 1：分类为空时直接删除

**步骤**：
1. 创建一个空分类
2. 在侧栏点击编辑 → 删除分类

**预期**：
- 弹出"删除该分类？"确认
- 点击删除后打开 CategoryManagerDialog
- 因 itemCount=0，直接显示"删除分类"按钮
- 点击后分类被删除

**状态**：✅ 已通过代码审查验证

### 验证 2：分类包含物品时必须选择移动或勾选删除

**步骤**：
1. 创建一个有物品的分类
2. 在侧栏点击编辑 → 删除分类

**预期**：
- 弹出"删除该分类？"确认
- 点击删除后打开 CategoryManagerDialog
- 显示两个选项：
  - "移动 N 项后删除"（选择目标分类后点击"移过去并删除"）
  - "同时删除里面的内容"（需勾选确认复选框后才能点击"全部删除"）
- 不会仅凭"确认删除？"直接删除全部内容

**状态**：✅ 已通过代码审查验证

### 验证 3：CategoryWorkArea 删除入口走同一套安全流程

**步骤**：
1. 进入有物品的分类页
2. 点击分类标题区域的删除按钮

**预期**：
- 打开 CategoryManagerDialog（而非直接删除）
- 走与侧栏相同的安全流程

**状态**：✅ 已通过代码审查验证

---

## P1-3: 正常状态直接补货

### 验证 1：正常状态、无常购商品的物品能打开 RestockModal

**步骤**：
1. 创建一个物品（不添加常购商品）
2. 在分类页找到该物品
3. 点击物品行中的"记录补货"按钮

**预期**：
- 打开 RestockModal
- 可输入数量和价格
- 点击"确认补货"后完成补货

**状态**：✅ 已通过自动化测试验证 domain 层（tests/prelaunch-fixes.test.ts），UI 交互需手动验证

### 验证 2：有常购商品时两种补货入口都正常

**步骤**：
1. 创建一个有常购商品的物品
2. 在分类页展开该物品
3. 点击"记录补货"按钮 → 打开 RestockModal
4. 关闭后，点击常购商品卡片的"按此选项补货" → 打开 RestockModal 并自动选中该商品

**预期**：
- 两种入口都能打开 RestockModal
- "按此选项补货"会自动选中对应商品

**状态**：⏳ 需手动验证

---

## P1-4: onboarding 重新运行去重

### 验证 1：已存在的物品显示"已在管理"

**步骤**：
1. 完成 onboarding，创建若干物品
2. 进入设置 → 重新运行 onboarding
3. 在推荐清单步骤查看已存在的物品

**预期**：
- 已存在的物品显示"已在管理"标签
- 不显示"管理 / 暂不管理 / 我家不用"按钮
- 显示提示："重新设置只会补充新增物品，不会删除你已经管理的物品和历史记录"

**状态**：✅ 已通过代码审查验证

### 验证 2：完成向导后只添加新增物品

**步骤**：
1. 重新运行 onboarding
2. 选择一些新物品（非"已在管理"的）
3. 完成向导

**预期**：
- 只添加新选择的物品
- 已存在的物品和历史记录不受影响

**状态**：✅ 已通过自动化测试验证去重逻辑（tests/prelaunch-fixes.test.ts）

---

## P1-5: 周期建议确认与撤销

### 验证 1：补货后 cycleDays 不变，suggestedCycleDays 被设置

**步骤**：
1. 创建一个学习型物品，cycleDays=30
2. 等待 30+ 天后补货（记录 intervalDays）
3. 再等待 30+ 天后第二次补货

**预期**：
- 补货后 cycleDays 仍为 30
- suggestedCycleDays 被设置为候选值
- 补货回执条出现，显示周期建议

**状态**：✅ 已通过自动化测试验证（tests/prelaunch-fixes.test.ts）

### 验证 2：点击"调整"后 cycleDays 更新

**步骤**：
1. 在补货回执条中点击"调整"

**预期**：
- cycleDays 更新为 suggestedCycleDays
- suggestedCycleDays 清空

**状态**：✅ 已通过代码审查验证（applyCycleSuggestion 处理器）

### 验证 3：点击"暂不"后 cycleDays 不变

**步骤**：
1. 在补货回执条中点击"暂不"

**预期**：
- cycleDays 保持原值
- suggestedCycleDays 清空

**状态**：✅ 已通过代码审查验证（dismissSuggestion 处理器）

### 验证 4：撤销补货后物品完整恢复

**步骤**：
1. 补货后点击撤销按钮

**预期**：
- history、cycleDays、inventoryDepletionAt、lastRestockedAt、confidence、snoozeUntil 全部恢复为补货前状态

**状态**：✅ 已通过自动化测试验证快照恢复逻辑（tests/prelaunch-fixes.test.ts）

### 验证 5：固定周期或关闭学习的物品不生成建议

**步骤**：
1. 创建一个 learningEnabled=false 的物品
2. 多次补货

**预期**：
- 不生成 suggestedCycleDays
- cycleDays 保持不变

**状态**：✅ 已通过自动化测试验证（tests/prelaunch-fixes.test.ts）

---

## P2: 预算勿扰和四档阈值

### 验证 1：预算通知遵守勿扰时段

**步骤**：
1. 设置预算为 ¥100
2. 设置勿扰时段为 22:00-08:00
3. 在 23:00 时补货使消费达到 50%

**预期**：
- 不发送通知（在勿扰时段内）
- 第二天 08:00 后的检查会发送通知

**状态**：✅ 已通过自动化测试验证 inQuietHours 逻辑（tests/budget-logic.test.mjs），系统通知发送需手动验证

### 验证 2：90% 后达到 100% 仍触发"预算已用完"提醒

**步骤**：
1. 设置预算为 ¥100
2. 补货使消费达到 ¥90（90%）
3. 再补货使消费达到 ¥100（100%）

**预期**：
- 90% 时发送"本月预算即将用完"通知
- 100% 时发送"本月预算已用完"通知（不会因为都是 "urgent" 级别而跳过）

**状态**：✅ 已通过自动化测试验证状态机逻辑（tests/budget-logic.test.mjs）

### 验证 3：月份变化后重置当月提醒状态

**步骤**：
1. 在某月达到 100% 预算
2. 跨入下个月

**预期**：
- 下个月第一次达到 50% 时会发送通知（状态已重置）

**状态**：✅ 已通过自动化测试验证 monthKey 逻辑（tests/budget-logic.test.mjs）

### 验证 4：同一月份、同一阈值不重复通知

**步骤**：
1. 达到 50% 预算
2. 等待 1 分钟（setInterval 触发 checkBudgetNotification）

**预期**：
- 不会重复发送 50% 通知

**状态**：✅ 已通过自动化测试验证状态机逻辑（tests/budget-logic.test.mjs）

### 验证 5：预算清空后状态复位

**步骤**：
1. 达到 90% 预算
2. 清空预算设置（monthlyBudget = 0 或 undefined）

**预期**：
- lastBudgetNotificationLevel 重置为空
- 重新设置预算后，达到 50% 会正常触发

**状态**：✅ 已通过代码审查验证（checkBudgetNotification 中 budget <= 0 时重置）

---

## 尚未验证的风险

1. **Electron 系统通知实际发送**：自动化测试验证了状态机逻辑，但未验证 `new Notification({...}).show()` 在 macOS/Windows 上的实际行为。需在打包后的应用中手动验证。

2. **跨日期边界的实际运行**：未实际跨越午夜/月初验证 `differenceInDays` 和 `getBudgetMonthKey` 的边界行为，但代码使用 UTC 整除和 Date 构造函数逻辑正确。

3. **长时间运行后的内存泄漏**：未做长时间运行测试，`setInterval` 每分钟触发 `checkReminders` 和 `checkBudgetNotification` 看起来无泄漏风险。

4. **IPC 通信异常**：`state:load` IPC 的异常处理已在 reconcileState 中通过 try-catch 兜底，但未模拟主进程崩溃场景。

---

## AgentPlan 第一阶段验证

> 日期：2026-07-07
> 关联文档：docs/agent-action-routing.md
> 验证目标：建分类 / 设预算 / 改周期走 planProposal，旧 Draft 流程不变形，loading 不重复，订单截图不残留假消息。

### 验证 A1：建分类（planProposal → confirm 写入）

**步骤**：
1. 打开 403管家对话框
2. 输入 "新建一个猫咪用品分类"
3. 检查对话返回
4. 输入 "确认"

**预期**：
- 第 2 步返回 `AgentPlanCard`，标题"准备处理"，列 1 条动作"新建分类「猫咪用品」"
- 卡片显示"先不处理"和"就这么执行"两个按钮
- 此时分类的 state **未变化**（侧栏不出现"猫咪用品"）
- 第 4 步后：原卡片标题变为"已执行"，新增一条 assistant 消息"已新建分类：猫咪用品。"，侧栏出现"猫咪用品"分类

### 验证 A2：设置预算（planProposal → confirm 写入）

**步骤**：
1. 输入 "这个月预算设成 500"
2. 检查卡片
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"本月预算设为 ¥500"
- 此前 budget state **未变化**
- 第 3 步后：新增 assistant 消息"已设置本月预算：¥500。"，打开设置面板可见月预算显示 500

### 验证 A3：修改周期（planProposal → 修订 → confirm）

**步骤**：
1. state 中已有"猫砂"（周期 14 天）
2. 输入 "猫砂周期改成 30 天"
3. 输入 "周期改成 20 天"（修订）
4. 输入 "确认"

**预期**：
- 第 2 步返回 `AgentPlanCard`，列 1 条动作"修改「猫砂」：周期 30 天"
- 第 3 步返回新 `AgentPlanCard`，标题含"我按你说的改了一下"，列"修改「猫砂」：周期 20 天"；原卡片标题变为"已替代"
- 第 4 步后：新增 assistant 消息"已修改：消耗品「猫砂」。"，打开猫砂详情可见周期 20 天

### 验证 A4：保持旧 Draft 流程（restock 不回退）

**步骤**：
1. state 中已有"猫砂"
2. 输入 "帮我加一袋猫砂"
3. 输入 "45"（补价格）
4. 输入 "确认"

**预期**：
- 第 2 步返回 `AgentDraftCard`（旧卡片，非 `AgentPlanCard`），草稿 kind=restock
- 卡片 receipt 行显示"猫砂 × 1袋 · ¥45"等已填字段
- 第 3 步草稿价格补为 45，新卡片标题"我按你说的改了一下"
- 第 4 步后：新增 assistant 消息"已记录：猫砂 本次补货。"，猫砂详情出现新补货记录

### 验证 A5：loading 不重复（双气泡修复）

**步骤**：
1. 输入任意需要等待的回答（如未配置 AI Key 时输入"今天优先补什么"，或上传订单截图）
2. 观察等待过程中的气泡

**预期**：
- 只出现一个 loading 指示：
  - sync 路径：一个 transient message（带"我看一下当前记录。"等场景化文案，灰色），不出现底部三点 loading 气泡
  - LLM 路径：一个 transient message，不出现底部三点 loading 气泡
  - 订单截图：一个 transient message"我看一下这张订单。"，不出现底部三点 loading 气泡
- 最终结果返回后，transient 消息被替换，不残留

### 验证 A6：订单截图 transient 不残留

**步骤**：
1. 上传一张订单截图
2. 等待识别完成
3. 观察消息列表

**预期**：
- 识别过程中：用户消息（含缩略图）+ transient"我看一下这张订单。"（灰色，仅一个气泡）
- 识别完成后：transient 消失，被识别结果消息替换（含 orderImportRows）
- 历史消息中不残留"我看一下这张订单。"假消息

### 验证 A7：planProposal 取消

**步骤**：
1. 输入 "新建一个宠物用品分类"
2. 点"先不处理"按钮（或输入"算了"）

**预期**：
- 卡片标题变为"已取消"
- state 中不出现"宠物用品"分类
- 不新增 assistant 消息

### 验证 A8：planProposal 与查询不冲突

**步骤**：
1. 输入 "新建一个宠物用品分类"（生成 pendingPlan）
2. 不确认，直接输入 "猫砂还剩多少"

**预期**：
- 第 2 步返回 answer（query 路径，调 LLM 或 quick answer）
- 原 pendingPlan 卡片状态不变（仍是 pending，可继续确认或取消）
- 不生成新 plan 覆盖旧 plan

### 验证 A9：planProposal 被 superseded

**步骤**：
1. 输入 "新建一个宠物用品分类"（pendingPlan 1）
2. 不确认，直接输入 "新建一个猫咪用品分类"

**预期**：
- 第 2 步返回新 `AgentPlanCard`（猫咪用品）
- 原 pendingPlan 1 卡片标题变为"已替代"
- state 中无任何分类（两次都没写入）

### 验证 A10：AgentPlanCard 状态检查点（组件级）

如果未来引入 React 组件测试框架，以下检查点需覆盖：
1. pending 状态显示"先不处理"和"就这么执行"按钮，aria-label 正确
2. confirmed 状态不显示按钮，显示"已写入。点上方链接查看。"
3. cancelled 状态不显示按钮，标题"已取消"
4. superseded 状态不显示按钮，标题"已替代"
5. plan 含多 action 时按 `<ol>` 顺序展示，每个 `<li>` 含动作摘要
6. 点"就这么执行"调用 `onConfirm` → `confirmAgentPlan` → `commitAgentPlan`
7. 点"先不处理"调用 `onCancel` → `cancelAgentPlan`（不写 state）
8. cancelled/superseded 状态的按钮不重复触发

当前无 React 组件测试环境，以上检查点在手动 QA 中验证。

