# 重构 #1：message-shape 模块（LangChain 消息序列化 seam）

> 状态：待实现 · 风险：低 · 波次：Wave 1 · 依赖：无 · 被依赖：#3 #4 #5

## 背景与问题

「如何从一个 LangChain 消息里读出 type / content / tool_calls / tool_call_id」这件事，在 4 个模块里各写了一份：

| 文件 | 函数 | 行 | 差异 |
|---|---|---|---|
| `src/core/stream-runtime.ts` | `getMessageType` / `getMessageContent` / `getMessageReasoning` / `getMessageToolCallId` / `getMessageToolCalls` / `getToolCallId` / `messageFromDict` | 60–104, 24–46 | content 兜底 `""`；type 认识 `SystemMessage` |
| `src/core/sub-agent.ts` | `getMessageType` / `getMessageContent` | 39–53 | **content 兜底 `null`（契约不同）；type 不认识 `SystemMessage`** |
| `src/core/compaction.ts` | `msgType` | 31 | — |
| `src/core/ui-message-builder.ts` | `msgType` / `getMessageContent` / `getMessageToolCalls` / `getToolCallId` | 13–38 | 与 stream-runtime 基本同形 |

这些副本编码的硬事实是：一条消息可能以**三种线格式**到达——
1. `lc:1` 构造器序列化字典（`{ lc:1, type:"constructor", id:[...,"AIMessage"], kwargs:{...} }`）；
2. `{ type:"ai"|"human"|"tool"|... }` 简化字典；
3. 活的 `BaseMessage` 实例（有 `_getType()`）。

`genId()` 也在 `stream-runtime.ts:20` 与 `ui-message-builder.ts:9` 重复。

**删除测试**：删掉这些访问器，三种线格式的知识会在 4 个模块重现 → 强「集中」，是教科书式的深模块候选。副本已经**漂移**：sub-agent 的 content 返回 `null` 且不识别 `SystemMessage`，是潜在 bug。

## 目标

把「LangChain 消息线格式」这一怪癖收敛进**一个深模块**，其接口是一小组访问器；所有消费者经由它读消息。一次 LangChain 升级 = 改一个文件。

## 涉及文件

- 新增：`src/core/message-shape.ts`
- 新增：`test/message-shape.test.ts`
- 改：`src/core/stream-runtime.ts`（删本地访问器，改为 import；保留对 parser/recovery 的逻辑）
- 改：`src/core/sub-agent.ts`（删 `getMessageType`/`getMessageContent`，改 import）
- 改：`src/core/compaction.ts`（删 `msgType`，改 import）
- 改：`src/core/ui-message-builder.ts`（删 `msgType`/`getMessageContent`/`getMessageToolCalls`/`getToolCallId`/`genId`，改 import）

## 接口设计（草案）

```ts
// src/core/message-shape.ts
import { BaseMessage } from "@langchain/core/messages";

export type MessageKind = "human" | "ai" | "system" | "tool" | "";

/** 任意线格式（lc:1 字典 / {type} 字典 / 活实例）→ 规范类型。 */
export function messageKind(message: any): MessageKind;

/** 文本内容；非字符串内容统一返回 ""（见“契约决策”）。 */
export function messageContent(message: any): string;

/** DeepSeek 思维链 reasoning_content；无则 ""。 */
export function messageReasoning(message: any): string;

/** ToolMessage 的 tool_call_id；无则 ""。 */
export function messageToolCallId(message: any): string;

/** AI 消息上的 tool_calls 数组；无则 []。 */
export function messageToolCalls(message: any): any[];

/** 单个 tool_call / tool_call_chunk 的 id；无则 ""。 */
export function toolCallId(raw: any): string;

/** 字典 → 活的 BaseMessage（仅 stream-runtime 反序列化用）。 */
export function messageFromDict(raw: Record<string, any>): BaseMessage;
export function messagesFromDict(raw: Record<string, any>[]): BaseMessage[];

/** 短随机 id（与原 genId 同实现）。 */
export function genId(): string;
```

## 契约决策（实现前定）

