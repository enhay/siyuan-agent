# 底座迁移设计：LangChain → Vercel AI SDK v6

> 目标读者：实施本迁移的工程师 / agent。
> 前置评估见对话结论：Mastra 因 Node 服务端耦合（`node:fs/os/child_process`、hono、execa）不可在 SiYuan 渲染端运行而被否决；AI SDK 是「脱离 LangChain 又留在客户端」的唯一可行底座。
> **本设计明确不考虑向后兼容**：旧会话（LangChain `lc:1` dict 序列化）允许直接失效，不写迁移脚本、不留 shim。

> **最后核实**：2026-05-22 — 行数表（§1）、reasoning 现状（§5.2）、`config.reasoningTag` 缺口已对当前 `src/` 重新核对；源码克隆 `ai@6.0.177` 在位。**两步迁移评估见 §11（v6→v7）**。
>
> **参考源码**：AI SDK 已浅克隆到 `/home/zhaohua/code/demo/ai-sdk`，pin 在 tag `ai@6.0.177`（与 Mastra bundle 同版本）。本文档中标「✅ 已对源码核实」的 API 即据此版本。关键路径：
> - 流式 part 类型：`packages/ai/src/generate-text/stream-text.ts`
> - 工具执行上下文 `experimental_context`：`packages/ai/src/generate-text/execute-tool-call.ts`、`run-tools-transformation.ts`
> - MCP 客户端：`packages/mcp/src/`（`@ai-sdk/mcp`）
> - OpenAI 兼容 provider：`packages/openai-compatible/src/openai-compatible-provider.ts`

---

## 0. Review 修正（2026-05-22 子代理评审，必读，优先级高于下文相应段落）

已对 `ai@6.0.177` 克隆源码 + 当前 `src/` 复核。**结论：GO-WITH-FIXES**——核心论点成立（reasoning 回填 hack 确可删；流式状态机确可删，`run-tools-transformation.ts:255-411` 内置去重/partial 拼装），但下列修正在执行前生效：

**阻断项（必须先改）**

- **B1 「UI 大概率不动」对历史回放不成立。** 直播流靠 `AgentStreamUiEvent` 契约确实不动，但**历史消息渲染**直接读 LangChain dict 形状：`chat-panel.ts:51-53,1204,1490-1620`（`messageKind/Content/Reasoning/ToolCalls`、构造 `humanMsgDict`）、`chat-helpers.ts:10-15,69-98`。§6 把 `messages/messagesUi` 改成 `UIMessage[]` 时，**这两个文件必须改**（或：`messagesUi` 仍持久化 LangChain dict 形状以解耦，但那削弱 §6「删双轨」收益）。§4/§10「UI 不动」需修正为「直播流不动、历史回放需改」。
- **B2 `src/core/message-shape.ts` 漏列。** 它 `import {AIMessage,...} from "@langchain/core/messages"`（:13-19），被 `ui-message-builder/compaction/chat-helpers/chat-panel/sub-agent` 共用。§9「不留 LangChain import」要求它必须重写或删除——§10 清单需补上它。
- **B3 Wave 1 两个「并行」任务撞 `src/core/agent-types.ts`。** model 任务改 `AgentModel`、tools 任务改 `AgentTool`，二者同文件（:13,16）。**修正：把 agent-types.ts 的两个别名重定义（`AgentModel=LanguageModel`、`AgentTool=Tool` from `ai`）上提到 Wave 0**，之后两任务文件不相交方可真并行。该文件原也漏列于 §10。
- **B4 §5.2 reasoningEffort 走错 `providerOptions` 键。** 非 deepseek 路用 `createOpenAICompatible`，其 `providerOptions` 以**传入的 `name`** 为键，不是 `openai`（`openai-compatible-chat-options.ts:15` 收 `reasoningEffort:z.string()`，映射到 `reasoning_effort`，见 `...-chat-language-model.ts:261`）。写 `{openai:{...}}` 会被静默丢弃。另：现插件发的是 `thinking:{type}`（`chat-model.ts:18-25`）不是 `reasoning_effort`，是行为变化，需显式决策。
- **B5 兼容路的 reasoning 回填是「无条件」的，可重新触发 R1 的 400。** 原生 `@ai-sdk/deepseek` 对 R1/V4 有过滤（`convert-to-deepseek-chat-messages.ts:101-133`：R1 不收先前 reasoning）；`@ai-sdk/openai-compatible` **对每个 assistant 轮都发 `reasoning_content`**（`convert-to-openai-compatible-chat-messages.ts:206`，无过滤）。插件现在把「思维兼容端点」走兼容路（`chat-model.ts:62-64`）。**修正：任何 R1 类端点必须走 `@ai-sdk/deepseek`**，或文档声明「代理 R1 经兼容端点」不支持。这是「最危险删除」上文档唯一没说全的点。

