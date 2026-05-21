# Session Sync Plan — AI 会话日志同步进 SiYuan

> Status: 实现中 · Phase 1–6 已落地（引擎核心/适配器/env-probe/manager+设置 UI/子代理汇聚+标题/AI 标题+状态），每阶段经子代理 review 并提交于分支 `feat/session-sync`，342 测试绿。延后项见 §14 Phase 6。在 `../test/ailogger`（路径 `/home/zhaohua/code/test/ailogger`）
> 及其 `docs/superpowers/plans/2026-04-30-siyuan-incremental-sync-plugin.md` 基础上延续，
> 把"独立 CLI 同步器"演进为 **siyuan-agent 插件内的自适配 session 同步子系统**，并补全
> ailogger Siyuan 目标尚缺的 **子代理汇聚** 与 **session 标题** 能力。

## 1. 目标

把本机产生的 Codex CLI / Claude Code 会话日志，增量、去重地同步成可回顾的 SiYuan 文档。

- 一次会话 = 一篇文档；后续变更更新**同一** docId，不产生重复。
- 引擎逻辑只写一份，能在多种部署环境（同机桌面 / WSL / Docker / 远程 / 移动）下自适配运行或优雅降级。
- 子代理（Codex worker/explorer）汇聚到父会话文档下，形成可导航的层级。
- 文档标题可读（启发式，可选 AI），且与稳定身份解耦。

## 2. 复用 ailogger 的边界

ailogger 已天然分层；本方案抽成**端口化引擎核心**后，纯逻辑层近乎照搬。

| ailogger 模块 | 处置 | 说明 |
|---|---|---|
| `types.ts` | ✅ 移植 | 归一会话/工具/状态类型 |
| `parsing/codex.ts` | ✅ 移植（注入 readFile） | 解析逻辑不动；但分组分类需 `role‖parentSessionId`（§10 B3） |
| `parsing/claude.ts` | 🔧 移植**+扩展** | 须新增 sidechain 处理：`isSidechain` 时 id 取 `agentId`、父取目录名（§10 B2），非照搬 |
| `render/siyuan.ts` | ✅ 移植 | 文档渲染骨架保留，按 §8/§10/§11 增强 |
| `siyuan/identity.ts` | 🔧 移植 | `node:crypto` sha256 → Web Crypto `subtle`；`basename` 自写；标题剥离 slash/命令行是**新增**代码 |
| `targets/siyuan.ts`（upsert/recover/dedup） | 🔧 移植+**改写更新路径** | 增量/按 attr 恢复保留；更新路径从 `updateBlock`(只留 FirstChild)**改写**为清子块+append；补子代理与标题 |
| `siyuan/client.ts` | ❌ 替换 | 用插件 `siyuanFetch`（同源、绕开 SDK 卡死）或 sidecar 的 HTTP client |
| `storage/state.ts` | ❌ 替换 | 插件用 `saveData/loadData`；sidecar 用 json 文件 |
| `discovery/*`（fast-glob） | ❌ 重写 | `fs.readdir` 递归 + backfill 窗口 |
| `sync/watch.ts`（chokidar）、`cli.ts`（commander） | ♻ 拆分 | watch→变更检测；CLI 保留为 sidecar 适配器 |
| `tests/**` + fixtures | ✅ 移植 | 纯逻辑单测直接复用进插件 vitest |

## 3. 已验证的环境事实（2026-05-21 实测）

