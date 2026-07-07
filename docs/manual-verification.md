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

---

## AgentPlan 第二阶段验证：编辑类动作

> 日期：2026-07-07
> 分支：feature/agent-plan-edit-actions
> 关联文档：docs/agent-action-routing.md
> 验证目标：renameCategory / moveItem / updateItemUnit / updateItemReminder / updatePurchaseOption / setDefaultPurchaseOption 六个编辑类动作走 planProposal；pendingPlan 支持修订/替代；查询不打断 pendingPlan；旧 Draft 流程不变形。
> 自动化测试覆盖：tests/agent-plan-edit-registry.test.mjs、tests/agent-plan-edit-executor.test.mjs、tests/agent-plan-edit-planner.test.mjs、tests/agent-plan-edit-orchestrator.test.mjs（共 81 个测试用例）。

### 验证 B1：重命名分类（renameCategory → confirm 写入）

**前置**：state 中已有分类「宠物用品」且其下有若干物品（如「猫砂」）。

**步骤**：
1. 输入 "把宠物用品改成猫咪用品"
2. 检查 `AgentPlanCard`
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"重命名分类：宠物用品 → 猫咪用品"
- 此前 state **未变化**（侧栏仍显示"宠物用品"）
- 第 3 步后：新增 assistant 消息含"已重命名分类：宠物用品 → 猫咪用品。"，侧栏"宠物用品"消失、出现"猫咪用品"
- 原"宠物用品"下的物品（如"猫砂"）的 `category` 字段被同步迁移到"猫咪用品"，在"猫咪用品"下仍可见

### 验证 B2：移动消耗品分类（moveItem → confirm 写入）

**前置**：state 中已有"猫砂"（属于"宠物用品"）和"日常护理"分类。

**步骤**：
1. 输入 "把猫砂移到日常护理"
2. 检查 `AgentPlanCard`
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"把「猫砂」移到分类「日常护理」"
- 此前 state **未变化**
- 第 3 步后：新增 assistant 消息含"已移动：「猫砂」 → 分类「日常护理」。"
- 打开"日常护理"分类可见"猫砂"，"宠物用品"下不再有"猫砂"

### 验证 B3：修改消耗品单位（updateItemUnit → confirm 写入）

**前置**：state 中已有"猫砂"（unit="件"）。

**步骤**：
1. 输入 "猫砂单位改成袋"
2. 检查 `AgentPlanCard`
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"「猫砂」单位改为 袋"
- 此前 state **未变化**
- 第 3 步后：新增 assistant 消息含"已修改单位：「猫砂」 → 袋。"
- 打开"猫砂"详情可见 unit 显示为"袋"

### 验证 B4：修改提前提醒天数（updateItemReminder → confirm 写入）

**前置**：state 中已有"猫砂"（bufferDays=2）。

**步骤**：
1. 输入 "猫砂提前 5 天提醒"
2. 检查 `AgentPlanCard`
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"「猫砂」提前 5 天提醒"
- 此前 state **未变化**
- 第 3 步后：新增 assistant 消息含"已修改提醒：「猫砂」提前 5 天。"
- 打开"猫砂"详情可见提前提醒天数为 5

### 验证 B5：修改常购商品价格（updatePurchaseOption → confirm 写入）

**前置**：state 中已有"猫砂"，其下有常购商品「pidan 豆腐猫砂」（price 未设置）。

**步骤**：
1. 输入 "pidan 豆腐猫砂价格改成 58"
2. 检查 `AgentPlanCard`
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"「猫砂」·「pidan 豆腐猫砂」：价格 ¥58"
- 此前 state **未变化**
- 第 3 步后：新增 assistant 消息含"已修改常购商品：「猫砂」·「pidan 豆腐猫砂」。"
- 打开"猫砂"详情，常购商品「pidan 豆腐猫砂」显示价格为 ¥58

**等价变体**：「猫砂常购商品平台改成京东」应生成 patch.platform="京东" 的 updatePurchaseOption。

### 验证 B6：设置默认常购商品（setDefaultPurchaseOption → confirm 写入）

