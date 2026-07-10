# Agent 决策入口重构 — 真实应用手工验收清单

> 面向 Electron / 桌面应用的真实环境手工验证。
>
> 自动化 smoke 只覆盖 mock 链路，真实 LLM 理解能力必须在此清单中人工验收。

## 1. 启动方式

```bash
cd household-replenishment-desktop
npm run dev
```

启动后应看到 Electron 窗口打开，进入主聊天界面。

## 2. 是否需要 DASHSCOPE_API_KEY

**需要**。LLM Turn Interpreter 使用 DashScope API。无 key 时：

- 低置信别名输入（如「拼夕夕」「p'd'd」）会进入 `skipReason=no_api_key`，返回 clarification fallback。
- 不会抛异常，但平台别名无法补全。
- trace 中 `llmInterpreter.called=false, skipReason=no_api_key`。

设置方式（在 Electron 启动前）：

```bash
export DASHSCOPE_API_KEY=<你的 key>
npm run dev
```

或在应用内「设置 → AI」中填入 key。

## 3. 如何打开 trace

### 3.1 开启 dev 模式 trace

在 DevTools Console 中执行：

```js
localStorage.agentDebug = "1"
```

之后每轮对话都会在 console 输出 trace 摘要。

### 3.2 复制完整 trace

```js
__copyAgentTrace()
```

会把最近一轮的完整 trace 复制到剪贴板。

### 3.3 查看历史 trace

```js
__agentLastTrace    // 最近一轮
__agentTraceHistory // 最近 20 轮
```

### 3.4 trace 关键字段

| 字段 | 含义 |
|------|------|
| `userText` | 用户输入 |
| `currentState` | 当前 pending 状态 |
| `localInterpretation` | turnInterpretation 本地解释 |
| `firstFocusDecision` | focusResolver 决策 |
| `routeDecision` | 路由命中（handler / rule / interceptedByRule） |
| `llmInterpreter.called` | **是否调用 LLM（只看这个）** |
| `llmInterpreter.skipReason` | 未调用原因 |
| `llmInterpreter.schemaValid` | LLM 返回 JSON 是否合法 |
| `llmInterpreter.rejectReason` | 业务拒绝原因 |
| `llmInterpreter.error` | client 异常 |
| `finalDecision` | 最终决策 |

**重要**：`routeDecision.interceptedByRule=true` 不等于「未调用 LLM」。是否调用 LLM 只看 `llmInterpreter.called`。

---

## 4. 输入序列与预期

### 4.1 pendingCollection 场景

| 步骤 | 输入 | 预期 UI | 预期 trace |
|------|------|--------|-----------|
| 1 | 今天买了 5 包宠物擦脚巾湿巾 | 采集态卡片（物品名=宠物擦脚巾湿巾，qty=5） | `firstFocus=route_to_write_draft`, `llmCalled=false` |
| 2 | 拼夕夕 | 采集态卡片更新（platform=拼多多） | `firstFocus=continue_pending_collection`, `llmCalled=true`, `schemaValid=true` |
| 3 | 128 | 采集态卡片更新（price=128） | `firstFocus=continue_pending_collection`, `llmCalled=false` |
| 4 | 不起灰 | 采集态卡片更新（review 含「不起灰」） | `firstFocus=continue_pending_collection`, `llmCalled=false` |
| 5 | asdfasdf | clarification 卡片（不写「超出家务范围」） | `firstFocus=route_to_llm`, `llmCalled=true/false 视 key` |
| 6 | 今天买了 3 袋五常大米 | **新**采集态卡片（五常大米） | `firstFocus=start_new_collection`, `llmCalled=false`, 旧 collection 标 superseded |

### 4.2 pendingPlan 场景

| 步骤 | 输入 | 预期 UI | 预期 trace |
|------|------|--------|-----------|
| 1 | 新建分类清洁用品 | plan 卡片（pending） | `firstFocus=route_to_write_draft`, `llmCalled=false` |
| 2 | 确认 | 执行建分类 | `firstFocus=continue_pending_plan`, `llmCalled=false` |
| 3 | （再次）新建分类杂货 | plan 卡片（pending） | 同上 |
| 4 | 今天买了 3 袋五常大米 | **新**采集态卡片（五常大米） | `firstFocus=start_new_collection`, 旧 plan 标 superseded |
| 5 | 算了 | 取消提示 | `firstFocus=continue_pending_plan`, `command=planCancel` |

**高风险删除场景**（需 awaitingSecondConfirm）：

| 步骤 | 输入 | 预期 UI | 预期 trace |
|------|------|--------|-----------|
| 1 | 删除猫砂 | plan 卡片（awaitingSecondConfirm） | `firstFocus=route_to_write_draft`, `requiresSecondConfirm=true` |
| 2 | 确认删除 | 执行删除 | `rule=awaitingSecondConfirm.isSecondConfirmMatch` |
| 3 | （再次）删除猫砂 | plan 卡片（awaitingSecondConfirm） | 同步骤 1 |
| 4 | 确认 | 提示「请明确说确认删除」 | `rule=awaitingSecondConfirm.weak_confirm` |
| 5 | 算了 | 取消 | `rule=awaitingSecondConfirm.cancel` |