- **SiYuan 跑在 Windows**：工作区 `D:\doc\siyuan`，kernel = SiYuan 3.6.5 @ `127.0.0.1:6806`，token 在 `conf/conf.json` `api.token`。
- **日志在 WSL**：`/home/zhaohua/.codex/sessions`（~1444 jsonl）、`/home/zhaohua/.claude/projects`（~517），distro=`Ubuntu`。
- **kernel `/api/file/*` 被沙箱锁在工作区内** → 读不到 `~/.codex`/`~/.claude`（`/`、`C:/`、`//wsl.localhost/...` 全 404/500）。**不能用 kernel 文件 API 读日志。**
- **Windows 侧经 UNC 可读 WSL 日志**：`\\wsl.localhost\Ubuntu\home\zhaohua\.codex\sessions` / `\\wsl$\...` 均可（慢、9P、无原生事件）。
- **WSL 进程可直连 Windows kernel**：`127.0.0.1` 在 WSL 失败（NAT，loopback≠Windows），但默认网关 IP（实测 `172.20.192.1`）可达 → `{"code":0,"data":"3.6.5"}`。网关 IP 重启会变 → 运行时用 `ip route show default` 解析；或 Windows `.wslconfig` 设 `networkingMode=mirrored` 让 127.0.0.1 双向通。WSL 有 node v24.14.0，`wsl.exe` 可被 Windows 调用。
- **`window.siyuan.config.system`** 暴露：`container`(`std`/`docker`/`android`/`ios`/`harmony`)、`os`(`windows`/`darwin`/`linux`)、`homeDir`、`workspaceDir`、`networkServe`。⚠ `homeDir` 是 **kernel 的 home**（实测 `C:\Users\1`），可能 ≠ 日志所在 home（本机日志在 WSL）。
- **kernel 写入契约**（`docs/siyuan-kernel-api.md` 已核）：`createDocWithMd` 同 HPath **建兄弟不覆盖** → 去重必须靠 docId/attr；`renameDocByID(id,title)` 改标题**保 ID**；`moveDocsByID(fromIDs, docId)` 可移入成子文档；`removeDocByID` **删整棵子树**（慎用，子代理父文档别"删了重建"）；`updateBlock` 只保留 FirstChild（更新整篇要"清子块+append"）。

## 4. 架构：端口化核心 + 两个 reader 落脚点 + 能力检测

判别轴不是"WSL 与否"，而是两个独立问题：
1. **reader 能否跑在插件所在处？**（Electron `container:"std"` 有 Node→能；浏览器/Docker/移动端→不能）
2. **它看不看得到日志？**（同机→能；WSL→有条件；远程→不能）

→ 两个 reader 落脚点，**共用同一引擎核心**，只换适配器、不分叉逻辑：

```
                ┌─────────────────────────────┐
                │  端口化引擎核心 (engine/)     │
                │  FileSource / SiyuanWriter /  │
                │  StateStore + parse/render/   │
                │  identity/aggregate/title     │
                └──────────────┬──────────────┘
        ┌──────────────────────┴──────────────────────┐
   插件内适配器                                   外部 sidecar 适配器 (= ailogger CLI)
   FileSource = Node fs(原生/UNC)                FileSource = 日志机原生 fs
   Writer = 同源 siyuanFetch                     Writer = HTTP(token+endpoint)
   Trigger = SessionSyncManager 变更检测          Trigger = 自身 watch/cron
   覆盖: 同机桌面/WSL 桌面                         覆盖: Docker/远程/移动查看 的通用兜底
```

`env-probe` 能力层读 `window.siyuan.config.system` + 探测 `window.require` + stat 源路径，决定走哪条 + 给默认 + 选降级档。

## 5. 场景矩阵

| SiYuan 运行 | 日志位置 | 插件能本地读 | 推荐 reader |
|---|---|---|---|
| 桌面 std，同机（mac/linux/win，codex 同 OS） | 同机 `~/.codex` | ✅ Node fs 直读 | **插件内，零配置** |
| 桌面 std Windows，日志在 WSL（本机） | WSL | ✅ UNC 或 `wsl.exe` | 插件内，需填 WSL 源路径 |
| 桌面 std，日志在另一台/远程 | 远程 | ❌ | sidecar 在那台机推送 |
| Docker/服务器（浏览器访问） | 宿主/容器 | ❌ 无 Node | sidecar（或 volume 挂载） |
| 移动端 android/ios | 不在本机 | ❌ | 纯查看已同步文档 |

