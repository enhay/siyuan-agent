# 底座迁移设计：LangChain → Vercel AI SDK v6

> 目标读者：实施本迁移的工程师 / agent。
> 前置评估见对话结论：Mastra 因 Node 服务端耦合（`node:fs/os/child_process`、hono、execa）不可在 SiYuan 渲染端运行而被否决；AI SDK 是「脱离 LangChain 又留在客户端」的唯一可行底座。
> **本设计明确不考虑向后兼容**：旧会话（LangChain `lc:1` dict 序列化）允许直接失效，不写迁移脚本、不留 shim。

> **参考源码**：AI SDK 已浅克隆到 `/home/zhaohua/code/demo/ai-sdk`，pin 在 tag `ai@6.0.177`（与 Mastra bundle 同版本）。本文档中标「✅ 已对源码核实」的 API 即据此版本。关键路径：
> - 流式 part 类型：`packages/ai/src/generate-text/stream-text.ts`
> - 工具执行上下文 `experimental_context`：`packages/ai/src/generate-text/execute-tool-call.ts`、`run-tools-transformation.ts`
> - MCP 客户端：`packages/mcp/src/`（`@ai-sdk/mcp`）
> - OpenAI 兼容 provider：`packages/openai-compatible/src/openai-compatible-provider.ts`

---

## 1. 背景与范围

### 现状（被替换面）

| 文件 | 行数 | 角色 | LangChain 依赖 |
|---|---|---|---|
| `src/core/agent.ts` | 85 | `makeAgent`(createAgent+middleware)、`makeTracer` | `createAgent`, `summarizationMiddleware`, `LangChainTracer`, `langsmith` |
| `src/core/chat-model.ts` | 59 | 模型工厂 | `ChatOpenAI`, `BaseChatModel` |
| `src/llms/deepseek.ts` | 290 | `ChatDeepSeek` 子类 patch `reasoning_content` | `ChatOpenAI`, `AIMessageChunk`, `ChatGenerationChunk` |
| `src/llms/reasoning.ts` | 50 | `injectReasoningContent` 手工回填思维链 | `BaseMessage` |
| `src/core/stream-runtime.ts` | 532 | 流式引擎：`agent.stream(streamMode)` → chunk 解析 | 全套 message 类 + streamMode |
| `src/core/compaction.ts` | 169 | 手动 `/compact` | `HumanMessage`, `BaseChatModel.invoke` |
| `src/core/sub-agent.ts` | 123 | `explore_notes` 子 agent 手写工具循环 | `tool`, `HumanMessage` |
| `src/core/mcp-client.ts` | 330 | MCP server → LangChain tool 包装 | `tool` |
| `src/core/tools/*.ts` (8 文件) | — | 19 个工具，`tool(fn,{schema})` + `runtime.writer()` | `tool`, `ToolRuntime` |

### 目标

用 `ai@6` + `@ai-sdk/*` provider 重建上述底座，**保持 UI 层契约不变**（`AgentStreamUiEvent` / `RunAgentStreamResult` / `ToolUIEvent`），把改动锁在 `core/` 与 `llms/` 内。

### 非目标

- 不保留对旧 LangChain 会话的读取能力（清断）。
- 不重写 `chat-panel.ts` / `ui-message-builder.ts` 的 DOM 渲染逻辑（靠保持事件契约规避）。
- 不引入服务端 / RPC（保持客户端直连厂商）。

---

## 2. 决策摘要