**非阻断修正**

- **§5.3 part 列表有错项。** `tool-input-available/-error`、`tool-output-available/-error`、`tool-approval-response` 属 `toUIMessageStream` 的 `UIMessageChunk`，**不在 `fullStream`**（`stream-text-result.ts:375-469`）。`fullStream` 工具/审批 part 只有 `tool-call/-result/-error`、`tool-output-denied`、`tool-approval-request`。代码实际 switch 的那些（text-delta/reasoning-delta/tool-call/tool-result/tool-error/abort/finish）全对，只是列表别让人写出死 case。
- **§3 版本：`@ai-sdk/deepseek` 是 `^2`（克隆实测 2.0.34），不是 `^1`。** 其余 `@ai-sdk/mcp ^1`(1.0.41)、`@ai-sdk/openai ^3`(3.0.63)、`@ai-sdk/openai-compatible ^2`(2.0.47) 正确。
- **§5.4 seam 已存在，工作量被高估反了。** `define-tool.ts:26-50` 已有 `ToolEmitContext`/`runtimeToEmitContext`，工具已是 `(args,ctx)=>ctx.emit(payload)`（`siyuan-api.ts:22-42`）。**真正 Wave 1 tools 工作 = 只重写 `define-tool.ts` 一个文件**（包 `ai` 的 `tool()`，把 `experimental_context`+`toolCallId`→`ToolEmitContext`）；6 个 `*-tools.ts` 与 `siyuan-api.ts` 几乎不动。别按 §5.4 给 emit 再加 `toolCallId` 入参（那是回归，现在自动附）。另 `sub-agent.ts:2` 也 import 了 LangChain `tool`，需一起换。
- **§5.6 token 估算无 `maxInputTokens` 耦合（§5.2 的「唯一前置检查」可消除）。** `compaction.ts` 按字符数+轮数触发（:32-43,160-168），`DEEPSEEK_PROFILES` 仅 `deepseek.ts:211-212` 用——删 deepseek.ts 即清，无需迁表。但 `compaction.ts` 通篇读 LangChain 形状（`messageKind`、`m?.kwargs?.tool_calls`），「逻辑保留仅换模型调用」**低估了**：`splitTurns/turnsToText/charCount` 需按 `UIMessage[]` 重写。
- **路径错：`ui-message-builder.ts` 在 `src/core/` 不在 `src/ui/`**（§1/§4/§10 均误）。它且全程 LangChain 形状耦合（`src/core/ui-message-builder.ts:8,53,134,191-205`）——属被重写层，不是「不动」层。
- **§5.8 命名统一用 `createMCPClient`（稳定导出），别用 §4/§8 的 `experimental_createMCPClient`（废弃别名）。**
- **§5.2 `xhigh` 无需降级。** 原生 OpenAI 支持 `xhigh`（`openai-responses-options.ts:237-241`，GPT-5.1-Codex-Max）。

