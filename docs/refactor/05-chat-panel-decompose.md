# 重构 #5：chat-panel god object 拆分

> 状态：待实现 · 风险：**高**（最大、最不外科，需 SiYuan 内手测）· 波次：Wave 2 · 依赖：#1（共改 ui-message-builder.ts）

## 背景与问题

`src/ui/chat-panel.ts`（约 2150 行）是 god object，约 14 类职责挤在一处：会话 CRUD、流编排、消息→DOM 渲染、ToolUIEvent→DOM 映射、活动块生命周期、工具元素创建、模型/推理选择、DOM 事件绑定、状态持久化、配置/初始化、视图切换、占位符轮播、再生/压缩。

两个具体的缝问题：

1. **ToolUIEvent→DOM 映射**（约 `1710-1799`）：一个大 switch 把 `activity`/`document_link`/`document_blocks`/`edit_blocks`/`append_block`/`created_document` 转成 HTML + 事件监听。这块逻辑自成一体，却嵌在 god object 里，无法单测。
2. **委托缝泄漏**：`SettingsView` 构造时闭包捕获了 **6 个 ChatPanel 私有方法**（`252-263`：`getConfig` / `refreshModelSelector` / `openTaskEditor` / `queryDocs` / `onConfigSaved` …）。`TasksView` 也要两个渲染回调（`246-249`）。`ChatPanel` 因此无法在不牵动委托的情况下重构。

**删除测试**：UI 的删除测试较弱（DOM 即真相）。这里的价值主要在**局部性**（把一类职责收进一个模块）与**可测性**（纯映射逻辑独立后可测），而非经典杠杆。

## 目标（分两个独立、低耦合的子项）

本计划**不追求**一次拆完 god object（风险过高）。只做两个边界清晰、互不相干的外科切口：

### 5A：抽出 ToolUIEvent→DOM 渲染器
把 `1710-1799` 那段「event payload → HTMLElement / innerHTML」纯映射抽成独立模块（如 `src/ui/tool-event-render.ts`），输入 `ToolUIEvent` + 必要回调（如点击打开文档的 handler），输出 DOM 片段或对传入元素的填充。ChatPanel 调用它。

### 5B：收紧 SettingsView 的委托缝
把 `SettingsView` 对 ChatPanel 的 6 个闭包依赖收敛成一个**显式窄接口**（如 `ChatPanelHost`），由 ChatPanel 实现并传入。让依赖可见、可 mock，而非散落的匿名闭包。

> 5A 与 5B 文件重叠（都改 chat-panel.ts + 各自新增/改一个文件），**在本计划内串行**：先 5A 后 5B。

## 涉及文件

- 改：`src/ui/chat-panel.ts`
- 改：`src/ui/settings-view.ts`（5B）
- 新增：`src/ui/tool-event-render.ts`（5A）
- 新增：`test/tool-event-render.test.ts`（5A，jsdom 环境）
- 可能新增：`src/ui/chat-panel-host.ts` 或在 types 里定义 `ChatPanelHost` 接口（5B）
- 依赖 #1：若渲染器/builder 用到消息访问器，统一来自 `message-shape`

## 设计要点

### 5A 渲染器接口（草案）
```ts
// src/ui/tool-event-render.ts
import type { ToolUIEvent } from "../types";

export interface ToolEventRenderCtx {
  i18n: Translator;
  openDocument: (id: string) => void;     // 替代闭包里直接访问 protyle
  // …仅放渲染真正需要的回调，不回传整个 ChatPanel
}

/** 把单个事件渲染进目标元素（或返回片段）。纯：除入参回调外无副作用。 */
export function renderToolEvent(el: HTMLElement, event: ToolUIEvent, ctx: ToolEventRenderCtx): void;
```
- 测试：jsdom 下喂各 payload 类型，断言生成的 DOM 结构 / class / 文本；点击触发 `openDocument` 回调。
- 注意：现状里事件监听直接调 ChatPanel 方法——抽取时这些必须经 `ctx` 回调注入，**这是去泄漏的关键**。

### 5B Host 接口（草案）
```ts
export interface ChatPanelHost {
  getConfig(): AgentConfig;
  refreshModelSelector(): void;
  openTaskEditor(task?: ScheduledTask): void;
  queryDocs(keyword: string): Promise<...>;
  onConfigSaved(next: AgentConfig): Promise<void>;
}
```
ChatPanel `implements ChatPanelHost`（或传一个实现该接口的对象），`SettingsView` 构造签名从「一堆回调」变为 `{ ...els, host: ChatPanelHost }`。

## 实现步骤

