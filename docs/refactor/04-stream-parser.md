# 重构 #4：stream 解析状态机抽取

> 状态：待实现 · 风险：**高**（流式心脏）· 波次：Wave 2 · 依赖：#1（共改 stream-runtime.ts，构建在其清理后的访问器上）

## 背景与问题

`runAgentStream`（`src/core/stream-runtime.ts`）把两类职责熔在一起：

1. **I/O 驱动**：消费 `agent.stream()` 异步迭代、abort 信号、idle 超时（`streamWithTimeout`，约 `407-441`）。
2. **纯状态转换**：每个 chunk（`messages` / `values` / `custom`）如何改 `parserState`、产出哪些 `onUiEvent` —— 即 `443-568` 那段约 125 行、嵌套很深的 `for await` 循环，外加 `185-304` 的 parser-state 辅助函数（`createParserState` / `flushCurrentAiTurn` / `resetPendingRecovery` / `buildRecoverableState`）。

真正难的行为——turn 恢复、tool-call 去重（`seenToolCallKeys`）、reasoning delta 归一（`normalizeReasoningDelta`）、AI dict 与 ToolMessageUi 的先后顺序（`502-518` 的注释强调顺序）——都藏在 orchestration 里。

**测试现状**：`stream-runtime.test.ts` 用 trivial 生成器 mock agent，所以**每种 chunk 类型的转换行为不是测试面**；只有 `mergeState` 等被直接测。

**删除测试**：把转换逻辑删出循环，它会在「想单测某 chunk 行为」时被迫重写 → 说明它该是独立的纯转换。

## 目标

抽出**纯转换函数**：

```
parseChunk(prevState, [streamType, data]) → { nextState, events }
```

让 `runAgentStream` 退化为 I/O 驱动：建初始 state → 循环 `for await` → `parseChunk` → 把 `events` 转发给 `onUiEvent` → 收尾 `buildRecoverableState`。每种 chunk 类型的状态迁移因此可在零 mock 下逐一断言。

## 涉及文件

- 改：`src/core/stream-runtime.ts`（抽出转换；循环只剩驱动）
- 可选新增：`src/core/stream-parser.ts`（若抽出物够大，单独成文件；否则同文件导出）
- 改/增：`test/stream-runtime.test.ts` 或新增 `test/stream-parser.test.ts`
- 依赖 #1：消息访问器已来自 `message-shape`，本计划直接用，不再有本地副本

## 设计要点与难点

这是**纯度受限**的抽取，几个钉子必须先拔：

1. **`uiBuilder`（UiMessageBuilder）是有状态对象**，循环里直接调 `uiBuilder.pushOrUpdateAi` / `onToolCallStart` / `onToolResult` / `onToolUiEvent`（见 `505-563`）。要么：
   - (a) 把 uiBuilder 的调用也纳入「转换产出」——即 `parseChunk` 返回「对 uiBuilder 的指令」由驱动层执行；或
   - (b) 把 uiBuilder 视为 `state` 的一部分，转换函数接收并驱动它（牺牲一点纯度，但仍可测）。
   倾向 **(b)**：parseChunk 接收 `{ parserState, uiBuilder }` 聚合 state，返回 `events`；测试时传入真实 UiMessageBuilder 断言其 `finalise()` 输出。
2. **`onUiEvent` 副作用**：现状循环里直接调 `onUiEvent?.(...)`。抽取后改为 parseChunk **返回 events 数组**，驱动层负责 `events.forEach(onUiEvent)`。这样转换无副作用。
3. **`write_todos` 拦截**（`549-554`）：custom 分支里改 `parserState.inputState.todos`——纳入转换。
4. **流式专有字段**：`message.tool_call_chunks`（`471`）只在流式实例上有，字典里没有——保持读法不变。
5. **idle 超时 / abort**（`407-441`、`570-575`）：**留在驱动层**，不进 parseChunk。

## 接口设计（草案）

```ts
// stream-runtime.ts 内或 stream-parser.ts
interface ParseDeps {
  parserState: ParserState;
  uiBuilder: UiMessageBuilder;
  streamReasoningBuffer: { value: string };  // 可变引用，跨 chunk 累积
}

/** 处理单个 [streamType, data]，就地更新 deps，返回要发给 onUiEvent 的事件。 */
export function parseChunk(deps: ParseDeps, chunk: [string, unknown]): UiStreamEvent[];
```