1. **content 兜底统一为 `""`**：现状只有 sub-agent 返回 `null`。改为 `""` 后需检查 sub-agent 的 `extractLastAiMessageContent`（`sub-agent.ts:64`）——它用 `content !== null` 判断是否找到 AI 文本。改为 `if (content)` 跳过空串即可，语义等价（空 AI 文本本就不该作为「最终回答」）。**这是行为改进，需在测试里固化。**
2. **type 统一识别 `SystemMessage`**：sub-agent 现状漏了它，统一为完整集合（human/ai/system/tool）。sub-agent 只在 `=== "ai"` 处用，补 system 不影响其行为。
3. `messageKind` 返回值用 `MessageKind` 枚举型，调用处的 `"AIMessageChunk"` 比较可去掉（`_getType()` 已归一为 `"ai"`）——但 stream-runtime 的 `messageType === "ai" || messageType === "AIMessageChunk"` 要确认 chunk 流里 `_getType()` 是否真返回 `"ai"`。**保守起见**：保留 `messageKind` 对 `AIMessageChunk` 归一为 `"ai"`，调用处简化为只比 `"ai"`/`"tool"`。

## 实现步骤

1. 建 `message-shape.ts`，把 stream-runtime 的实现（最全的一份）搬过去，导出上述接口。
2. 写 `test/message-shape.test.ts`：对每个访问器 × 三种线格式做表驱动测试；显式覆盖契约决策 1/2（空内容、SystemMessage、null→""）。
3. 逐个改 4 个消费者：删本地副本，import 新模块。注意各处对返回值的判断（`!== null`、`=== "AIMessageChunk"`）按契约决策调整。
4. `npm run test && npm run lint && npm run build` 全绿。

## 测试策略

- 新模块是「接口即测试面」：直接对 `messageKind`/`messageContent`/... 喂三种格式断言。
- 回归保护：`stream-runtime.test.ts`、`compaction.test.ts`、`sub-agent-tool.test.ts` 必须仍全绿——它们间接覆盖访问器被正确替换。

## 验收标准

- 4 个文件不再各自定义消息访问器，全部 import `message-shape`。
- `genId` 单一来源。
- 新增测试覆盖三种线格式 + 两条契约决策。
- 全套测试 / lint / build 绿。
- 无对外行为变化（除「空 AI 内容不再被当最终答案」这一已固化的改进）。

## 备注

`messageFromDict` 里 `ToolMessage` 强制 `tool_call_id: ""` 兜底（`stream-runtime.ts:32,40`）保持不变。

---

## 评审修正（review 后更新，以下覆盖正文）

1. **实际是 6 份活副本 + 1 份测试副本，不是 4 份。** 正文「涉及文件」遗漏了：
   - `src/ui/chat-helpers.ts:60-120` —— **最大的消费者**，含 `msgType` / `getMessageContent` / `getMessageReasoning` / `getMessageToolCalls` / `getMessageToolCallId` / `getToolCallId`，**外加写入器 `setMessageContent` / `setMessageToolCalls`**。`chat-panel.ts:42-43` 从这里 import 全套。必须纳入。
   - `src/llms/reasoning.ts:28-38` —— `getMessageType` + `getReasoningContent`。
   - `src/ui/task-run-group.ts:31` —— 又一个 `msgType`。
   - `test/04-create-agent.test.ts:44-63` —— 本地重实现 `messageFromDict`/`messagesFromDict`，可改为 import 新模块（可选）。
2. **`getMessageReasoning` 有语义分歧，必须做并集而非照搬。** `chat-helpers.ts:99-104` 比 `stream-runtime.ts:77-81` / `reasoning.ts:34-37` 多两条兜底路径（`kwargs.lc_kwargs.additional_kwargs.reasoning_content`、`lc_kwargs...`）。若按原步骤「照搬 stream-runtime 最全版」，会**悄悄丢掉 chat-panel 渲染持久化 DeepSeek reasoning 所依赖的 lc_kwargs 路径**。新模块的 `messageReasoning` 必须**合并所有兜底路径**。
3. **新增写入器接口**：把 `setMessageContent` / `setMessageToolCalls`（chat-helpers）也搬进 message-shape，保持单一来源。
4. **`msgType` 安全访问统一**：chat-helpers 版用了非可选访问（`m._getType` 无 `?.`），新模块统一用 `m?.`；确认调用方不会传 nullish（基本安全）。
5. **回归覆盖弱**：`chat-helpers.test.ts` / `sub-agent-tool.test.ts` 实际并未触达这些访问器，正文「间接覆盖」说法过强 —— 新测试是**承重的**，不是可选。
6. **契约决策 1 已核实安全**：`content !== null` 只在 `sub-agent.ts:69` 一处用，改 `if (content)` 等价，无其他依赖该 null 哨兵。
</content>