1. **先确认 #1 已落地。**
2. **5A**：
   - 把 `1710-1799` 的 switch 整段搬入 `tool-event-render.ts`；事件监听里对 ChatPanel 的调用替换为 `ctx` 回调。
   - ChatPanel 的 `applyToolUIEvent` 改为调 `renderToolEvent(el, event, ctx)`。
   - 写 jsdom 测试覆盖每种 payload。
3. **5B**：
   - 定义 `ChatPanelHost`；ChatPanel 实现它。
   - 改 `SettingsView` 构造为接收 `host`；内部 `this.host.getConfig()` 等替换原闭包调用。
   - 改 ChatPanel 实例化 SettingsView 处（`252-263`）。
4. 全套测试 / lint / build 绿。
5. **手测**（关键，子代理无法替代）：在 SiYuan 内启动插件，验证
   - 工具活动卡片渲染正常（各类型）；点击文档链接能打开；
   - 设置面板读写配置、切模型、保存生效；
   - 流式对话端到端无回归。

## 测试策略

- 5A 渲染器：jsdom 单测，是本计划主要的「可测性」收益。
- 5B：靠类型 + 现有 `chat-panel-config.test.ts` 回归；接口收紧本身由编译器保证。
- **DOM/交互无法被子代理完整验证**——必须人工在 SiYuan 内手测，验收才算完成。

## 风险与回退

- 最高之一：UI 行为难自动化验证，回归靠手测。
- 缓解：5A/5B 各为独立 commit，可单独 revert；先做 5A（纯映射、收益明确），5B 视情况。
- 若时间/风险不允许，**5B 可延后**，单独完成 5A 即有价值。

## 验收标准

- 5A：`tool-event-render.ts` 独立且有 jsdom 测试；ChatPanel 不再内联渲染 switch。
- 5B：`SettingsView` 经 `ChatPanelHost` 窄接口依赖宿主，不再闭包捕获散落私有方法。
- 全套测试 / lint / build 绿。
- **SiYuan 内手测通过**（工具卡片 / 设置面板 / 流式对话）。

---

## 评审修正（review 后更新，重要）

1. **【阻塞前置】没有 jsdom/happy-dom 测试环境。** `vitest.config.ts` 未设 `test.environment`（默认 `node`），`package.json`/`node_modules` 里也没有 jsdom/happy-dom，现有测试零 DOM。5A 的 `tool-event-render.test.ts` **无法运行**，除非先：`npm i -D jsdom` 且在 vitest 配 `environment:"jsdom"`（或文件头 `// @vitest-environment jsdom`）。渲染器还用了 `CSS.escape`、`document.createElement`、`openTab`/`globalThis.siyuanApp`——测试需 jsdom + mock。**实现 5A 前必须先加这个环境。**
2. **5A 提取边界太小**：`applyToolUIEvent`（1710-1799）只是**瘦分发器**，每个分支都委托 `this.renderToolActivitySummary(...)`（**1830-1866**）——真正的 DOM 构建、`<a>` 点击监听（1854：`openTab({app:globalThis.siyuanApp, doc:{id}})`）、`buildToolSummaryHtml` 都在那里。**真正的提取范围是 1710-1866。**
3. **`ctx` 太窄**：除 `i18n`/`openDocument` 外，被闭包捕获、必须经 ctx 注入的还有：`this.renderToolActivitySummary`、`this.buildToolSummaryHtml`、`this.localizeToolResult`（1809），以及**非纯渲染**的 `this.getActivityBlockFromElement` + `this.refreshActivityBlock`（1825/1863-1865，会重排兄弟 DOM）。后两个要么作为 ctx 回调，要么把这两处调用留在 ChatPanel。模块级 import（安全可搬）：`getToolCategory`/`getToolAction`/`getToolDisplayTitle`/`escapeHtml`/`openTab`。
4. **5B 是 5 个回调不是 6 个**：`SettingsViewContext`（`settings-view.ts:27-37`）确切为 `getConfig` / `refreshModelSelector` / `openTaskEditor` / `queryDocs` / `onConfigSaved`。
5. **两个回调的真实目标与命名不符**：
   - `onConfigSaved` 包的是 `this.handleConfigSaved`（261/2143），非同名方法。
   - `openTaskEditor` 包的是 `this.tasksView.openTaskEditor`（258）——是 **TasksView** 的方法（跨委托）。`ChatPanelHost` 由 ChatPanel 实现时需 ChatPanel 重新暴露它。
6. **执行建议**：先加 jsdom 环境 → 做 5A（收益明确）→ 视情况做 5B。5B 可延后，单独 5A 即有价值。
</content>