> `streamReasoningBuffer` 现状是循环外的局部变量（`451-453` 累积）。抽取时用「可变引用对象」或并入 parserState。

## 实现步骤

1. **先确认 #1 已落地**（访问器来自 message-shape）。
2. 把循环体三大分支（`messages`/`values`/`custom`）整段移入 `parseChunk`，把所有 `onUiEvent?.(x)` 改为 `events.push(x)`。
3. 把 `streamReasoningBuffer` 并入 `ParseDeps`。
4. `runAgentStream` 循环改为：`const events = parseChunk(deps, [streamType, data]); for (const e of events) onUiEvent?.(e);`
5. 写 `test/stream-parser.test.ts`：构造 `ParseDeps` + 各类 chunk，断言
   - AI chunk（纯文本 / 带 tool_call_chunks / 带 reasoning）→ events + parserState/uiBuilder 变化；
   - tool chunk → ToolMessage 入队、isError 判定（注意 `530` 的中文「子智能体执行失败」正则）、uiBuilder.onToolResult；
   - values → currentState 替换 + resetPendingRecovery；
   - custom → write_todos 拦截 + normalizeToolUIEvent + toolCallMap 回填。
6. 保留 `stream-runtime.test.ts` 的端到端 mock-agent 测试做回归。
7. 全套绿。

## 测试策略

- 新的 `parseChunk` 是测试面：逐 chunk 类型表驱动。
- 去重 / 恢复 / reasoning delta 这些原先「隐形」的行为首次获得直接断言。
- 端到端测试（mock agent 生成器）继续跑，保证驱动层接线没断。

## 风险与回退

- **最高风险项**。流式是核心路径，回归会影响所有对话。
- 缓解：
  - 严格「先搬不改」——逐分支机械搬移，行为零改动，再补测试；
  - 每搬一个分支跑一次现有 `stream-runtime.test.ts`；
  - `502-518` 的 AI-dict 先于 ToolMessageUi 的顺序是已知坑，搬移时保持原顺序。
- 回退：保留为独立 commit，若手测发现流式异常可整体 revert，不影响 #1/#2/#3/#5。

## 验收标准

- `runAgentStream` 循环体只剩驱动 + `events.forEach(onUiEvent)`。
- `parseChunk` 为可测纯（半纯）函数，含针对三类 chunk 的直接测试。
- 现有 stream-runtime 测试 + 新测试全绿；lint / build 绿。
- 行为零变化（需结合 #5 完成后在 SiYuan 内手测流式对话确认）。

---

## 评审修正（review 后更新）

1. **ParseDeps 漏了一个跨迭代可变量 `currentAiDict`（声明于 `stream-runtime.ts:404`）**：在 505 赋值、537/542 置 `null`。它实际是**写多读少、循环结束后不再被读**（每个分支整体覆盖它，`510` 的 `if (currentAiDict)` 只读同分支刚赋的值）。结论：**显式降级为 `parseChunk` 内局部变量**，不要进 ParseDeps，也不要悄悄丢失。最终 ParseDeps：`parserState`(396)、`uiBuilder`(399)、`streamReasoningBuffer`(405)。`aborted`/`error`(407-408) 留驱动层（仅 catch 改）。
2. **两个独立的 reasoning 累加器**（`451-454`）：`streamReasoningBuffer` 是**显示**总量（`reasoning_delta` 事件发它，457）；`parserState.reasoningBuffer` 是**恢复**缓冲。`normalizeReasoningDelta(streamReasoningBuffer, …)` 的去重依赖这个 box 跨 chunk 存活。用 `{value:string}` ref box 时，**测试必须同时断言两者都推进**，否则极易回归。
3. **502-518 的顺序是承重的**：`pushOrUpdateAi` 必须先于 `onToolCallStart`；`newToolCallIds` 循环（514）依赖**同一 chunk 内** 487 处填好的 `toolCallMap`。**`uiBuilder.*` 调用不是 event，别把它们「提纯」进返回的 events 数组**——在 option (b) 下它们就地按原序在 parseChunk 内执行；只有 `onUiEvent?.(x)` 改为 `events.push(x)`。
4. **可提取性已核实**：循环体内**无 `break`/`continue`/早返回/`throw`**；idle 超时/abort（`streamWithTimeout` 自包含生成器 + 570 的 try/catch）与循环体不纠缠，留驱动层。干净可抽。
</content>