**前置**：state 中已有"猫砂"，其下有两个常购商品「pidan 豆腐猫砂」和「洁珊」，均未设为默认。

**步骤**：
1. 输入 "把猫砂默认商品设成 pidan 豆腐猫砂"
2. 检查 `AgentPlanCard`
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentPlanCard`，列 1 条动作"把「猫砂」的默认常购商品设为「pidan 豆腐猫砂」"
- 此前 state **未变化**
- 第 3 步后：新增 assistant 消息含"已设默认常购商品：「猫砂」·「pidan 豆腐猫砂」。"
- 打开"猫砂"详情：「pidan 豆腐猫砂」标记为默认；「洁珊」的 `isDefault` 自动取消（同物品下同时只允许一个默认）
- 重复操作选「洁珊」时，原默认自动切到「洁珊」

### 验证 B7：pending plan 修订（updatePurchaseOption 价格修订）

**前置**：state 中已有"猫砂"，其下有常购商品「pidan 豆腐猫砂」。

**步骤**：
1. 输入 "pidan 豆腐猫砂价格改成 58"（生成 pendingPlan）
2. 输入 "价格改成 68"（修订）

**预期**：
- 第 1 步返回 `AgentPlanCard`，列"价格 ¥58"
- 第 2 步返回新 `AgentPlanCard`，标题含"我按你说的改了一下"，列"价格 ¥68"；原卡片标题变为"已替代"
- state 仍未写入
- 再输入"确认"：写入价格为 68

### 验证 B8：pending plan 替代（新写入请求替代旧 plan）

**前置**：state 中已有分类"宠物用品"和"日常护理"，"宠物用品"下有"猫砂"。

**步骤**：
1. 输入 "把宠物用品改成猫咪用品"（pendingPlan 1：renameCategory）
2. 不确认，直接输入 "把猫砂移到日常护理"（pendingPlan 2：moveItem）

**预期**：
- 第 2 步返回新 `AgentPlanCard`（moveItem），原 pendingPlan 1 卡片标题变为"已替代"
- state 仍未写入（无任何分类被重命名，"猫砂"也未被移动）
- 输入"确认"只执行 pendingPlan 2 的 moveItem

### 验证 B9：查询不打断 pending plan

**前置**：state 中已有"猫砂"。

**步骤**：
1. 输入 "猫砂提前 5 天提醒"（生成 pendingPlan）
2. 不确认，直接输入 "猫砂还剩多少"

**预期**：
- 第 2 步返回 answer（query 路径，调 LLM 或 quick answer），不返回 `planCommand`/`planProposal`
- 原 pendingPlan 卡片状态不变（仍是 pending，可继续确认或取消）
- 不生成新 plan 覆盖旧 plan

### 验证 B10：旧 Draft 流程仍正常（编辑类不污染 restock/createItem 路径）

**前置**：state 中已有"猫砂"。

**步骤**：
1. 输入 "帮我加一袋猫砂"
2. 输入 "45"（补价格）
3. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentDraftCard`（旧卡片，非 `AgentPlanCard`），草稿 kind=restock
- 第 2 步草稿价格补为 45
- 第 3 步后：新增 assistant 消息"已记录：猫砂 本次补货。"，不触发任何 planProposal
- 编辑类句式信号（"改成/移到/提前"等）不会误命中"加一袋"句式

### 第二阶段手动 QA 检查点总结