**已核实无误（不必改）**：`experimental_context`+`toolCallId` 在 tool `execute` 第二参（`execute-tool-call.ts:106-112`）；`createOpenAICompatible`/`createDeepSeek`/`wrapLanguageModel`+`extractReasoningMiddleware`/`stepCountIs`/`convertToModelMessages`/`createMCPClient` 签名；`convertToModelMessages` 确实带回 `reasoning` part（`convert-to-model-messages.ts:169-174`）。

---

## 1. 背景与范围

### 现状（被替换面）

> 行数为 2026-05-22 实测（旧值已漂移，下表为现值）。

| 文件 | 行数 | 角色 | LangChain 依赖 |
|---|---|---|---|
| `src/core/agent.ts` | 99 | `makeAgent`(createAgent+middleware)、`makeTracer` | `createAgent`, `summarizationMiddleware`, `LangChainTracer`, `langsmith` |
| `src/core/chat-model.ts` | 66 | 模型工厂；调用 `patchReasoningRoundTrip` | `ChatOpenAI`, `BaseChatModel` |
| `src/llms/deepseek.ts` | 222 | `ChatDeepSeek` 子类 patch `reasoning_content`、`<think>` 流解析 | `ChatOpenAI`, `AIMessageChunk`, `ChatGenerationChunk` |
| `src/llms/reasoning.ts` | 155 | `injectReasoningContent` + `patchReasoningRoundTrip`（**原型猴补丁**）+ `ModelProfile`/`DEEPSEEK_PROFILES` + 临时 debug 落盘块 | `BaseMessage` |
| `src/core/stream-runtime.ts` | 572 | 流式引擎：`agent.stream(streamMode)` → chunk 解析 | 全套 message 类 + streamMode |
| `src/core/compaction.ts` | 169 | 手动 `/compact` | `HumanMessage`, `BaseChatModel.invoke` |
| `src/core/sub-agent.ts` | 138 | `explore_notes` 子 agent 手写工具循环 | `tool`, `HumanMessage` |
| `src/core/mcp-client.ts` | 330 | MCP server → LangChain tool 包装 | `tool` |
| `src/core/tools/*-tools.ts` (6 文件) + `define-tool.ts`/`siyuan-api.ts`/`index.ts` | — | 19 个工具，`defineTool(fn,{schema})` → `tool(...)` + `runtime.writer()` | `tool`, `ToolRuntime` |

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
+ "@ai-sdk/deepseek": "^2",          // deepseek-reasoner 原生 reasoning（克隆实测 2.0.34）
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

### 5.2 思维链（删 ~370 行 hack：`deepseek.ts` 222 + `reasoning.ts` 155）

> **现状已变（2026-05-22 复核）**：`reasoning.ts` 已从最初的 50 行 `injectReasoningContent` 长成 155 行，含三块：
> 1. `injectReasoningContent`——把上一轮 AI 的 `reasoning_content` 回填到下次请求的 assistant 消息（thinking 端点缺它会 400）。
> 2. `patchReasoningRoundTrip`——**猴补丁 `ChatOpenAICompletions` 原型**（不是实例，因 `createAgent` 会 `bindTools` 重绑到新实例），拦截 `_convertCompletionsDelta*`/`_convertCompletionsMessage*` 抓流式与终态 reasoning，再在 `completionWithRetry` 注回。**两处调用**：`deepseek.ts:48` 与 `chat-model.ts:63`（即 OpenAI 兼容端点也吃这层）。
> 3. 一段临时 debug 落盘块（`__rec`/`__flushReasoningDebug` 写 `sa-reasoning-debug.json`），注释明写「Remove once the 400 is resolved」。
>
> v6 把上述全部消化掉——**整个原型猴补丁 + 回填 + debug 块一起删**，这是迁移最大的净收益面之一，不只是删 `injectReasoningContent`。

v6 把 reasoning 作为头等 part：

