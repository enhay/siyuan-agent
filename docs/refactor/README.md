# 架构深化重构计划（Deepening Refactors）

本目录是一组以「把浅模块变深」为目标的重构计划。术语遵循 `improve-codebase-architecture` 的语言约定：

- **模块（Module）**：有接口和实现的任何东西（函数 / 类 / 包 / 跨层切片）。
- **接口（Interface）**：调用方为正确使用模块必须知道的一切——签名、不变量、错误模式、顺序约束、所需配置。
- **深度（Depth）**：小接口背后藏着大量行为即为「深」；接口几乎和实现一样复杂即为「浅」。
- **缝（Seam）**：接口所在的位置，可在不就地改代码的前提下替换行为。
- **删除测试（Deletion test）**：设想删掉该模块——若复杂度消失，它只是穿透层；若复杂度在 N 个调用方处重现，它在挣它的饭钱。
- **局部性（Locality）**：维护者从深度中得到的——变更 / bug / 知识集中在一处。
- **杠杆（Leverage）**：调用方从深度中得到的——学一个小接口换来大量能力。

## 候选清单

| 编号 | 计划 | 核心 seam | 删除测试 | 风险 |
|---|---|---|---|---|
| #1 | [message-shape 模块](01-message-shape.md) | LangChain 消息序列化 | 强（4 处重现） | 低 |
| #2 | [SiYuan kernel 模块](02-siyuan-kernel.md) | 端点 + SQL | 中（端点散落 6 文件） | 低 |
| #3 | [makeAgent 提示词拆分](03-make-agent-prompt.md) | 提示词组装 vs SiYuan 抓取 | 中 | 低 |
| #4 | [stream 解析状态机](04-stream-parser.md) | chunk→state 转换 | 中 | 高 |
| #5 | [chat-panel 拆分](05-chat-panel-decompose.md) | UI 事件→DOM 映射 / 委托缝 | 弱（UI） | 高 |

## 实现波次（依赖顺序）

这些重构在文件层面相互重叠，**不能全部裸并行**——`#1 / #4 / #5` 都重改 `stream-runtime.ts` 与 `ui-message-builder.ts`。按波次执行：

```
Wave 1（并行，文件不相交）
  ├── #1 message-shape   （core 消息层 + chat-helpers/reasoning/task-run-group）
  └── #2 siyuan-kernel   （tools 层 + core/list-documents、recent-documents）

Wave 2a（在 #1 落地后并行；文件不相交）
  ├── #3 make-agent      （agent.ts / sub-agent.ts / scheduled-task-manager.ts / chat-panel.ts:818）
  └── #4 stream-parser   （stream-runtime.ts）

Wave 2b（在 #3 落地后，单独执行）
  └── #5 chat-panel      （chat-panel.ts 1710-1866 + settings-view.ts；需先加 jsdom 环境；需 SiYuan 手测）
```

**冲突矩阵**（✗ = 改同一文件，需排序）：

| | #1 | #2 | #3 | #4 | #5 |
|---|---|---|---|---|---|
| #1 | — | ✓ | ✗ sub-agent | ✗ stream-runtime | ✗ ui-message-builder/chat-helpers |
| #2 | ✓ | — | ✓ | ✓ | ✓ |
| #3 | ✗ | ✓ | — | ✓ | ✗ chat-panel.ts |
| #4 | ✗ | ✓ | ✓ | — | ✓ |
| #5 | ✗ | ✓ | ✗ chat-panel.ts | ✓ | — |

结论：#2 与所有人不相交；#1 是地基。**修正**：#3 与 #5 都改 `chat-panel.ts`（#3 改 818 调用点，#5 改 1710-1866 渲染区），不能并行——故 Wave 2 拆成 2a（#3∥#4）与 2b（#5，#3 之后）。

## 通用验收基线

每个计划完成都必须满足：

- `npm run test` 全绿（含为本次新增的测试）。
- `npm run lint` 无新增错误。
- `npm run build` 成功产出 `dist/`。
- 不改变对外行为（除非计划显式说明）；不留 backwards-compat shim、不留 dead code。
</content>