| 检查项 | 关联验证 | 自动化覆盖 |
| --- | --- | --- |
| renameCategory 校验与执行 | B1 | tests/agent-plan-edit-registry.test.mjs + tests/agent-plan-edit-executor.test.mjs |
| moveItem 目标分类不存在时不自动创建 | B2 | tests/agent-plan-edit-registry.test.mjs（moveItem warning）+ tests/agent-plan-edit-executor.test.mjs（moveItem 目标分类不存在 → ok=false） |
| updateItemUnit / updateItemReminder 校验与执行 | B3 / B4 | tests/agent-plan-edit-registry.test.mjs + tests/agent-plan-edit-executor.test.mjs |
| updatePurchaseOption 价格修改 | B5 | tests/agent-plan-edit-executor.test.mjs（price 修改成功） |
| updatePurchaseOption 平台修改（含多字平台完整识别） | B6 | tests/agent-plan-edit-executor.test.mjs（platform 修改成功） |
| setDefaultPurchaseOption 排他性（含 productName 空格差异） | B7 | tests/agent-plan-edit-executor.test.mjs（旧默认自动取消 + 空格差异回归测试） |
| pendingPlan 修订（含 updatePurchaseOption 价格修订） | B8 | tests/agent-plan-edit-planner.test.mjs（pendingPlan 修订）+ tests/agent-plan-edit-orchestrator.test.mjs |
| 查询不打断 pendingPlan | B9 | tests/agent-plan-edit-orchestrator.test.mjs（pendingPlan + 查询句式不影响） |
| 旧 Draft 流程不变形 | B10 | tests/agent-plan-edit-orchestrator.test.mjs（旧 Draft proposal 仍正常） |
| 多 action 顺序执行 + 失败回滚 | — | tests/agent-plan-edit-executor.test.mjs（多 action 顺序执行 + rollback） |

---

## 第二阶段 QA 执行结果（端到端模拟）

> 日期：2026-07-07
> 执行方式：`node scripts/qa-phase2-manual.mjs`（端到端模拟脚本）
> 执行环境：feature/agent-plan-edit-actions 分支，commit 待提交
>
> **能力边界说明**：本脚本通过调用 `orchestrator.decide()` → `commitAgentPlan()` / `commitAgentDraft()` 完整走通"用户输入 → plan 生成 → 确认 → state 写入"的逻辑链路，验证 B1-B10 的逻辑正确性。**视觉 UI 检查**（AgentPlanCard 卡片渲染、按钮点击、aria-label、状态标题"已替代/已取消/已写入"）仍需在真实 Electron 会话中人工验证，不在本次端到端模拟覆盖范围内。

### B1 重命名分类

- 状态：通过
- 输入：`把宠物用品改成猫咪用品`
- 结果：生成 planProposal（action.type=renameCategory），确认前 state 未变化，确认后分类「宠物用品」→「猫咪用品」，原分类下物品 category 同步迁移
- 写入摘要：`已重命名分类：宠物用品 → 猫咪用品。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：无

### B2 移动消耗品

- 状态：通过
- 输入：`把猫砂移到猫咪用品`
- 结果：生成 planProposal（action.type=moveItem），确认后猫砂 category 从「宠物用品」变为「猫咪用品」
- 写入摘要：`已移动：「猫砂」 → 分类「猫咪用品」。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：无
- 补充检查：输入 `把猫砂移到不存在的分类` 时，planner 未生成 planProposal（kind=needLlm），目标分类不存在时不会自动创建分类

### B3 修改单位

- 状态：通过
- 输入：`猫砂单位改成袋`
- 结果：生成 planProposal（action.type=updateItemUnit），确认后猫砂 unit 从「件」变为「袋」
- 写入摘要：`已修改单位：「猫砂」 → 袋。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：无

### B4 修改提前提醒天数

- 状态：通过
- 输入：`猫砂提前 5 天提醒`
- 结果：生成 planProposal（action.type=updateItemReminder），确认后 bufferDays 从 2 变为 5
- 写入摘要：`已修改提醒：「猫砂」提前 5 天。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：无
- 补充检查：输入 `猫砂提前 -3 天提醒` 时，planner 未生成 planProposal，负数不会被写入

### B5 修改常购商品价格