**优雅降级三档**：① 能本地读→插件内自动同步；② 读不到但 kernel 可达→"sidecar 模式"，插件生成填好 endpoint+token 的 CLI 命令并充当 配置+状态+查看器；③ 完全读不到（移动端）→ 纯查看器。

## 6. 模块布局（siyuan-agent 内）

```
src/core/session-sync/
  engine/
    types.ts            移植 ailogger types
    parse/codex.ts      移植（readFile 注入）
    parse/claude.ts     移植（readFile 注入）
    identity.ts         sessionKey/fileKey/contentHash(WebCrypto)/docPath/slug
    render.ts           移植+增强（概览/结论/关键对话/工具摘要/子代理段/完整对话）
    aggregate.ts        新：子代理父子分组（findParent 等）—§10
    title.ts            新：标题推断（启发式/AI/回退）—§11
    ports.ts            FileSource / SiyuanWriter / StateStore 接口
    reconcile.ts        编排：发现→变更检测→解析→渲染→upsert→存 state
  adapters/
    fs-source.ts        Node fs(原生/UNC) FileSource
    siyuan-writer.ts    siyuanFetch 实现 SiyuanWriter（建/清子块+append改/setAttrs/rename/move/sql）
    state-store.ts      saveData/loadData 实现 StateStore
  env-probe.ts          能力检测 + 默认源路径解析 + 降级档判定
  manager.ts            SessionSyncManager：自有 setInterval 变更检测 + 节流 + 状态
```

- 在 `index.ts` 与 `scheduledTaskManager` 平级挂载，**不碰** `ScheduledTaskMeta`/`TasksView`。
- 同插件复用 `siyuanFetch`/设置面板/model registry/deploy；CLI sidecar 复用 ailogger（独立子包或 esbuild 出 `dist/sync-engine.cjs`）。

## 7. 触发模型：独立 SessionSyncManager + 轻量变更检测

不建模成 agent 定时任务（那是"按 cron 跑 LLM 提示"）。同步是确定性 I/O 对账、事件天性、需按会话节流 → 独立模块自有触发。

```
timer(默认 ~60s，可配)
  └─ 廉价探针：算"近 backfill 窗口文件"的签名 = count + max(mtime)
       ├─ 签名未变 → 跳过（不扫、不写）
       └─ 变了 → reconcile（§8）
  + 每会话写节流 minWriteIntervalMs；活跃会话合并/跳过，避免 SiYuan 历史膨胀
```

⚠ **不要用目录 mtime 当探针**：codex/claude 对活跃会话是往同一 jsonl **追加**，目录 mtime 只在增删/改名时变、追加不变 → 会漏掉进行中会话的更新。探针要对**近窗口文件**取 `max(mtime)+count`（codex 按 `YYYY/MM/DD/`、claude 按 project 目录，只扫最近少数子目录，不是全部 ~2000 个文件）。

> 残余漏检（可接受，靠 contentHash 兜底）：① 截断/compact 后字节数恰好不变且同秒 mtime（§8 step 2 fast-path 会跳过，下次签名变化时被 hash 捕获）；② 9P/UNC 的 mtime 粒度较粗、同轮可能撞值 → 只增加延迟、不丢数据。

另配 **"立即同步"命令**（手动触发 / 首次 backfill / 调试）。

## 8. 写路径（增量算法）

每个发现的会话文件：

```
1. fileKey = `${source}:${absPath}`；读 size + mtimeMs。
2. 文件 size/mtime 未变且已有 docId → 仅更新游标，跳过。
3. 解析 JSONL → NormalizedSession；sessionKey = `${source}:${sessionId}`。
4. 渲染 markdown；contentHash = sha256(rendered)。
5. 已有 state 且 hash 未变 → 仅更新游标。
6. hash 变了：
   - 有 docId → 更新（getChildBlocks(docId) → 逐个 deleteBlock → appendBlock 整篇）。
   - 无 docId → 按 custom-ai-session-key SQL 反查；命中则复用并重建 state，否则 createDocWithMd 新建。
7. setBlockAttrs 写/刷 custom-ai-* 身份属性。
8. 标题（§11）：若标题变化 → renameDocByID(docId, title)。
9. 原子保存 state。
```