| 关注点 | 现状（LangChain） | 目标（AI SDK v6） |
|---|---|---|
| 模型实例 | `new ChatOpenAI/ChatDeepSeek({baseURL, dangerouslyAllowBrowser})` | `createOpenAICompatible({baseURL})` / `@ai-sdk/deepseek` → `LanguageModelV3` |
| Agent loop | `createAgent({model,tools,middleware})` + `agent.stream()` | `streamText({model,tools,stopWhen:stepCountIs(N)})`，loop 内置 |
| 流式协议 | `streamMode:["messages","values","custom"]` 手解析 dict | `result.fullStream`：typed parts |
| 思维链 | `ChatDeepSeek` 子类(290行) + `injectReasoningContent`(50行) | 原生 `reasoning-*` parts；**两文件删除** |
| 工具自定义 UI 事件 | `runtime.writer(JSON.stringify(...))` | `experimental_context` 透传 writer |
| 工具定义 | `tool(fn, {name, schema})` | `tool({description, inputSchema, execute})` |
| 自动压缩 | `summarizationMiddleware({trigger,keep})` | 自写：在 `streamText` 前跑 compaction（无开箱品） |
| 子 agent | 手写递归循环 | `streamText`/`generateText` + `stopWhen` |
| 消息持久化 | `messages`(lc dict) + `messagesUi` 双轨 | 统一 `UIMessage[]`（parts 内含 reasoning/tool/data） |
| 追踪 | LangSmith `LangChainTracer` | `experimental_telemetry`(OTel) → LangSmith/Langfuse，或暂时移除 |

---

## 3. 依赖变更

```jsonc
// package.json
// 移除
- "langchain", "@langchain/core", "@langchain/openai", "langsmith"
// 新增（版本以 lockfile 中已验证的 v6 线为准）
+ "ai": "^6.0.177",
+ "@ai-sdk/openai": "^3",            // OpenAI 原生（o系列 reasoningEffort）
+ "@ai-sdk/openai-compatible": "^2", // 自定义 baseURL 的 OpenAI 兼容端点
+ "@ai-sdk/deepseek": "^1",          // deepseek-reasoner 原生 reasoning
+ "@ai-sdk/mcp": "^1"                // ✅ v6 把 MCP client 从 ai 拆出到此包
// zod ^4.3.6 保留（provider 均已验证带 (zod@4.3.6)）
```

**webpack**：`webpack.config.js:66` 的 `"node:async_hooks": "commonjs2 node:async_hooks"` external 是为 LangChain 加的，迁移后复核并大概率移除。AI SDK 走 `globalThis.fetch`，浏览器/Electron 渲染端均无需 node 内建。

---

## 4. 目标架构（模块图）

```
src/core/
  model.ts          ← 替代 chat-model.ts：createModel(config,opts) → LanguageModelV3
  agent.ts          ← 瘦身：组装 system prompt + 解析 model + 工具集，返回 {model, system, tools}
  stream-runtime.ts ← 重写并大幅瘦身：runAgentStream() 消费 fullStream → 现有 AgentStreamUiEvent
  compaction.ts     ← 逻辑保留，model.invoke → generateText
  sub-agent.ts      ← streamText/generateText + stopWhen
  mcp-client.ts     ← experimental_createMCPClient（注意 transport 浏览器约束）
  tools/
    tool-context.ts ← 新增：定义 ToolEmitContext，封装 writer 透传
    siyuan-api.ts   ← emitToolEvent/emitActivity 改为读 context 而非 runtime
    *-tools.ts      ← tool({inputSchema,execute}) 改写
  telemetry.ts      ← (可选) OTel setup 替代 makeTracer
llms/
  deepseek.ts       ← 删除
  reasoning.ts      ← 删除 injectReasoningContent；ModelProfile 表如仍需则保留
```

**核心不变量**：`stream-runtime.ts` 对外仍产出 `AgentStreamUiEvent` 流并返回 `RunAgentStreamResult`。UI 层（chat-panel / ui-message-builder）几乎不动——这是把爆炸半径关进 core 的关键缝（seam）。

---

## 5. 关键映射（逐项设计）

### 5.1 模型工厂 `model.ts`

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel } from "ai";

