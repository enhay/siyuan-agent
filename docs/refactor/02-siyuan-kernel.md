# 重构 #2：SiYuan kernel 模块（端点 + SQL seam）

> 状态：待实现 · 风险：低 · 波次：Wave 1 · 依赖：无（与 #1 文件不相交，可并行）

## 背景与问题

`siyuanFetch`（`src/core/tools/siyuan-api.ts:9`）深化了**传输层**——它藏起了两条硬知识：
- 用原生 `fetch` 而非 SDK 的 `fetchPost`（后者在 `code<0` 时回调被吞、Promise 永不 resolve）；
- `code !== 0` 抛错的约定。

它挣它的饭钱，**保留不动**。

但 SiYuan 的 **REST 表面**没有缝：约 10 个端点硬编码在 6 个工具文件里，其中 `/api/query/sql` 出现 **7 次**，每次都是内联 SQL 字符串 + 手动 `sqlEscape()`。端点清单散落如下：

| 文件 | 端点 |
|---|---|
| `edit-tools.ts` | `getBlockKramdowns`, `getBlockTreeInfos`, `insertBlock`, `prependBlock`, `appendBlock`, `deleteBlock`, `createDocWithMd`, `moveDocsByID`, `renameDocByID`, `removeDocByID`, `query/sql` |
| `document-tools.ts` | `query/sql`, `getChildBlocks`, `exportMdContent`, `fullTextSearchBlock` |
| `notebook-tools.ts` | `lsNotebooks` |
| `list-documents.ts` | `getFileTreeOpenPaths`, `listDocsByPath`（经 helper） |
| `recent-documents.ts` | `query/sql` |
| `scheduled-tools.ts` | （SQL / 存储相关） |

**风险**：任何一处忘了 `sqlEscape` 即注入。没有一个地方命名「本插件实际调用的 SiYuan 操作集合」。

**删除测试**：删掉每个工具里的 URL 字符串与内联 SQL，知识会在 6 个文件重现 → 中等「集中」。

## 目标与坦诚的权衡

建一个**深的「SiYuan kernel」模块**，暴露命名操作（`getBlockKramdowns`、`insertBlock`、`exportMdContent`、类型化 `sql<T>()`、`lsNotebooks`…）——URL、请求形状、SQL 转义集中在这一处。工具调用操作，不再拼 URL。

**一个适配器 = 假想缝**：现实里几乎只有一个后端（SiYuan kernel），所以这条缝的正当理由**不是可插拔**，而是：
1. **注入安全**：转义集中一处，不可能漏；
2. **可测性**：工具改为对一个 kernel 缝打桩，而非按端点 stub 全局 `fetch`；
3. **可发现性**：一份类型化的操作清单 = 插件对 SiYuan 依赖的真实契约。

即使只有一个适配器，因「接口即测试面」，这条缝仍挣其饭钱。

## 涉及文件

- 新增：`src/core/tools/siyuan-kernel.ts`（命名操作，内部用 `siyuanFetch`）
- 新增：`test/siyuan-kernel.test.ts`
- 改：`edit-tools.ts` / `document-tools.ts` / `notebook-tools.ts` / `list-documents.ts` / `recent-documents.ts` / `scheduled-tools.ts`（URL/SQL → kernel 操作调用）
- `siyuan-api.ts` 保留 `siyuanFetch` / `emitToolEvent` / `emitActivity` / `sqlEscape`（`sqlEscape` 可移入 kernel 内部，外部不再直接调）

## 接口设计（草案）

```ts
// src/core/tools/siyuan-kernel.ts
import { siyuanFetch, sqlEscape } from "./siyuan-api";

/** 块操作 */
export const blocks = {
  getKramdowns: (ids: string[]) => siyuanFetch("/api/block/getBlockKramdowns", { ids }),
  getTreeInfos: (ids: string[]) => siyuanFetch("/api/block/getBlockTreeInfos", { ids }),
  getChildren: (id: string) => siyuanFetch("/api/block/getChildBlocks", { id }),
  insert: (req: { data: string; dataType?: string; previousID?: string; parentID?: string }) =>
    siyuanFetch("/api/block/insertBlock", { dataType: "markdown", ...req }),
  prepend: (req: { data: string; parentID: string; dataType?: string }) =>
    siyuanFetch("/api/block/prependBlock", { dataType: "markdown", ...req }),
  append: (req: { data: string; parentID: string; dataType?: string }) =>
    siyuanFetch("/api/block/appendBlock", { dataType: "markdown", ...req }),
  delete: (id: string) => siyuanFetch("/api/block/deleteBlock", { id }),
};

/** 文档树 */
export const filetree = {
  createDocWithMd: (req: { notebook: string; path: string; markdown: string }) =>
    siyuanFetch("/api/filetree/createDocWithMd", req),
  moveByID: (fromIDs: string[], toID: string) =>
    siyuanFetch("/api/filetree/moveDocsByID", { fromIDs, toID }),
  renameByID: (id: string, title: string) =>
    siyuanFetch("/api/filetree/renameDocByID", { id, title }),
  removeByID: (notebook: string, path: string) =>
    siyuanFetch("/api/filetree/removeDocByID", { notebook, path }),
  openPaths: (...) => siyuanFetch("/api/filetree/getFileTreeOpenPaths", ...),
  listDocsByPath: (...) => siyuanFetch("/api/filetree/listDocsByPath", ...),
};

export const notebooks = {
  list: () => siyuanFetch("/api/notebook/lsNotebooks", {}),
};

export const exportApi = {
  mdContent: (id: string): Promise<{ content: string }> =>
    siyuanFetch("/api/export/exportMdContent", { id }),
};

export const search = {
  fullText: (query: string, ...) => siyuanFetch("/api/search/fullTextSearchBlock", { query, ... }),
};

/** 类型化 SQL：模板内的动态值必须经 sqlEscape——把转义收进 helper。 */
export function sql<T = any>(stmt: string): Promise<T[]> {
  return siyuanFetch("/api/query/sql", { stmt });
}
/** 便于安全拼接：sqlValue("x") → "'x''escaped'"。鼓励调用方用它而非裸字符串。 */
export function sqlValue(v: string): string { return `'${sqlEscape(v)}'`; }
```