- **唯一需新增的 kernel 封装**：`/api/attr/setBlockAttrs`（其余 createDocWithMd / query/sql / getChildBlocks / deleteBlock / appendBlock / renameDocByID / moveDocsByID 插件已有；已核实 `siyuan-kernel.ts` 无 `/api/attr/*`）。
- ⚠ **更新前校验文档仍存在**：state 有 docId 但用户手删了文档时，直接 getChildBlocks/append 会抛错（hash 短路 step 5 不验存在）。更新路径对 404/不存在 → 落到 SQL 反查恢复，仍无则重建。
- ⚠ **恢复 SQL 的 `&quot;` 转义是 load-bearing**：IAL 属性值按 HTML 转义存储，反查 `ial LIKE '%custom-ai-session-key="..."%'` 必须把 `"`→`&quot;`（移植 ailogger `escapeSqlLike`），不能用插件 `sqlValue` 的 `''` 转义替换。
- 第一版不做块级 diff、不做 append-only，整篇重渲染覆盖（生成内容由同步器独占，不保留用户编辑）。

## 9. 身份与状态

- **state 双表**（沿用 ailogger）：`files[fileKey]={offset,mtimeMs,sessionKey}`、`sessions[sessionKey]={docId,path,title,contentHash,counts,parentSessionId,...}`。
- **custom 属性**（写在文档 IAL，丢了 state 可用 SQL 反查恢复）：
  `custom-ai-source`、`custom-ai-session-id`、`custom-ai-session-key`、`custom-ai-parent-session-id`（子代理用）、`custom-ai-agent-id`（claude 子代理）、`custom-ai-project`、`custom-ai-status`、`custom-ai-title`、`custom-ai-title-source`、`custom-ai-message-count`、`custom-ai-tool-count`、`custom-ai-failed-tool-count`、`custom-ai-content-hash`。
- **跨运行时去重互通**：插件内 / sidecar 都写同一套 key + 可 SQL 恢复 → 切运行时不产生**重复文档**。⚠ 但这**不防写竞争**：两个 writer 同时对一篇文档做"删子块+append"/`setBlockAttrs` 交错会损坏内容 → 必须**单 writer 互斥**（见 §13/§14），不要同时跑插件内与 sidecar。

## 10. 【新】子代理汇聚（Siyuan 目标）

ailogger 已在 Obsidian 路径实现 codex 父子分组（`findParent` / 文件夹笔记 / `[[wiki-links]]`），但 **Siyuan 目标只做了扁平 upsert**。本方案把它补到 Siyuan：

> review 修正：Codex **与 Claude 子代理都落独立 jsonl**，两者对称建子文档（早先"Claude 不建子文档"的判断经本机数据证伪——`~/.claude/projects/<...>/<parentSessionId>/subagents/agent-*.jsonl`，本机 520 个 jsonl 中 344 个 `isSidechain:true`）。

### 识别与分组
- **Codex**：子代理由 `session_meta` 的 `agent_role`/`agent_nickname` + `source.subagent.thread_spawn.parent_thread_id`（→ `parentSessionId`）标识。⚠ 分类不能只看 role：实测有 9 个文件有 `parentSessionId`/nickname 但 `agent_role:null` → 必须 `isSub = !!agentRole || !!parentSessionId`（修正 ailogger `reconcile.ts:234` 仅按 `!agentRole` 的 bug）。缺显式父再按 `cwd`+`createdAt` 邻近回退（移植 `findParent`）。
- **Claude**：子代理文件在 `<project>/<parentSessionId>/subagents/agent-<agentId>.jsonl`，`isSidechain:true`。⚠ 这些文件里的 `sessionId` = **父**的 id，唯一标识是 `agentId` 字段 → claude parser **必须扩展**（不能照搬 §2）：`isSidechain` 时 `sessionId` 取 `agentId`（或文件名 `agent-<id>`），`parentSessionId` 取所在 `subagents/` 上级目录名。否则一个父的所有子代理会塌缩成同一 sessionKey/docId。
- ⚠ discovery 的 `**/*.jsonl` 会递归进 `subagents/` → 这些文件本就会被发现，**不要**再在父文档里重复列为顶层会话（避免重复计入）。