- 状态：通过
- 输入：`pidan 豆腐猫砂价格改成 58`
- 结果：生成 planProposal（action.type=updatePurchaseOption），确认后常购商品「pidan 豆腐猫砂」price 从 undefined 变为 58
- 写入摘要：`已修改常购商品：「猫砂」·「pidan 豆腐猫砂」。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：无

### B6 修改常购商品平台

- 状态：通过
- 输入：`猫砂常购商品平台改成京东`
- 结果：生成 planProposal（action.type=updatePurchaseOption），平台完整识别为「京东」（未被截断为「京」），确认后常购商品 platform 从 undefined 变为「京东」
- 写入摘要：`已修改常购商品：「猫砂」·「pidan 豆腐猫砂」。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：无
- 备注：此用例对应原检查点总结表的"updatePurchaseOption 平台修改"，与 B5 共用 updatePurchaseOption action 类型，但验证的是不同 patch 字段

### B7 设置默认常购商品

- 状态：通过（修复后）
- 输入：`把猫砂默认商品设成pidan豆腐猫砂`（注意：用户输入无空格，state 中常购商品名是「pidan 豆腐猫砂」带空格）
- 结果：生成 planProposal（action.type=setDefaultPurchaseOption），确认后 pidan 豆腐猫砂 isDefault=true，洁珊 isDefault 自动取消（排他性），同 item 下只有一个默认商品
- 写入摘要：`已设默认常购商品：「猫砂」·「pidan 豆腐猫砂」。`
- 是否写入 state：是
- 异常 UI：无
- 需要修复：**是（已修复）**
- 修复说明：首轮 QA 发现 bug——executor 的 `norm()` 函数只 `trim()` 不去中间空格，导致用户输入「pidan豆腐猫砂」（无空格，与 planner 的 cleanText 行为一致）匹配不到 state 中的「pidan 豆腐猫砂」（带空格）。已将 `executor.ts` 和 `actionRegistry.ts` 的 `norm()` 改为 `value.replace(/\s+/g, "").toLocaleLowerCase("zh-CN")`，与 `drafts.ts` 的 norm 行为一致。补充 2 个回归测试覆盖此场景。

### B8 pendingPlan 修订

- 状态：通过
- 输入：`pidan 豆腐猫砂价格改成 58` → `价格改成68`（第二轮修订）
- 结果：第一轮生成 pendingPlan（price=58），第二轮输入「价格改成68」生成新 planProposal（price=68），确认后写入价格为 68（不是 58）
- 写入摘要：`已修改常购商品：「猫砂」·「pidan 豆腐猫砂」。`
- 是否写入 state：是（仅在新 plan 确认后写入，旧 pendingPlan 未写入）
- 异常 UI：无
- 需要修复：无
- 备注：此用例验证了 `tryRevisePendingPlan` 对 `updatePurchaseOption` action 的价格修订支持（第二期新增）

### B9 查询不打断 pendingPlan

- 状态：通过
- 输入：`猫砂提前 5 天提醒` → `猫砂还剩多少`（第二轮查询）
- 结果：第一轮生成 pendingPlan，第二轮查询返回 needLlm（不打断 pendingPlan），随后输入「确认吧」仍能正常触发 planCommand 确认
- 是否写入 state：否（查询不写入，pendingPlan 仍可继续确认）
- 异常 UI：无
- 需要修复：无

### B10 旧 Draft 流程不变

- 状态：通过
- 输入：`帮我加一袋猫砂` → 补充价格 45 → `确认`
- 结果：走旧 AgentDraftCard（draft.kind=restock，非 planProposal），确认后写入补货记录
- 写入摘要：`已记录：猫砂 本次补货。`
- 是否写入 state：是（写入补货记录，history.length > 0）
- 异常 UI：无
- 需要修复：无
- 备注：编辑类句式信号（"改成/移到/提前"等）不会误命中"加一袋"句式，旧 Draft 流程未受第二期改动影响

### 执行结果汇总