- `@ai-sdk/deepseek` 的 `deepseek-reasoner` 直接产 `reasoning-start/delta/end`，**`ChatDeepSeek` 子类整文件删除**。
- 历史消息回填：v6 把 reasoning 存进 `UIMessage` 的 `reasoning` part，`convertToModelMessages` 自动按 provider 规则带回上下文，**`injectReasoningContent` + `patchReasoningRoundTrip` 整体删除**（原型猴补丁不再需要）。
- `<think>` 标签流：用 `extractReasoningMiddleware({tagName:"think"})`（见 5.1），替掉原 `_streamResponseChunks` 里的手工解析。
- ⚠️ **`config.reasoningTag` 字段当前不存在**（5.1 代码假设了它）。需在 `ModelConfig`（`src/types/model-config.ts`）新增一个可选 `reasoningTag?: string`，UI（settings-view）侧暴露开关；或先用 `providerType` 推断（deepseek→native、其余兼容端点若已知吐 `<think>` 则置 tag）。列为 Wave 1 的一个子项。
- `ModelProfile`/`DEEPSEEK_PROFILES` 仅 `deepseek.ts:211` 的 `profile` getter 引用——删 `deepseek.ts` 即可一并删；**唯一前置检查**：`compaction.ts` 的 token 估算若依赖 `maxInputTokens`，则把该表迁到一个独立常量文件保留。
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

> 已按 §0 的 B3 修正：`agent-types.ts` 别名重定义上提到 Wave 0；PoC 作为 Wave 0 的出口闸。

```
Wave 0  依赖 + 脚手架 + 别名 + PoC（串行闸，必须先过）
  ├─ 装 ai@6/@ai-sdk/*(deepseek^2,mcp^1,openai^3,openai-compatible^2)；删 langchain*/langsmith
  ├─ agent-types.ts：AgentModel=LanguageModel、AgentTool=Tool（from "ai"）  ← B3，解锁并行
  ├─ webpack.config.js：复核移除 node:async_hooks external
  └─ PoC：单轮文本 + 1 次工具调用 + 1 次 reasoning + 1 个 write_todos 自定义事件
        打印 fullStream part.type 核对 §5.3；跑通才进 Wave 1

Wave 1  无引擎依赖层（Wave 0 后可真并行——文件不相交）
  ├─ 任务A 模型层：新建 model.ts（替 chat-model.ts）+ 删 llms/deepseek.ts、llms/reasoning.ts
  │         B4 providerOptions 按 provider name 键；B5 R1 类强制走 @ai-sdk/deepseek      # 5.1/5.2
  └─ 任务B 工具层：只重写 define-tool.ts（包 ai 的 tool()，experimental_context→ToolEmitContext）
            sub-agent.ts 的 tool import 同换；6 个 *-tools.ts/siyuan-api.ts 基本不动        # 5.4

Wave 2  引擎（依赖 Wave 1 全部；单独做，最高风险，串行）
  └─ stream-runtime.ts 重写为 runAgentStream 消费 fullStream，保持 AgentStreamUiEvent     # 5.3
     + agent.ts 瘦身 + compaction.ts(按 UIMessage[] 重写 split/turn)/sub-agent.ts 换 generateText  # 5.5/5.6/5.7

Wave 3  消息形状 + 外围（依赖 Wave 2）
  ├─ message-shape.ts 重写/删除（B2，否则 §9 LangChain-import 闸不过）
  ├─ 持久化阶段 A：state.messages → UIMessage[]；session-store 弃旧会话                    # 6
  ├─ 历史回放：chat-panel.ts/chat-helpers.ts/core/ui-message-builder.ts 改读 UIMessage（B1）
  ├─ mcp-client.ts → createMCPClient（注意 transport 浏览器约束）                          # 5.8
  └─ 追踪：移除 LangSmith（或接 OTel）                                                    # 5.9

Wave 4  可选收益
  └─ 持久化阶段 B：ToolMessageUi 折叠进 UIMessage data-* parts                            # 6
```

关键路径：Wave 2 是单点高风险（流式行为回归）；Wave 3 含 B1/B2 的 UI 与 message-shape 改动（原计划误判为「不动」）。Wave 0 的 PoC 是放行闸——跑通再铺开 19 个工具与引擎重写。