### Siyuan 层级与链接（修正：moveDocsByID 为主）
- 父文档：`/{root}/{YYYY}/{MM}/{DD}/{project}--{source}--{shortid}`。
- 子文档：先按普通文档 upsert（独立 docId/身份），再用 `moveDocsByID([childId], parentId)` **显式移入父文档成子文档**——这是 kernel 文档**唯一有契约保证**的成子文档方式（`siyuan-kernel-api.md:68-72`）。不要靠"建在父 HPath 下自动嵌套"（父若尚未存在会被自动建占位，随后再 `createDocWithMd` 父会因同 HPath 建**兄弟副本**，`siyuan-kernel-api.md:48-50`）。
- 父文档加 **"## 子代理"** 段，用文档引用（`((childId '锚文本'))` 或 `[标题](siyuan://blocks/childId)`）链到各子，标注 role/nickname；概览汇总子代理数、跨子工具合计/失败合计。

### 三遍 reconcile（修正顺序）
1. upsert **父**文档 → 拿到 `parentId`（确保父先存在）。
2. upsert 每个**子**文档 → `moveDocsByID([childId], parentId)`，收集 `{childId, title, role, nickname}`。
3. 用收集到的 childId **重渲染父文档**注入子代理链接（链接需真实 childId）。

### 子代理身份与重组
- 每个子文档独立 `custom-ai-session-key={source}:{childId}` + `custom-ai-parent-session-id` + `custom-ai-agent-id`（claude）。
- 会话中途新生子代理 → 父文档增链接（hash 变即更新）；分组变化用 `moveDocsByID` 迁移，**绝不** `removeDocByID`（删整棵子树）。
- 子文档编号 label 去重（移植 `numberedChildLabel`）。

## 11. 【新】session 标题

当前 `inferTitle()` 仅取首条用户消息截断；且 SiYuan 文件树显示名来自 HPath 叶子（稳定 slug → 标题难读）。

### 身份与显示标题解耦
- 文档身份永远基于 `custom-ai-session-key` + docId，**不基于路径**。
- 流程：`createDocWithMd` 建在稳定 slug 路径 → `renameDocByID(docId, 可读标题)` 设显示标题（ID 不变，去重不受影响，路径漂移无害）。

### 标题来源（分级，带回退链）
1. **启发式**（默认）：取首条**实质**用户消息（剥离注入上下文、slash 命令、纯命令行），按词边界截断（≤ N 字）。
2. **AI 标题**（可选，默认关）：复用插件 **model registry** 让已配模型把会话浓缩成短标题（可顺带产出一行 summary 供概览）。Prompt 只喂必要内容、不喂海量原始工具输出；**不**记录/持久化完整 API key。
3. 回退：AI（启用且可用）→ 启发式 → `{project} {source} {shortid}`。

### 稳定性（防抖）
- state + `custom-ai-title`/`custom-ai-title-source` 缓存所选标题；**仅当标题真的变化才 `renameDocByID`**。
- AI 标题不每轮重算：仅在"尚无 AI 标题"或内容大幅变化时生成。
- ⚠ **来源切换防翻转**：用户把 AI 标题关掉时，不要回退覆盖已设的 AI 标题（除非内容变化）——加优先级锁，避免 AI↔启发式 反复 rename。
- ⚠ 启发式剥离 slash 命令/纯命令行是**新增逻辑**：ported `inferTitle` 仅取首条用户消息、codex parser 仅滤 `# AGENTS.md` 注入上下文，不含此剥离。
- 子代理子文档标题：`{role}: {首条任务描述}` 或 nickname。