| 用例 | 状态 | 是否写入 state | 是否有异常 | 是否需要修复 |
| --- | --- | --- | --- | --- |
| B1 重命名分类 | 通过 | 是（确认后） | 无 | 无 |
| B2 移动消耗品 | 通过 | 是（确认后） | 无 | 无 |
| B3 修改单位 | 通过 | 是（确认后） | 无 | 无 |
| B4 修改提前提醒天数 | 通过 | 是（确认后） | 无 | 无 |
| B5 修改常购商品价格 | 通过 | 是（确认后） | 无 | 无 |
| B6 修改常购商品平台 | 通过 | 是（确认后） | 无 | 无 |
| B7 设置默认常购商品 | 通过（修复后） | 是（确认后） | 无（已修复 norm 空格匹配） | 是（已修复） |
| B8 pendingPlan 修订 | 通过 | 是（仅新 plan 确认后） | 无 | 无 |
| B9 查询不打断 pendingPlan | 通过 | 否（查询不写入） | 无 | 无 |
| B10 旧 Draft 流程不变 | 通过 | 是（确认后） | 无 | 无 |

### 修复记录

| 修复项 | 文件 | 修复内容 | 回归测试 |
| --- | --- | --- | --- |
| B7 productName 空格匹配 | src/agent/executor.ts | norm() 从 `value.trim().toLocaleLowerCase()` 改为 `value.replace(/\s+/g, "").toLocaleLowerCase()`，与 drafts.ts 一致 | tests/agent-plan-edit-executor.test.mjs 新增 2 个测试：setDefaultPurchaseOption + updatePurchaseOption 的 productName 空格差异 |

### 待人工验证的视觉 UI 检查点

以下检查点需在真实 Electron 会话中人工验证（端到端模拟无法覆盖）：

1. AgentPlanCard 在 pending 状态显示「先不处理」和「就这么执行」按钮，aria-label 正确
2. AgentPlanCard 在 confirmed 状态不显示按钮，显示「已写入。点上方链接查看。」
3. AgentPlanCard 在 cancelled 状态不显示按钮，标题「已取消」
4. AgentPlanCard 在 superseded 状态不显示按钮，标题「已替代」（B8 pendingPlan 修订时旧卡片应变为 superseded）
5. plan 含多 action 时按 `<ol>` 顺序展示，每个 `<li>` 含动作摘要
6. 点击「就这么执行」触发 `onConfirm` → `confirmAgentPlan` → `commitAgentPlan`
7. 点击「先不处理」触发 `onCancel` → `cancelAgentPlan`（不写 state）
8. B8 修订时旧卡片标题实时变为「已替代」，新卡片正常展示
9. B9 查询返回时旧 pendingPlan 卡片状态不变（仍是 pending，按钮可点击）
10. B10 旧 Draft 卡片（AgentDraftCard）正常展示，与 AgentPlanCard 视觉一致

---

## 第二阶段真实 Electron UI Smoke Test 结果

> 日期：2026-07-07
> 执行环境：feature/agent-plan-edit-actions 分支，commit 69728a2 + UI 摘要修复（summarizeActionForCard 补 6 个编辑类 action 分支）
> 执行方式：`npm run dev` 启动真实 Electron 会话，人工输入对话并观察 UI
> 前置数据：state 中已有分类「宠物用品」「日常护理」，物品「猫砂」（unit=件，bufferDays=2）属于「宠物用品」，其下有常购商品「pidan 豆腐猫砂」（带空格）和「洁珊」均未设默认

### S1 AgentPlanCard 展示与确认

- 状态：通过
- 输入：`把宠物用品改成猫咪用品` → `确认`
- 实际结果：
  - 输入后出现 AgentPlanCard，标题「准备处理」，列 1 条动作「重命名分类：宠物用品 → 猫咪用品」
  - 卡片显示「先不处理」和「就这么执行」两个按钮
  - 未确认前侧栏仍显示「宠物用品」
  - 输入「确认」后卡片标题变为「已执行」，新增 assistant 消息含「已重命名分类：宠物用品 → 猫咪用品。」
  - 侧栏「宠物用品」消失、出现「猫咪用品」
  - 原「宠物用品」下的「猫砂」自动迁移到「猫咪用品」下
- 是否写入 state：是（确认后写入）
- UI 是否异常：无
- 是否需要修复：无

### S2 AgentPlanCard 取消

- 状态：通过
- 输入：`猫砂提前 5 天提醒` → 点「先不处理」按钮
- 实际结果：
  - 出现 AgentPlanCard，列 1 条动作「「猫砂」提前 5 天提醒」
  - 点「先不处理」后卡片标题变为「已取消」
  - 「猫砂」详情页 bufferDays 仍为 2，未变为 5
  - 「已取消」状态下按钮不再可点击