---

## 9. 验收基线（沿用 refactor 约定）

- `npm run test` 全绿（含本次新增/改写的 stream-runtime、tools 单测；现有 `markdown.test.ts`、message-shape 相关测试不破）。
- `npm run lint` 无新增错误。
- `npm run build` 产出 `dist/`；确认 bundle 不含 langchain，且无 node 内建报错（复核 webpack external）。
- SiYuan 内手测：流式输出、思维链显示、工具卡片（lookup/change/edit_blocks）、`write_todos` 进度条、`/compact`、`explore_notes` 子 agent、abort、空闲超时——逐项与迁移前行为对齐。
- 不留 LangChain import、不留 dead code、不留 compat shim。

---

## 10. 附：受影响文件清单（实施核对用）

> 已按 §0 B1/B2/B3 + 路径修正补全。

**删除**：`src/llms/deepseek.ts`、`src/llms/reasoning.ts`（`injectReasoningContent` + `patchReasoningRoundTrip` 原型猴补丁 + 临时 debug 块全删；`ModelProfile`/`DEEPSEEK_PROFILES` 唯一消费者是 deepseek.ts，随删，无需迁表）。
**重写**：`agent-types.ts`(别名重指 `ai`，**Wave 0**)、`agent.ts`、`stream-runtime.ts`、`chat-model.ts`→`model.ts`、`compaction.ts`(按 UIMessage[] 重写)、`sub-agent.ts`、`mcp-client.ts`、`core/message-shape.ts`(**B2，否则 §9 闸不过**)、`core/ui-message-builder.ts`(路径在 core/，全 LangChain 形状耦合)、`tools/define-tool.ts`(Wave 1 工具层真正工作量)。
**调整**：`types/session.ts`(`AgentState.messages` 类型)、`types/model-config.ts`(新增 `reasoningTag?`、决定 effort 行为，§5.2)、`types/tool-events.ts`(`UiMessage` 形状/阶段 B)、`session-store.ts`(弃旧会话)、`ui/chat-panel.ts`+`ui/chat-helpers.ts`(**B1 历史回放读 UIMessage**)、`tools/siyuan-api.ts`+`tools/*-tools.ts`(×6)+`tools/index.ts`(随 define-tool 签名小调)、`webpack.config.js`(node external)、`package.json`。
**大概率不动**：`ui/markdown.ts`，以及 UI 的**直播流**渲染路径（靠 `AgentStreamUiEvent` 契约稳定）——但 UI 的**历史回放**路径不在此列（见 B1）。
```

---

## 11. 第二跳：AI SDK v6 → v7（评估）

> 用户最初的问题是「LangChain→v6 再 v6→v7」两步工作量。结论：**两步极不对称，别真分两次大动**。

### 11.1 工作量对比

| 跳 | 性质 | 估算 | 主导成本 |
|---|---|---|---|
| **LangChain → v6** | 换底座（本文档全部内容） | ~5–9 人日 | `stream-runtime.ts` 重写 + 思维链层删除 + 持久化清断 |
| **v6 → v7** | 小版本升级 | **<1 人日** | 依赖 bump + provider 包微调 + 修 deprecation |

### 11.2 v7 现状与判断（2026-05 核实）

- v7 仍是 **canary / 预发布**（`npm install ai@canary`，tracking issue vercel/ai#14011，2026-04 开）。**不要让要发布的插件直接落 canary。**
- Vercel 官方定调：v6→v7 升级摩擦「very little friction」——破坏性变更主要落在 **provider 实现包**（`@ai-sdk/openai`/`@ai-sdk/deepseek` 等的严格化），高层 API（`streamText`/`useChat`/Agent）靠 deprecation 平滑过渡。
- v7 明确**不含** "app messages 持久化层"（被推迟到 v7 之后，依赖 prompt 框架与 token 计算）；包拆分（provider/core）、子 agent 独立流也都排在 **v7 稳定之后**。即：现在为了 v7 的持久化收益而抢跑，收益还拿不到。

### 11.3 策略

**一次迁到 v6 稳定线（`ai@6.0.177`，已 pin），v7 转正后当一次普通 minor bump 处理。** 本文档第 5–10 节即这一步的完整设计；v7 不需要单独的迁移设计文档，届时按官方 v6→v7 migration guide 走依赖升级即可。对本文档 §6 的持久化设计有一个顺带好处：统一到 `UIMessage[]` 后，v7/后续把 reasoning、structured output、多模态 part 作为**非破坏性 minor** 加入，无需再来一次大改。

---

## 12. 实测落地与偏差（2026-05-22，已实现）

Waves 0–3 已落地：`src/` 无 LangChain import，生产构建绿，`npm test` 308 passed。安装 `ai@6.0.190`（与 pin 的 `6.0.177` 同 minor）。与 §5/§6 设计的关键偏差如下（实现以本节为准）：

- **Wave 2/3 合并实现**：原计划 Wave 2（引擎）/Wave 3（持久化）分开，实测因消息形状与引擎耦合，合并为一组提交更干净。
- **持久化分轨保留（未做 §6 的 UIMessage[] 统一）**：`state.messages` 改为 AI SDK **`ModelMessage[]`**（streamText 直接吃、turn 后 append `result.response.messages`）；`messagesUi` **保持 `lc:1` dict 形态**（plain JSON，非 LangChain 实例）。收益：**UI 渲染路径（直播 + 历史回放）零改动，B1 完全规避，旧会话仍能渲染**。代价：`messages`/`messagesUi` 双轨保留——§6 的「删双轨」降级为可选 Wave 4（已 DEFER，属低价值优化）。
- **`message-shape.ts`**：删 `@langchain/*` 类与 `messageFromDict`/`messagesFromDict`；accessors 同时读 `lc:1` dict 与 `ModelMessage` parts；新增 `toModelMessages()`（入站 lc:1/简化 dict → ModelMessage，新会话直接 passthrough）。移除了对 live `_getType()` 实例的支持（不再产生实例）。
- **`makeAgent` 不再返回 agent 对象**，返回 `AgentRuntime {model, system, tools(ToolSet), providerOptions}`；`runAgentStream` 内部调 `streamText` 并 `for await fullStream`。`agent-types.ts` 多导出 `AgentToolSet`，工具集经 `toolSetFromArray(__toolName)` 由数组转 record。
- **工具自定义 UI 事件顺序修复（实现期发现的真 bug）**：`streamText` 会**急切执行** `execute()`，故工具 `emit` 可能早于消费方处理到 `tool-call` part → 事件 `toolCallIndex` 绑成 -1。修复：在 `runAgentStream` 缓冲早到的 emit，待 `tool_call_start` 注册后再 flush 绑定。详见 `stream-runtime.ts` 的 `pendingEmits`。
- **追踪（§5.9）**：`makeTracer`/LangSmith 已删（`agent.ts`/`chat-panel`/`scheduled-task-manager` 不再传 tracer callbacks）。`AgentConfig` 里的 `langSmith*` 字段与 settings UI 暂留为**死配置**（清理属低价值，未做）。
- **MCP（§5.8）**：未改用 `@ai-sdk/mcp` 的 `createMCPClient`；`mcp-client.ts` 自带 JSON-RPC HTTP 传输，仅把工具包装从 LangChain `tool` 换成 `ai` 的 `tool()`+`__toolName`（函数名 `mcpToolsToLangChain` 暂留）。
- **测试**：删 `chat-model`/`stream-parser`/`04-create-agent`（测已删内部）；其余按 `tool.execute()`/`__toolName`/`generateText`(MockLanguageModelV3) 重写；`stream-runtime.test` 改为经真实 `streamText` + mock model 驱动。
- **Wave 0 PoC** 保留在 `_harness/poc-aisdk.test.ts`（throwaway，未纳入 vitest include）。