> 具体每个操作的参数形状以现有调用点为准（实现时逐一对照，不臆造字段）。

## 实现步骤

1. 扫描 6 个文件，列出每个 `siyuanFetch(url, payload)` 调用点的精确 url + payload 形状。
2. 据此定义 `siyuan-kernel.ts` 操作（参数形状 1:1 复刻现状，**不改行为**）。
3. 逐文件替换调用点；所有 `/api/query/sql` 改为 `kernel.sql()`，内联拼值改 `sqlValue()`。
4. `sqlEscape` 不再从工具文件直接 import（除非仍有特殊拼接），改为经 `sqlValue`。
5. 写 `test/siyuan-kernel.test.ts`：mock `siyuanFetch`，断言每个操作打到正确 url + payload；`sqlValue` 转义正确。
6. 全套绿。

## 测试策略

- kernel 自身：mock 全局 `fetch` 或 `siyuanFetch`，逐操作断言 url/payload。
- 工具层：现有 `tools.test.ts`、`list-documents.test.ts`、`recent-documents.test.ts` 保持绿；替换后这些测试若打桩 `fetch`，可改为打桩 kernel（更窄的缝），但**非必须**——优先保证不破坏。

## 风险与回退

- 风险低：纯调用点替换，payload 形状不变。
- 唯一陷阱：某些端点 payload 有隐式默认（如 `dataType: "markdown"`）——逐点核对，别在 kernel 默认里改掉原语义。

## 验收标准

- 工具文件不再出现 `/api/...` 字面量与裸 SQL 拼接。
- 所有**字符串值**插值经 `sqlValue`（数值/关键字另行，见修正 5）。
- 新增 kernel 测试；全套测试 / lint / build 绿。
- 对外行为零变化。

---

## 评审修正（review 后更新，以下覆盖正文）

1. **文件位置错误**：`list-documents.ts` 与 `recent-documents.ts` 在 **`src/core/`**，不是 `src/core/tools/`。正文表格与「涉及文件」需更正。实际涉及：`src/core/tools/{edit-tools,document-tools,notebook-tools}.ts` + `src/core/{list-documents,recent-documents}.ts`。
2. **删除 `scheduled-tools.ts`**：它**没有任何 siyuanFetch / SQL**，只调 `emitActivity` 并委托 `ScheduledTaskManager`。从本重构移除。
3. **filetree 端点清单是错的**（正文 `getFileTreeOpenPaths` / `openPaths` **不存在**）。`list-documents.ts` 实际用：`getIDsByHPath`(277)、`getPathByID`(291)、`listDocsByPath`(315，payload `{notebook,path,maxListCount,ignoreMaxListHint:true}`)、`getHPathByID`(344)、`exportMdContent`(359)。`recent-documents.ts` 用 `exportMdContent`(62) + `query/sql`(85)。kernel 的 `filetree` 操作按此重列。
4. **list/recent-documents 用注入的 `fetcher` 参数**（`notebook-tools.ts:45,76` 把 `siyuanFetch` 传进去），不是直接 import —— 这是它们的依赖注入/可测设计，其测试 stub 该 fetcher。**决策**：保留注入但传入 kernel（推荐，少破坏其测试），而非改为直接调 kernel。
5. **`sqlValue` 不能覆盖数值插值**：`recent-documents.ts:44` 是 `LIMIT ${limit}`（已 clamp 的整数）。`sqlValue` 会加引号，错误。验收标准放宽为「字符串值经 `sqlValue`」；数值用 `Number()`/clamp 保证，关键字白名单。
6. **`removeDocByID` payload 是 `{id}`**（`edit-tools.ts:250`，属未注册的 `deleteDocumentTool`），不是 `{notebook,path}`。kernel 操作签名按 `{id}` 来。
7. **`exportMdContent` 返回形状是 `{content, hPath}`**（注意 `hPath` 大小写），用于 3 处（document-tools:12、recent-documents:62、list-documents:359）。另见 #3 计划：`agent.ts:11` 也有一份**裸 fetch** 版（解析 `data.data.content`，与 siyuanFetch 的 `json.data` 契约不同）——本计划提供 `exportApi.mdContent` 后，#3 是否复用需注意该解析差异（naive 替换会坏）。
8. **`insertBlock` 真实分支**：`edit-tools.ts` 在 `previousID` 存在时用 `insertBlock`，否则用 `prependBlock`（`58/64`），payload 含 `dataType:"markdown"` 默认 —— kernel 默认里保持，勿改语义。
</content>