### 4.3 pendingDraft 场景

| 步骤 | 输入 | 预期 UI | 预期 trace |
|------|------|--------|-----------|
| 1 | 帮猫砂补货 2 袋 | proposal 卡片（pending） | `firstFocus=route_to_write_draft`, `llmCalled=false` |
| 2 | 今天买了 3 袋五常大米 | **新**采集态卡片 | `firstFocus=start_new_collection`, 旧 draft 标 superseded |
| 3 | （再次补货）确认 | 执行 | `firstFocus=continue_pending_draft`, `turnKind=proposal` |
| 4 | （再次补货）取消 | cancelled | `firstFocus=continue_pending_draft`, `turnKind=cancelled` |
| 5 | （再次补货）改成 3 袋 | proposal 更新（qty=3） | `rule=reviseDraft`, `qty=3` |
| 6 | （再次补货）记了吗 | answer | `rule=pendingStatus` |
| 7 | （再次补货）确认吧 | proposal | `firstFocus=continue_pending_draft`, force_proposal 视为确认 |

### 4.4 pendingBatch 场景

| 步骤 | 输入 | 预期 UI | 预期 trace |
|------|------|--------|-----------|
| 1 | 上传订单截图 | 批量草稿卡片（pending） | `firstFocus=route_to_write_draft`, `llmCalled=false` |
| 2 | 今天买了 3 袋五常大米 | **新**采集态卡片 | `firstFocus=start_new_collection`, 旧 batch 标 superseded |
| 3 | （重新上传）全部确认 | 执行 batchConfirm | `firstFocus=continue_pending_batch`, `command=batchConfirm` |
| 4 | （重新上传）全部取消 | 执行 batchCancel | `firstFocus=continue_pending_batch`, `command=batchCancel` |
| 5 | （重新上传）价格都改成 59.9 | 执行 batchReviseAll | `firstFocus=continue_pending_batch`, `command=batchReviseAll` |
| 6 | （重新上传）第一个跳过 | 执行 batchCancelIndex(0) | `firstFocus=continue_pending_batch`, `command=batchCancelIndex` |
| 7 | （重新上传）就这样 | 执行 batchConfirm | `firstFocus=continue_pending_batch`, force_proposal 视为确认 |
| 8 | （重新上传）可以了 | 执行 batchConfirm | 同上 |
| 9 | （重新上传）按这个来 | **当前行为**：不触发 batchConfirm，走 fallback | 不命中 force_proposal/confirm；记录为当前语义 |

---

## 5. 失败时需要复制的字段

如果某步行为异常，复制以下信息：

1. **完整 trace**：DevTools Console 执行 `__copyAgentTrace()`，粘贴到 issue。
2. **用户输入**：本轮输入文本。
3. **预期 vs 实际**：
   - 预期 UI 结果
   - 实际 UI 结果
   - 预期 trace 字段值
   - 实际 trace 字段值
4. **关键 trace 字段**：
   - `firstFocusDecision.focus`
   - `routeDecision.handler` / `routeDecision.rule` / `routeDecision.interceptedByRule`
   - `llmInterpreter.called` / `llmInterpreter.skipReason` / `llmInterpreter.schemaValid` / `llmInterpreter.rejectReason` / `llmInterpreter.error`
   - `finalDecision.kind` / `finalDecision.turnKind`

---

## 6. 重要说明

### 6.1 普通浏览器 tab 可能缺 desktop bridge

`npm run dev:web`（仅 web，非 Electron）环境中 `window.desktop` 可能不存在。

- 影响：LLM Turn Interpreter 无法调用真实 DashScope，返回 `skipReason=no_desktop_bridge`。
- **这不是模型理解失败**，而是 bridge 缺失。
- 真实 LLM 验证必须以 **Electron 环境**为准。

### 6.2 real smoke skipped 不等于失败

```bash
npm run smoke:agent-llm:real
```

无 `DASHSCOPE_API_KEY` 时输出 `REAL_LLM_SMOKE_SKIPPED: no api key`，exit code 0。这是预期行为，不是失败。

### 6.3 interceptedByRule 不等于未调用 LLM

| `interceptedByRule` | `llmInterpreter.called` | 含义 |
|---------------------|------------------------|------|
| true | false | 本地规则直接接住，未进 LLM |
| true | true | LLM 解释成功后被本地规则继续路由 |
| false | true | LLM 解释后直接走 LLM 路径 |

**判断是否调用 LLM 只看 `llmInterpreter.called`**。

---

## 7. 回归验收对照

本清单与 [agent-refactor-regression-matrix.md](./agent-refactor-regression-matrix.md) 的场景一一对应。

自动化 smoke 覆盖 mock 链路：
- `npm run smoke:agent-llm`（8 case）
- `npm run smoke:agent-focus-regression`（17 case）

真实 LLM 链路需在此清单中人工验收。