## 12. AI 摘要（可选，后续）

复用 model registry，默认关。可增强：标题、一行结论、关键对话挑选、下一步动作。必须在无 AI 时回退到确定性渲染；不喂多余原始工具输出；不渲染/落地完整密钥。

## 13. 坑与风险（汇总）

- `createDocWithMd` 同路径建兄弟不覆盖 → 去重只认 docId/attr。
- `updateBlock` 只保留 FirstChild → 更新走"清子块+append"。
- `removeDocByID` 删整棵子树 → 父文档别删了重建；重组用 `moveDocsByID`。
- 探针别用目录 mtime（漏追加）。
- UNC 慢且无原生事件 → 靠 backfill 窗口 + 游标跳过 + 浅扫探针；轮询放宽到分钟级。
- WSL→kernel 网关 IP 漂移 → 运行时解析；或 mirrored 网络。
- `homeDir` ≠ 日志 home → 源路径可配，不只从 homeDir 推。
- `window.require` 仅桌面 → mobile/docker 守卫并降级。
- token：sidecar 经 argv/stdin/0600 临时文件传，不落世界可读；不打印。
- 活跃会话写节流，避免 SiYuan 历史膨胀。
- webpack：优先运行时 `window.require("fs")` 绕开打包；否则按现有 `node:async_hooks` externals 模式补 `fs`/`path`/`os`。
- **写竞争**：插件内与 sidecar 不可同时写同一笔记本 → 单 writer 互斥（lock 文件 / kernel attr 租约）；UI 不让两者并行启用。
- **mirrored 网络无法从 webview 检测**（读不到 `.wslconfig`）→ `env-probe` 经验式探测：先试 `127.0.0.1:6806`，失败再试 `ip route` 网关 IP。
- 子代理识别陷阱：codex `role:null` 但有 parent 的会被误判为父；claude sidechain 的 `sessionId`=父 id（用 `agentId`）；discovery 勿把 `subagents/` 文件重复当顶层会话（详见 §10）。

## 14. 分期落地

- **Phase 0 ✅**：可达性验证（UNC 读 ✅、kernel API ❌、WSL→kernel 网关 ✅、node/wsl.exe ✅、system 字段 ✅）。
- **Phase 1**：端口化引擎核心 + 移植纯逻辑（types/parse/render/identity）+ 复用 ailogger 单测。不碰 Siyuan、不碰运行时，纯 TDD。**含**：claude parser 的 sidechain 扩展（agentId/parent 目录）、codex 分类 `role‖parentSessionId` 修正——并为这两个 bug 补回归测试。
- **Phase 2**：插件内适配器（fs-source 原生/UNC + siyuan-writer + state-store(saveData)）+ reconcile，跑通 create/update/dedup/SQL 恢复。新增 `setBlockAttrs` 封装。
- **Phase 3**：`env-probe` 能力层 + 源路径可配列表（按 OS/homeDir 默认 + WSL 模板 + "测试可达"）+ 优雅降级三档。
- **Phase 4**：`SessionSyncManager` 变更检测轮询 + 节流 + "立即同步"命令 + 设置面板 + 状态展示。
- **Phase 5（本次重点补全）**：子代理汇聚（§10）+ session 标题（§11）。
- **Phase 6**：✅ AI 标题（model registry，sticky/回退，§11/§12）+ active/idle/completed 状态推断（§13）已落地。
  - **单 writer 互斥**：kernel 无 CAS → 不做脆弱的分布式锁。改为**结构性单写者**：env-probe 的 tier 使一台机器要么插件内、要么 sidecar（互斥），插件内再由 manager 重入守卫防自重叠；同机同时手动跑 sidecar + 启用插件内为**不支持**配置（UI tierNote 已引导）。完整 kernel-lease 显式延后。
  - **sidecar 一等公民**：ailogger 即 sidecar；插件"生成命令"的 tier-2 UI（plan §17.2 态②）延后，架构已支持直接运行 ailogger。
  - 大会话拆分：延后。