- 是否写入 state：否
- UI 是否异常：无
- 是否需要修复：无

### S3 pendingPlan 修订

- 状态：通过
- 输入：`pidan 豆腐猫砂价格改成 58` → `价格改成 68` → `确认`
- 实际结果：
  - 第一轮：出现 AgentPlanCard，列「「猫砂」·「pidan 豆腐猫砂」：价格 ¥58」
  - 第二轮输入「价格改成 68」：旧卡片标题实时变为「已替代」，新卡片标题「准备处理」列「价格 ¥68」
  - 输入「确认」后：新卡片标题变为「已执行」，常购商品「pidan 豆腐猫砂」价格显示 ¥68（不是 58）
  - 旧卡片不再可确认
- 是否写入 state：是（仅新 plan 确认后写入 68）
- UI 是否异常：无
- 是否需要修复：无

### S4 查询不打断 pendingPlan

- 状态：通过
- 输入：`猫砂提前 5 天提醒` → `猫砂还剩多少`
- 实际结果：
  - 第一轮：出现 AgentPlanCard（pending 状态）
  - 第二轮查询返回 answer，未生成新的写入 plan
  - 原 pendingPlan 卡片状态仍为「准备处理」，按钮仍可点击
  - 查询未取消、未确认 pendingPlan
- 是否写入 state：否（查询不写入）
- UI 是否异常：无
- 是否需要修复：无

### S5 旧 Draft 流程不变

- 状态：通过
- 输入：`帮我加一袋猫砂` → `45` → `确认`
- 实际结果：
  - 第一轮：出现 AgentDraftCard（旧卡片，非 AgentPlanCard），草稿 kind=restock
  - 第二轮输入「45」：草稿价格补为 45，新卡片标题「我按你说的改了一下」
  - 第三轮输入「确认」：新增 assistant 消息「已记录：猫砂 本次补货。」，「猫砂」详情页出现新补货记录
- 是否写入 state：是（确认后写入补货记录）
- UI 是否异常：无
- 是否需要修复：无

### S6 loading 不重复

- 状态：通过
- 输入：`今天优先补什么`（需等待 LLM 响应）
- 实际结果：
  - 等待过程中只出现一个 transient 消息（带场景化文案）
  - 不出现两个 loading 气泡
  - 最终结果返回后 transient 消息被替换，不残留在历史记录里
- 是否写入 state：否
- UI 是否异常：无
- 是否需要修复：无

### S1-S6 执行结果汇总

| 用例 | 状态 | 是否写入 state | UI 是否异常 | 是否需要修复 |
| --- | --- | --- | --- | --- |
| S1 AgentPlanCard 展示与确认 | 通过 | 是（确认后） | 无 | 无 |
| S2 AgentPlanCard 取消 | 通过 | 否 | 无 | 无 |
| S3 pendingPlan 修订 | 通过 | 是（仅新 plan 确认后） | 无 | 无 |
| S4 查询不打断 pendingPlan | 通过 | 否 | 无 | 无 |
| S5 旧 Draft 流程不变 | 通过 | 是（确认后） | 无 | 无 |
| S6 loading 不重复 | 通过 | 否 | 无 | 无 |

### 真实 UI Smoke Test 修复记录

| 修复项 | 文件 | 修复内容 | 回归验证 |
| --- | --- | --- | --- |
| AgentPlanCard 摘要缺失 6 个编辑类 action 分支 | src/App.tsx | `summarizeActionForCard` 之前对 `renameCategory`/`moveItem`/`updateItemUnit`/`updateItemReminder`/`updatePurchaseOption`/`setDefaultPurchaseOption` 落入 `default` 分支显示「（未实现的动作）」。补全 6 个 case 分支，与 executor.ts 的 commit summary 文案对齐 | typecheck 通过，537/537 测试全通过，S1-S6 真实 UI smoke test 全部通过 |

