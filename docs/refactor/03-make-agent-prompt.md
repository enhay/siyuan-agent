# 重构 #3：makeAgent 提示词组装与 guide 抓取拆分

> 状态：待实现 · 风险：低 · 波次：Wave 2 · 依赖：#1（共改 sub-agent.ts，须在 #1 后）

## 背景与问题

`makeAgent`（`src/core/agent.ts:24`）把两件不相干的事缠在一起：

1. **副作用 I/O**：在构造 agent 的中途，同步 `await fetchGuideDoc()` 去打 `/api/export/exportMdContent`（`agent.ts:36-37`）。若该端点卡住，**整个 agent 创建挂起**。
2. **纯组装**：把 system prompt 从 4 个来源字符串拼接（base / guide / defaultNotebook / customInstructions / extraSystemPrompt，`agent.ts:35-55`）。

后果：
- `sub-agent.ts:74-89` 每次 invoke 都调 `makeAgent` → **每次重抓 guide doc**（无缓存）。
- `agent.ts` **零测试**：拼接顺序、guide 缺失时的兜底都未被验证。

**删除测试**：`fetchGuideDoc` 删掉，抓取知识只在一处；但提示词组装逻辑若内联，无法在不 mock fetch 的前提下测——说明组装该独立成纯函数。

## 目标

- 提示词组装变成**纯函数** `buildAgentSystemPrompt(config, guideContent, i18n) → string`：给定材料即可断言输出，无 I/O。
- guide doc 抓取移出 `makeAgent`，由调用方传入 `guideContent`（或缓存后传入）。
- `makeAgent` 接收已备好的材料，不再自己 fetch。

## 涉及文件

- 改：`src/core/agent.ts`（`makeAgent` 签名 + 抽出 `buildAgentSystemPrompt`；`fetchGuideDoc` 去留见下）
- 改：`src/core/sub-agent.ts`（invoke 路径 `74-89`：复用已抓取的 guide，避免重抓）
- 改：`makeAgent` 的调用方（`src/ui/chat-panel.ts` 主聊天创建 agent 处；搜索 `makeAgent(`）
- 新增：`test/agent-prompt.test.ts`

> 注意：`sub-agent.ts` 同时被 #1 改（删访问器）。本计划只动 invoke/创建路径，但仍须在 #1 之后，避免 import 区冲突。

## 接口设计（草案）

```ts
// agent.ts

/** 纯函数：组装 system prompt。无 I/O，便于测试。 */
export function buildAgentSystemPrompt(
  config: AgentConfig,
  guideContent: string,      // 已抓取的正文，空串表示无
  i18n: Translator = defaultTranslator,
  extraSystemPrompt?: string | null,
): string;

/** 抓取 guide doc 正文；失败返回 ""。保留导出，供调用方主动调用。 */
export async function fetchGuideDoc(docId: string): Promise<string>;

/** makeAgent 不再 fetch；guideContent 由调用方备好传入。 */
export async function makeAgent(
  config: AgentConfig,
  tools: StructuredToolInterface[],
  opts?: {
    extraSystemPrompt?: string | null;
    modelOverride?: ModelConfig | null;
    i18n?: Translator;
    reasoningEffort?: ReasoningEffort;
    guideContent?: string;   // 默认 ""
  },
);
```

> 现有 `makeAgent` 是位置参数（`config, tools, extraSystemPrompt?, modelOverride?, i18n?, reasoningEffort?`）。改成 opts 对象更清晰，但**会触及所有调用点**。两种走法见“决策点”。

## 决策点（实现前定，留给 review/grilling）

- **A. 签名形态**：保持位置参数追加 `guideContent` 末位（改动小、风险低）vs 改 opts 对象（更清晰、改所有调用点）。倾向 **opts 对象**，但调用点数量决定成本——实现时先 `grep "makeAgent("` 统计。
- **B. guide 缓存归属**：guide 内容随 `config.guideDoc.id` 变化。最简单：调用方（chat-panel）在创建主 agent 前 `fetchGuideDoc` 一次，传给 `makeAgent`；sub-agent 复用父级传入的同一份。**不在 agent.ts 内做缓存**（避免隐藏全局状态）。
- **C. `makeAgent` 仍保留 `async` 吗**：拆掉 fetch 后 `makeAgent` 内部不再有必须的 await（`createChatModel`/`createAgent` 是否同步需确认）。若全同步可去 `async`——但 `createAgent` 可能本身需要 await，保守保留 `async`。