- **整体 review 修正（merge gate）**：B1 已修——设置面板补了"用 AI 生成标题"开关 + 模型下拉（否则 Phase 6 标题路径不可达）；B3 已修——`lastSyncAt` 移入引擎自有 sync state（不再写 `agent-config`，消除与设置保存的丢更新竞争）；新增跨轮聚合回归测试（父先建、子后到→子被归位）。
  - **B2 延后（显式 de-scope）**：plan §17.4 的富状态面板（状态点/逐源可达指示/计数汇总/错误展开）与**面板内"立即同步"按钮**未实现——需真机浏览器迭代。当前触发走**命令面板**"立即同步 AI 会话"（已可用）；面板仅显示上次同步时间。`SessionSyncManager.onStatusChange` 已预留，待面板落地时接线。

MVP 明确不做：块级 diff、append-only、Obsidian 兼容、用户编辑保留、大会话拆分。

## 15. 验收标准

- [ ] 首同步建文档；重复同步不产生重复（同 docId）。
- [ ] 源日志变更更新同一 docId；未变不调写 API。
- [ ] 丢失 state 可由 `custom-ai-session-key` SQL 恢复，不重建重复文档。
- [ ] 同机桌面零配置可用；Windows+WSL 填路径可用；Docker/移动端优雅降级为 sidecar/查看器且不报错。
- [ ] Codex **与 Claude** 子代理都汇聚到父文档下、可从父文档导航到子文档，重组不误删；一个父的多个子代理不塌缩成同一文档。
- [ ] 插件内与 sidecar 不会同时写、不产生内容损坏（单 writer 互斥生效）。
- [ ] 文档显示标题可读且与稳定身份解耦；标题不每轮抖动。
- [ ] AI 关闭时渲染仍可用；不泄露密钥。
- [ ] 所有文档写入经 kernel API；不直写 SiYuan `data/`。

## 16. 待定问题

- ~~Claude Code 子代理是否落独立 sidechain jsonl？~~ **已答（review 经本机数据证实）：是**，`<project>/<parent>/subagents/agent-*.jsonl`、`isSidechain:true` → 与 codex 同法建子文档（§10）。
- 父文档"子代理"链接用块引 `(( ))` 还是 `siyuan://` 链接更稳？（两者对 doc 块均有效，待实测体验）
- `createDocWithMd` 对"父段已是已存在文档"的嵌套 HPath 究竟自动挂为子文档还是另建占位？kernel 文档未明 → 因此 §10 用 `moveDocsByID` 为主而非依赖嵌套。
- 是否提供"诊断/修复"命令（按 attr 全量重建 state）。
- 大会话是否拆子文档（与子代理层级如何共存）。
- 单 writer 互斥用 lock 文件还是 kernel attr 租约（§13/§14 Phase 6 落地时定）。

## 17. UI 设计（细化）

贴合现有插件模式（来自代码勘探，均为可复用锚点）：设置面板是 **侧栏导航 + 内容面板**（`settings-view.ts:129-233`）；状态点复用 `automation-card__dot--{success|error|running|idle|disabled}`（`_session.scss:79-100`）；字段用 `b3-text-field`/`b3-select`/`settings-panel__checkbox`/`b3-button`；笔记本下拉复用 `loadNotebookOptions()`（`settings-view.ts:851`）；命令用 `addCommand`（`index.ts:144`）；i18n 扁平点号键 `settings.sessionSync.*`；不碰 `TasksView`。

### 17.1 落点
- 设置面板新增一个 **导航项 + 面板**：`data-settings-panel="session-sync"`，标题"AI 会话同步"。
- 状态与"立即同步"都在该面板内（不进 Automations 列表，避免与 agent 定时任务混排）。手动同步完成弹 `showMessage` toast。
- 命令面板加 **"立即同步"**（`langKey: "sessionSync.syncNow"`），无需编辑器焦点 → 用 `callback`。