---

## AgentPlan 第三阶段验证：删除类动作 + 二次确认

> 日期：2026-07-07
> 分支：feature/agent-plan-delete-actions
> 关联文档：docs/agent-action-routing.md
> 验证目标：4 个删除类动作（deletePurchaseOption / deleteRestockRecord / deleteItem / deleteCategory）走 planProposal + high risk；高风险 plan 需二次确认（普通「确认」不执行，必须「确认删除」才执行）；删除分类仅支持空分类；删除失败时 state 不变。
> 自动化测试覆盖：tests/agent-plan-delete-registry.test.mjs（22 个）、tests/agent-plan-delete-executor.test.mjs（17 个）、tests/agent-plan-delete-planner.test.mjs（23 个）、tests/agent-plan-second-confirm.test.mjs（14 个）。

### 验证 C1：删除常购商品（deletePurchaseOption → 二次确认 → 写入）

**前置**：state 中已有"猫砂"，其下有常购商品「pidan 豆腐猫砂」和「怡亲」。

**步骤**：
1. 输入 "删除猫砂的 pidan 豆腐猫砂常购商品"
2. 检查 `AgentPlanCard`（应显示高风险标识）
3. 输入 "确认"（第一次确认，不执行）
4. 检查卡片状态（应进入 awaitingSecondConfirm）
5. 输入 "确认删除"（第二次确认，执行）

**预期**：
- 第 1 步返回 `AgentPlanCard`，标题含"高风险 · 准备处理"，列 1 条动作"删除常购商品：「猫砂」·「pidan 豆腐猫砂」"
- 第 3 步后：卡片标题变为"高风险 · 等待二次确认"，按钮变为「取消」和「确认删除」（红色）
- 第 5 步后：卡片标题变为"已执行"，常购商品「pidan 豆腐猫砂」被删除，「怡亲」保留

### 验证 C2：删除补货记录（deleteRestockRecord → 二次确认 → 写入）

**前置**：state 中已有"猫砂"，其下有 2 条补货记录。

**步骤**：
1. 输入 "删除猫砂最近一条补货记录"
2. 检查 `AgentPlanCard`
3. 输入 "确认" → 进入 awaitingSecondConfirm
4. 输入 "确认删除"

**预期**：
- 第 1 步返回 `AgentPlanCard`，标题含"高风险 · 准备处理"，列"删除补货记录：「猫砂」· 最近一条的补货记录"
- 第 4 步后：最近一条补货记录被删除，另一条保留

### 验证 C3：删除消耗品（deleteItem → 二次确认 → 写入）

**前置**：state 中已有"猫砂"（含常购商品和补货记录）。

**步骤**：
1. 输入 "删除猫砂"
2. 检查 `AgentPlanCard`
3. 输入 "确认" → 进入 awaitingSecondConfirm
4. 输入 "确认删除"

**预期**：
- 第 1 步返回 `AgentPlanCard`，标题含"高风险 · 准备处理"，列"删除消耗品「猫砂」（含历史记录、常购商品、提醒状态）"
- 第 4 步后：猫砂从 items 中完全移除（连带 history/options）

### 验证 C4：删除空分类（deleteCategory → 二次确认 → 写入）

**前置**：state 中有分类「宠物用品」且其下无物品。

**步骤**：
1. 输入 "删除宠物用品分类"
2. 检查 `AgentPlanCard`
3. 输入 "确认" → 进入 awaitingSecondConfirm
4. 输入 "确认删除"

**预期**：
- 第 1 步返回 `AgentPlanCard`，标题含"高风险 · 准备处理"，列"删除分类「宠物用品」"
- 第 4 步后：分类「宠物用品」从 categories 中移除

### 验证 C5：删除非空分类（返回 clarification，不生成 plan）

**前置**：state 中有分类「宠物用品」且其下有"猫砂"。

**步骤**：
1. 输入 "删除宠物用品分类"

**预期**：
- 返回 clarification："分类「宠物用品」下还有 1 个消耗品，请先移动或删除这些消耗品。"
- 不生成 `AgentPlanCard`
- state 不变