## 实现步骤

1. 抽 `buildAgentSystemPrompt` 纯函数（把 `agent.ts:35-55` 的拼接逻辑搬入，guide 段改为用入参 `guideContent`）。
2. 改 `makeAgent`：删内部 `fetchGuideDoc` 调用，改用 `opts.guideContent ?? ""` 走 `buildAgentSystemPrompt`。
3. `grep "makeAgent("` 找全调用点；主聊天处先 `fetchGuideDoc(config.guideDoc.id)` 再传入。
4. `sub-agent.ts`：让子 agent 创建复用传入的 guideContent，不再触发抓取。
5. 写 `test/agent-prompt.test.ts`：断言
   - 有/无 guide 时的段落拼接与顺序；
   - defaultNotebook / customInstructions / extra 各自的开关；
   - guide 为空串时不产生空的 `---` 包裹。
6. 全套绿。

## 测试策略

- 纯函数 `buildAgentSystemPrompt` 是测试面，零 mock。
- guide 缺失/为空的兜底首次被固化。
- `sub-agent-tool.test.ts` 保持绿（确认子 agent 仍能创建、不再依赖 fetch 成功）。

## 风险与回退

- 低。主要风险是漏改调用点导致 guide 不再注入——靠 `grep` + 测试覆盖兜底。
- 行为差异：sub-agent 不再每次重抓 guide（性能改进，输出内容应一致）。

## 验收标准

- `makeAgent` 内不再有 `fetch` 调用。
- `buildAgentSystemPrompt` 为导出纯函数并被直接测试。
- sub-agent 复用 guide，不重抓。
- 全套测试 / lint / build 绿。

---

## 评审修正（review 后更新）

1. **全部调用点（共 3 处直接 + sub-agent 间接）**：
   - `src/ui/chat-panel.ts:818` —— `await makeAgent(config, this.tools, extraSystemPrompt, modelOverride, this.i18n, reasoningEffort)`（6 参数全给）。
   - `src/core/scheduled-task-manager.ts:421` —— `await makeAgent(config, this.options.getTools(), null, null, i18n)`（5 参数，省 reasoningEffort）。
   - `src/core/sub-agent.ts:80,88-89` —— 经 `CreateAgentFn` 间接类型（`sub-agent.ts:14-20`，**只有 5 个位置参数，无 reasoningEffort**）。
2. **决策 A 成本更高**：若改 opts 对象，必须**同时更新 `CreateAgentFn` 类型 + sub-agent.ts:88-89 调用**。这把改动牵进 #1 的领地（sub-agent.ts），但 #1 改的是访问器（39-53），本计划改的是 invoke/创建路径（74-89），**不真冲突**——依赖比「必须串行」更软。仍按 Wave 2、#1 之后执行以避免 import 区冲突。
3. **决策 C 已核实**：`createChatModel`（`chat-model.ts:29`）与 `createAgent`（`agent.ts:65`）**都是同步、未被 await**。删掉 `fetchGuideDoc` 后 `makeAgent` 无必需 await，**可去 `async`**（调用方对同步返回值 `await` 是无害 no-op）。去留皆可。
4. **跨计划注意（与 #2）**：`agent.ts:9-22` 的 `fetchGuideDoc` 是**裸 `fetch`**，解析 `data?.data?.content`，与 `siyuanFetch` 返回 `json.data` 的契约不同。若想复用 #2 的 `exportApi.mdContent`，**不能 naive 替换**——需适配返回形状（`{content, hPath}`）。本计划默认**保留 `fetchGuideDoc` 独立**，复用为可选后续。
</content>