### 17.2 自适配三态（由 `env-probe` 决定渲染哪一态）

**态 ① 插件内可读（理想）**——完整控件 + 自动同步状态：
```
┌ AI 会话同步 ──────────────────────────────────┐
│ ☑ 启用会话同步                  ● 上次同步 09:12│
│                                                │
│ 来源                                           │
│  ☑ Codex   [\\wsl.localhost\Ubuntu\…\.codex\sessions ] [测试]● │
│  ☑ Claude  [\\wsl.localhost\Ubuntu\…\.claude\projects] [测试]● │
│  [+ 添加路径]                                   │
│                                                │
│ 目标笔记本 [ 我的笔记本 ▾ ]   根路径 [/AI 会话]  │
│ 检测间隔 [60]秒   回填 [7]天 [50]条             │
│ ☐ 用 AI 生成标题    模型 [ gpt-4o ▾ ]          │
│                                                │
│ [ 立即同步 ]      新增 3 · 更新 12 · 失败 0     │
└────────────────────────────────────────────────┘
```

**态 ② sidecar 模式**（Docker/远程/无 Node）——生成填好的命令 + 复制：
```
┌ AI 会话同步 ──────────────────────────────────┐
│ ⚠ 此环境无法直接读取日志。请在日志所在机器运行：│
│  ┌────────────────────────────────────────────┐│
│  │ npx ailogger watch --target siyuan \        ││
│  │  --siyuan-endpoint http://172.20.192.1:6806 \││
│  │  --siyuan-token ••• --siyuan-notebook <id> \ ││
│  │  --siyuan-root-path "/AI 会话" --sources codex,claude
│  └────────────────────────────────────────────┘│
│            [ 复制命令 ]   [ 仅查看已同步 ]       │
└────────────────────────────────────────────────┘
```
（endpoint 经验式探测得出：先 `127.0.0.1` 再网关 IP；token 显示打码，复制时填真值。）

**态 ③ 纯查看**（移动端）——一句提示：同步在桌面/sidecar 完成，此处文档可正常浏览；隐藏所有写控件。

### 17.3 字段 → 配置映射
新增 `SessionSyncConfig`（挂在 `AgentConfig.sessionSync`，存 `agent-config`）：
```ts
interface SessionSyncConfig {
  enabled: boolean;
  sources: { codex: boolean; claude: boolean };
  sourcePaths: { codex: string[]; claude: string[] };   // 可配列表，默认按 OS/homeDir 推 + WSL 模板
  notebookId?: string;
  rootPath: string;                 // 默认 "/AI 会话"
  pollIntervalSec: number;          // 默认 60
  backfillDays: number; backfillLimit: number;
  aiTitle: { enabled: boolean; modelId?: string };  // 复用 model registry
  lastSyncAt?: number;              // 状态展示用
}
```
读写沿用 `SettingsView` 既有流：`render()` 用 config 填 draft → checkbox 即时存、文本 blur 存 → `saveForm()` 组 `nextConfig` → `plugin.saveData`。

### 17.4 状态面板
- 每个来源一个状态点（`--success` 同步完成 / `--running` 同步中脉冲 / `--error` 出错 / `--idle` 空闲），title 显示路径可达性与上次结果。
- 汇总行：`新增 N · 更新 M · 失败 K` + 相对时间（复用 `formatDateTime`）。错误可展开（`details/summary`）。
- "立即同步"按钮在运行中禁用并切 `--running`。

### 17.5 资源
- 样式新建 `src/styles/_session-sync.scss`，遵循 `var(--agent-x, var(--b3-y))`，`@use` 进 `index.scss`；状态点直接复用 automation-card 的 keyframes 思路。
- i18n 在 `en_US.json`/`zh_CN.json` 加 `settings.sessionSync.*`、`sessionSync.syncNow/syncing/lastSync/result.*/tier2.*` 等键。