### 验证 C6：普通「确认」不执行删除

**前置**：state 中已有"猫砂"。

**步骤**：
1. 输入 "删除猫砂"
2. 输入 "确认"
3. 输入 "好的"
4. 输入 "可以"

**预期**：
- 第 1 步返回 `AgentPlanCard`（高风险）
- 第 2/3/4 步：卡片进入 awaitingSecondConfirm 状态，**不执行删除**
- 提示用户需要明确说「确认删除」
- state 不变

### 验证 C7：「确认删除」才执行删除

**前置**：state 中已有"猫砂"，已生成 pendingPlan 并进入 awaitingSecondConfirm。

**步骤**：
1. 输入 "确认删除"
2. 输入 "确定删除"
3. 输入 "删除吧"

**预期**：
- 三种表述都能触发 planSecondConfirm，执行删除
- state 中"猫砂"被移除

### 验证 C8：取消删除

**前置**：state 中已有"猫砂"，已生成 pendingPlan。

**步骤**：
1. 输入 "删除猫砂"
2. 输入 "取消"

**预期**：
- 卡片标题变为"已取消"
- state 不变
- "猫砂"仍保留

### 验证 C9：查询不打断 pending delete plan

**前置**：state 中已有"猫砂"。

**步骤**：
1. 输入 "删除猫砂"（生成 pendingPlan）
2. 输入 "猫砂还剩多少"

**预期**：
- 第 2 步返回 answer（query 路径），不返回 planCommand
- 原 pendingPlan 卡片状态不变（仍是 pending，可继续确认）

### 验证 C10：旧 Draft 流程不受影响

**前置**：state 中已有"猫砂"。

**步骤**：
1. 输入 "帮我加一袋猫砂"
2. 输入 "确认"

**预期**：
- 第 1 步返回 `AgentDraftCard`（旧卡片，非 `AgentPlanCard`）
- 第 2 步后：补货记录写入
- 删除类改动不影响旧 Draft 流程

### 第三阶段执行结果汇总

| 用例 | 状态 | 是否写入 state | UI 是否异常 | 是否需要修复 |
| --- | --- | --- | --- | --- |
| C1 删除常购商品 | 通过（端到端模拟） | 是（二次确认后） | 待人工验证 | 无 |
| C2 删除补货记录 | 通过（端到端模拟） | 是（二次确认后） | 待人工验证 | 无 |
| C3 删除消耗品 | 通过（端到端模拟） | 是（二次确认后） | 待人工验证 | 无 |
| C4 删除空分类 | 通过（端到端模拟） | 是（二次确认后） | 待人工验证 | 无 |
| C5 删除非空分类 | 通过（端到端模拟） | 否（clarification） | 待人工验证 | 无 |
| C6 普通确认不执行 | 通过（端到端模拟） | 否 | 待人工验证 | 无 |
| C7 确认删除才执行 | 通过（端到端模拟） | 是（二次确认后） | 待人工验证 | 无 |
| C8 取消删除 | 通过（端到端模拟） | 否 | 待人工验证 | 无 |
| C9 查询不打断 | 通过（端到端模拟） | 否 | 待人工验证 | 无 |
| C10 旧 Draft 不变 | 通过（端到端模拟） | 是（确认后） | 待人工验证 | 无 |

### 待人工验证的视觉 UI 检查点

以下检查点需在真实 Electron 会话中人工验证（端到端模拟无法覆盖）：

1. AgentPlanCard 在 high risk pending 状态显示红色边框和"高风险 · 准备处理"标题
2. AgentPlanCard 在 awaitingSecondConfirm 状态显示"高风险 · 等待二次确认"标题
3. awaitingSecondConfirm 状态下按钮为「取消」和「确认删除」（红色）
4. 普通 plan 不受二次确认影响（仍显示「先不处理」和「就这么执行」）
5. 删除 action 摘要展示影响范围（如"含历史记录、常购商品、提醒状态"）
6. 删除后卡片标题变为"已执行"，不残留可点击按钮