export function createModel(config: ModelConfig, opts: CreateModelOptions = {}): LanguageModel {
  if (config.providerType === "deepseek") {
    const ds = createDeepSeek({ apiKey: config.apiKey, baseURL: config.apiBaseURL });
    return ds(config.model);                    // deepseek-reasoner 原生吐 reasoning parts
  }
  const provider = createOpenAICompatible({
    name: config.providerType,
    apiKey: config.apiKey,
    baseURL: config.apiBaseURL!,                 // 自定义 baseURL：v6 原生支持
  });
  let model = provider(config.model);
  // 对“代理 deepseek / 用 <think> 标签”的兼容端点按需包一层：
  if (config.reasoningTag) {
    model = wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: config.reasoningTag }) });
  }
  return model;
}
```

- `dangerouslyAllowBrowser` 在 AI SDK 不需要——它本就为浏览器/edge 设计。
- `temperature`、`reasoningEffort` 不再进 `modelKwargs`，改在调用处用 `providerOptions`（见 5.3）。

### 5.2 思维链（删 340 行 hack）

v6 把 reasoning 作为头等 part：

- `@ai-sdk/deepseek` 的 `deepseek-reasoner` 直接产 `reasoning-start/delta/end`，**`ChatDeepSeek` 子类整文件删除**。
- 历史消息回填：v6 把 reasoning 存进 `UIMessage` 的 `reasoning` part，`convertToModelMessages` 自动按 provider 规则带回上下文，**`injectReasoningContent` 删除**。
- `<think>` 标签流：用 `extractReasoningMiddleware({tagName:"think"})`（见 5.1），替掉原 `_streamResponseChunks` 里的手工解析。
- `ReasoningEffort`（`off/low/high/xhigh/default`）→ `providerOptions`：

```ts
function reasoningProviderOptions(effort: ReasoningEffort, providerType: string) {
  if (providerType === "deepseek") {
    return effort === "off" ? {} : { deepseek: { /* reasoner 由模型名决定，effort 主要用于 openai 系 */ } };
  }
  // openai / 兼容端点
  if (effort === "off")  return { openai: { reasoningEffort: "minimal" } };
  if (effort === "high") return { openai: { reasoningEffort: "high" } };
  if (effort === "xhigh")return { openai: { reasoningEffort: "high" } }; // 端点无更高档时退回
  return {};
}
```

### 5.3 流式引擎 `stream-runtime.ts`（最大瘦身点）

```ts
import { streamText, stepCountIs, convertToModelMessages } from "ai";

export async function runAgentStream(opts: RunAgentStreamOpts): Promise<RunAgentStreamResult> {
  const { model, system, tools, uiMessages, recursionLimit = 25, signal, onEvent } = opts;

  const result = streamText({
    model,
    system,
    messages: convertToModelMessages(uiMessages),
    tools,
    stopWhen: stepCountIs(recursionLimit),       // 替代 recursionLimit
    abortSignal: signal,
    providerOptions: reasoningProviderOptions(opts.reasoningEffort, opts.providerType),
    experimental_context: { emit: opts.emit },   // ← 工具自定义事件出口（见 5.4）
    experimental_telemetry: opts.telemetry,
    onError: (e) => { /* ... */ },
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":      onEvent({ type: "text_delta", text: part.text }); break;
      case "reasoning-delta": onEvent({ type: "reasoning_delta", text: part.text }); break;
      case "tool-call":       onEvent({ type: "tool_call_start", toolName: part.toolName,
                                        toolCallId: part.toolCallId, args: part.input,
                                        toolCallIndex: nextIndex() }); break;
      case "tool-result":     onEvent({ type: "tool_result", toolCallId: part.toolCallId,
                                        result: stringify(part.output) }); break;
      case "tool-error":      /* status:error */ break;
      case "abort":           aborted = true; break;
      case "finish":          /* usage / lastState */ break;
      // tool-input-start / tool-input-delta：如需流式展示工具入参增量，映射到 tool_call_start 的占位
    }
  }
  return { lastState, aborted, completed, error };
}
```

要点：
- 现有 532 行里大量是「dict 反序列化 + tool_call dedup + 流式 partial 拼装」。v6 已在 SDK 内做掉去重与边界，**该状态机大半消失**，落到一个 `for await ... switch`。
- `streamMode:["messages","values","custom"]` 三模合一进 `fullStream`；其中原 `custom`（工具 UI 事件）改走 5.4 的 context，**不再混在模型流里**。
- 空闲超时（现 120s）：保留——用一个 `setTimeout` 在每个 part 到达时重置，超时则 `controller.abort()`。
- `write_todos` 不再靠 writer 注回 state；见 5.4 + 6。

> ✅ **已对源码核实**（`packages/ai/src/generate-text/stream-text.ts` @ `ai@6.0.177`）。`fullStream` part 类型全集：
> - 生命周期：`start` / `start-step` / `finish-step` / `finish` / `abort` / `error`
> - 文本：`text-start` / `text-delta` / `text-end`
> - 思维链：`reasoning-start` / `reasoning-delta` / `reasoning-end`
> - 工具入参流式：`tool-input-start` / `tool-input-delta` / `tool-input-end` / `tool-input-available` / `tool-input-error`（旧 `tool-call-streaming-*` **已废弃**）
> - 工具：`tool-call` / `tool-result` / `tool-error`
> - HITL 审批：`tool-approval-request` / `tool-approval-response` / `tool-output-available` / `tool-output-denied` / `tool-output-error`
> - 其它：`source` / `file` / `raw`

### 5.4 工具自定义 UI 事件（writer 透传——第二大风险点）

现状：`emitToolEvent(runtime, payload)` → `runtime.writer(JSON.stringify({...payload, toolCallId}))`。v6 工具 `execute` 不带 writer，但带 `experimental_context`。设计一个显式上下文出口：

```ts
// tools/tool-context.ts
export interface ToolEmitContext {
  emit: (toolCallId: string, payload: Record<string, unknown>) => void;
}

// siyuan-api.ts —— 签名从 runtime 改为 (ctx, toolCallId, payload)
export function emitToolEvent(ctx: ToolEmitContext, toolCallId: string, payload: Record<string, unknown>) {
  ctx.emit(toolCallId, payload);
}
```

工具改写（以 `write_todos` 为例）：

```ts
import { tool } from "ai";
import { z } from "zod";

export const writeTodosTool = tool({
  description: "Create or replace the current task execution plan...",
  inputSchema: z.object({
    goal: z.string(),
    todos: z.array(z.object({
      content: z.string(),
      status: z.enum(["pending","in_progress","completed"]).default("pending"),
    })),
  }),
  execute: async ({ goal, todos }, { toolCallId, experimental_context }) => {
    const ctx = experimental_context as ToolEmitContext;
    const todoList: TodoList = { goal, items: todos.map(...), updatedAt: Date.now() };
    emitToolEvent(ctx, toolCallId, { __tool_type: "write_todos", todos: todoList });
    return JSON.stringify({ status: "ok", /* counts */ });
  },
});
```

`runAgentStream` 把 `emit` 注入 `experimental_context`，并在 `emit` 回调里直接产 `tool_ui` / `todos_update` 事件（解析 `__tool_type`）——逻辑等价于现在 stream-runtime 处理 `custom` 流的那段，**搬到回调里、去掉 JSON.stringify 往返**。

> 备选：若想走纯 v6 idiom，可用 `createUIMessageStream({ execute:({writer})=>... })` 把工具事件写成 `data-*` part。但那会牵动 UI 层；本设计选 `experimental_context` 以保持 `AgentStreamUiEvent` 契约不变。

### 5.5 Agent 组装 `agent.ts`

`makeAgent` 不再返回「agent 对象」，而返回运行所需材料；guide doc 抓取等逻辑原样保留：

```ts
export async function makeAgent(config, tools, extra?, modelOverride?, i18n?, reasoningEffort?) {
  const mc = modelOverride || resolveModelConfig(config);
  const model = createModel(mc, { reasoningEffort });
  const system = await buildFullSystemPrompt(config, i18n, extra); // 含 guideDoc / defaultNotebook / customInstructions
  return { model, system, tools, providerType: mc.providerType, reasoningEffort };
}
```

`summarizationMiddleware` 无对应——压缩改为显式步骤（5.6）。

### 5.6 自动压缩 / `/compact`

AI SDK **无内置摘要中间件**。复用现有 `compaction.ts` 的算法（按 turn 切分、保留近 N 轮、其余摘要），仅替换模型调用：

```ts
import { generateText } from "ai";
const { text } = await generateText({ model, prompt: summarizationPrompt });
```

触发：在 `runAgentStream` 前判断 `uiMessages` 数量/估算 token，超阈值则先压缩再调用（等价原 `trigger.messages=30 / keep.messages=12`）。`CompactionState` 持久化结构不变。

### 5.7 子 agent `sub-agent.ts`

`explore_notes` 的手写 12 步循环 → `generateText({ model, tools: lookupTools, stopWhen: stepCountIs(12) })`，取 `result.text` 作返回。子 agent 工具集不带 writer（无 UI 事件需求），实现更短。

### 5.8 MCP `mcp-client.ts`

```ts
import { createMCPClient } from "@ai-sdk/mcp";   // ✅ v6 已从 ai 包拆出（experimental_ 前缀为废弃别名）
const client = await createMCPClient({ transport: /* SSE/HTTP */ });
const mcpTools = await client.tools();           // 直接是 AI SDK tool 形态，并入 toolset
```

⚠️ **transport 浏览器约束**：stdio transport 是 Node-only，渲染端不可用；SiYuan 桌面端若需 stdio 走 Electron 主进程/kernel 代理，web/mobile 端只能 SSE/HTTP。现有自定义包装（330 行）评估能否直接被 `client.tools()` 取代，否则保留薄包装层但底层换 v6 client。

### 5.9 追踪

`makeTracer`/LangSmith 无直接等价。两选：
- **暂时移除**（LangSmith 是可选特性，settings 里关掉即可）。
- 或接 `experimental_telemetry: { isEnabled: true, metadata }` + OpenTelemetry exporter，导到 LangSmith（OTLP 入口）或 Langfuse。建议本次先移除，单独 issue 跟进。

---

## 6. 数据 / 持久化设计（清断）

### 现状
`SessionData.state` = `{ messages: any[](lc dict), messagesUi: UiMessage[], compaction, todos }` —— LLM 上下文与 UI 展示双轨。

### 目标
**统一到 `UIMessage[]`**（v6）。一条 `UIMessage` 的 `parts` 同时承载 text / reasoning / tool-call / tool-result，外加自定义 `data-*` part 承载工具 UI 卡片信息：

```ts
type AgentState = {
  messages?: UIMessage[];     // 唯一消息轨；送模型时 convertToModelMessages()
  compaction?: CompactionState;
  todos?: TodoList;           // 仍单列（UI 顶部进度条用；亦可作 data-todos part）
};
```

收益：
- 删除 `messages` / `messagesUi` 双轨与两者间同步逻辑。
- reasoning、tool 结果天然在 part 里，UI 重渲染无需 `ToolMessageUi` 旁路（如要彻底统一）。

成本与取舍：
- `ToolUIEvent` / `ToolMessageUi` 当前比 v6 tool part 更丰富（activity/created_document/edit_blocks 等）。**分阶段**：
  - **阶段 A（推荐先做）**：`state.messages` 换成 `UIMessage[]`，但工具 UI 卡片仍走 `data-*` part / 旁路 `ToolMessageUi`，`AgentStreamUiEvent` 契约不变 → UI 层零改。
  - **阶段 B（可选）**：把 `ToolMessageUi` 折叠进 `UIMessage` 的 `data-*` parts，删 `ui-message-builder` 的旁路。属于纯收益重构，可后置。
- 旧会话：直接弃用。`session-store.ts` 读到非 `UIMessage` 结构时丢弃该会话（或整体清空 index），不写转换。

---

## 7. 风险与未决问题

| # | 风险 | 缓解 |
|---|---|---|
| R1 | ~~`fullStream` part 命名漂移~~ ✅ 已对 `ai@6.0.177` 源码核实（见 5.3）；命名锁定 | 锁 `ai@6.0.177`；升级前 diff `stream-text.ts` part 类型 |
| R2 | `experimental_context` 仍带 `experimental_` 前缀，可能改名；`createMCPClient` 已转正（旧别名废弃） | pin 精确版本；context 出口集中在 stream-runtime 一处便于改 |
| R3 | 自定义 OpenAI 兼容端点的 reasoning 字段不统一（`reasoning_content` vs `<think>`） | `config.reasoningTag` 开关 + `extractReasoningMiddleware`；deepseek 走原生 provider |
| R4 | 工具入参流式增量（现 UI 会显示 partial args）在 v6 的呈现差异 | 阶段 A 先只在 `tool-call`（完整入参）落事件，partial 展示后置 |
| R5 | MCP stdio transport 在渲染端不可用 | 仅支持 SSE/HTTP；stdio 经 kernel/主进程代理另立 issue |
| R6 | 压缩无开箱品 | 复用 compaction.ts 算法，仅换 generateText |
| R7 | 空闲超时/abort 语义需自管 | streamText `abortSignal` + part 到达重置定时器 |

---

## 8. 实施计划（波次）

```
Wave 0  依赖与脚手架
  └─ 装 ai@6/@ai-sdk/*；删 langchain*；建 model.ts；打印一遍 fullStream part.type 核对 R1

Wave 1  无 UI 风险层（可并行）
  ├─ model.ts（替 chat-model.ts）+ 删 llms/deepseek.ts、llms/reasoning.ts          # 5.1/5.2
  └─ tools/*.ts 改 tool({inputSchema,execute}) + tool-context.ts + siyuan-api.ts   # 5.4

Wave 2  引擎（依赖 Wave 1；单独做，最高风险）
  └─ stream-runtime.ts 重写为 runAgentStream 消费 fullStream，保持 AgentStreamUiEvent  # 5.3
     + agent.ts 瘦身 + compaction.ts/sub-agent.ts 换 generateText                      # 5.5/5.6/5.7

Wave 3  外围
  ├─ mcp-client.ts → experimental_createMCPClient（注意 transport）                    # 5.8
  ├─ 持久化阶段 A：state.messages → UIMessage[]；session-store 弃旧会话                 # 6
  └─ 追踪：移除 LangSmith（或接 OTel）                                                  # 5.9

Wave 4  可选收益
  └─ 持久化阶段 B：ToolMessageUi 折叠进 UIMessage data-* parts                          # 6
```

关键路径：Wave 2 是单点高风险（流式行为回归）。建议先做一条「单轮文本 + 一次工具调用 + 一次 reasoning + 一个 `write_todos` 自定义事件」的最小贯通 PoC，跑通再铺开 19 个工具。

---

## 9. 验收基线（沿用 refactor 约定）

- `npm run test` 全绿（含本次新增/改写的 stream-runtime、tools 单测；现有 `markdown.test.ts`、message-shape 相关测试不破）。
- `npm run lint` 无新增错误。
- `npm run build` 产出 `dist/`；确认 bundle 不含 langchain，且无 node 内建报错（复核 webpack external）。
- SiYuan 内手测：流式输出、思维链显示、工具卡片（lookup/change/edit_blocks）、`write_todos` 进度条、`/compact`、`explore_notes` 子 agent、abort、空闲超时——逐项与迁移前行为对齐。
- 不留 LangChain import、不留 dead code、不留 compat shim。

---

## 10. 附：受影响文件清单（实施核对用）

**删除**：`src/llms/deepseek.ts`、`src/llms/reasoning.ts`（`injectReasoningContent`；`ModelProfile`/`DEEPSEEK_PROFILES` 若仍被引用则迁出保留）。
**重写**：`agent.ts`、`stream-runtime.ts`、`chat-model.ts`→`model.ts`、`compaction.ts`、`sub-agent.ts`、`mcp-client.ts`、`tools/siyuan-api.ts`、`tools/*-tools.ts`(×6)、`tools/index.ts`。
**调整**：`types/session.ts`(`AgentState.messages` 类型)、`types/tool-events.ts`(如做阶段 B)、`session-store.ts`(弃旧会话)、`webpack.config.js`(node external)、`package.json`。
**大概率不动**：`ui/chat-panel.ts`、`ui/ui-message-builder.ts`、`ui/markdown.ts`、`ui/chat-helpers.ts`（靠 `AgentStreamUiEvent` 契约稳定）。
```
