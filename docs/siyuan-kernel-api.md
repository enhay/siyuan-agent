# SiYuan Kernel API — endpoints used by this plugin

Curated reference for the kernel HTTP endpoints wrapped in
`src/core/tools/siyuan-kernel.ts`. Scope is deliberately narrow: **only what this
plugin actually calls**. For the full surface, see the upstream docs linked below.

## Conventions

- **Transport.** Every call is `POST` with a JSON body to `/api/...`, same-origin
  inside the SiYuan webview. `siyuanFetch` (`src/core/tools/siyuan-api.ts`) is the
  wrapper; `kernel` in `siyuan-kernel.ts` binds each endpoint to a typed method.
- **Envelope.** Responses are `{ code: number, msg: string, data: any }`.
  `siyuanFetch` returns `data` and **throws** when `code !== 0` (using `msg`).
  The "Response `data`" shapes below are therefore the **unwrapped** `data`.
- **Auth.** Running inside SiYuan, the plugin needs no token (same-origin). External
  HTTP clients must send `Authorization: Token <token>` (Settings → About).
- **Source labels.** ✅ verified against the official API.md or the kernel source
  (cited inline per endpoint) · 🔬 unverified, shape derived only from this repo's
  usage — verify before relying. Every endpoint below is currently ✅.

Sources:
- Official API: <https://github.com/siyuan-note/siyuan/blob/master/API.md>
- Kernel source: <https://github.com/siyuan-note/siyuan/tree/master/kernel>

---

## Notebooks (`kernel.notebooks`)

### `/api/notebook/lsNotebooks` ✅ — `.list()`
- Request: `{}`
- Response `data`: `{ notebooks: { id, name, icon, sort, closed }[] }`

### `/api/notebook/createNotebook` ✅ — `.create(name)`
- Request: `{ name: string }`
- Response `data`: `{ notebook: { id, name, icon, sort, closed } }`

### `/api/notebook/openNotebook` ✅ — `.open(notebook)`
- Request: `{ notebook: string }` (notebook ID)
- Response `data`: `null`

---

## File tree (`kernel.filetree`)

### `/api/filetree/createDocWithMd` ✅ — `.createDocWithMd({ notebook, path, markdown })`
- Request: `{ notebook: string, path: string, markdown: string }` — `path` is an
  **HPath** (human path, e.g. `/Projects/Notes`), not a filesystem path.
- Response `data`: document ID (`string`).
- ⚠ Calling again with the same `path` does **not** overwrite the existing doc — it
  creates a sibling. To edit, resolve the ID and use the block APIs.

### `/api/filetree/renameDocByID` ✅ — `.renameDocByID(id, title)`
- Request: `{ id: string, title: string }`
- Response `data`: `null`

### `/api/filetree/removeDocByID` ✅ — `.removeDocByID(id)`
- Request: `{ id: string }`
- Response `data`: `null`
- ⚠ **Deletes the whole subtree.** Source-verified: `removeDocByID` →
  `model.RemoveDoc(box, path)`, which removes the child directory
  (`path.Join(dir, ID)`) and calls `RemoveBlockTreesByPathPrefix(childrenDir)` — so
  every sub-document under the target is deleted too.
  [`kernel/model/file.go`](https://github.com/siyuan-note/siyuan/blob/master/kernel/model/file.go)
- Recoverable only via **SiYuan Data History** (a backup snapshot is written before
  removal), not via any in-app undo. This is why `delete_document` is interactive-only
  and gated on user confirmation — see `CLAUDE.md`.

### `/api/filetree/moveDocsByID` ✅ — `.moveDocsByID(fromIDs, toID)`
- Request: `{ fromIDs: string[], toID: string }` — `toID` is a **notebook ID**
  (move to its root) or a **document ID** (move in as a sub-document).
- Response `data`: `null`

### `/api/filetree/getHPathByID` ✅ — `.getHPathByID(id)`
- Request: `{ id: string }`
- Response `data`: HPath `string` (e.g. `/Projects/My Doc`). The last segment is the
  document title — `delete_document` uses this to label the deletion.

### `/api/filetree/getPathByID` ✅ — `.getPathByID(id)`
- Request: `{ id: string }`
- Response `data`: `{ notebook: string, path: string }` (`path` is the `.sy` filesystem path)

### `/api/filetree/getIDsByHPath` ✅ — `.getIDsByHPath(notebook, path)`
- Request: `{ notebook: string, path: string }` (`path` = HPath)
- Response `data`: `string[]` (document IDs — an HPath can be ambiguous)

### `/api/filetree/listDocsByPath` ✅ — `.listDocsByPath({ notebook, path, maxListCount })`
- Request: `{ notebook: string, path: string, maxListCount?: number, ignoreMaxListHint?: bool, sort?: number, showHidden?: bool, flashcard?: bool }`
  — `path` is a **filesystem** path under the box (root is `/`), not an HPath.
- Response `data`: `{ box: string, path: string, files: File[] }`. Each `File`
  (kernel `model.File`) carries: `id, name, path, icon, sort, subFileCount, size,
  hSize, mtime, ctime, hMtime, hCtime, hidden, count, alias, memo, bookmark,
  newFlashcardCount, dueFlashcardCount, flashcardCount`. ⚠ `name` is the `.sy`
  filename, not the title — this plugin reshapes files into `{ id, title, hpath, … }`
  in `list-documents.ts`.
  Source: `kernel/api/filetree.go` + `kernel/model/file.go`.

---

## Blocks (`kernel.blocks`)

Insert/prepend/append/delete return an **operation transaction**: an array of
`{ doOperations, undoOperations }`. New block IDs live in
`doOperations[].id` — see `extractOperationBlockIds` in `edit-tools.ts`.
⚠ **Editing invalidates the original block ID.** `edit_blocks` deletes + re-inserts,
so callers must use the returned new IDs (or re-read) for same-turn follow-ups.

### `/api/block/insertBlock` ✅ — `.insert({ dataType, data, previousID? | nextID? | parentID? })`
- Request: `{ dataType: "markdown", data: string, previousID?: string, nextID?: string, parentID?: string }`
- Response `data`: `{ doOperations, undoOperations }[]`

### `/api/block/prependBlock` ✅ — `.prepend({ dataType, data, parentID })`
- Request: `{ dataType: "markdown", data: string, parentID: string }`
- Response `data`: `{ doOperations, undoOperations }[]`

### `/api/block/appendBlock` ✅ — `.append({ dataType, data, parentID })`
- Request: `{ dataType: "markdown", data: string, parentID: string }`
- Response `data`: `{ doOperations, undoOperations }[]`

### `/api/block/deleteBlock` ✅ — `.delete(id)`
- Request: `{ id: string }`
- Response `data`: `{ doOperations, undoOperations }[]`

### `/api/block/getChildBlocks` ✅ — `.getChildren(id)`
- Request: `{ id: string }`
- Response `data`: `{ id, type, subType }[]`

### `/api/block/getBlockKramdowns` ✅ — `.getKramdowns(ids)`
- Request: `{ ids: string[], mode?: "md" }` (this plugin omits `mode`, so kernel
  defaults to `"md"`)
- Response `data`: `Record<blockID, kramdownString>` (kernel returns a map id→kramdown;
  entries without publish access are blanked). Kramdown is Markdown plus inline
  attribute lists `{: id="..." ...}` — `stripIAL()` filters these before diffing.
  Source: `kernel/api/block.go` → `model.GetBlockKramdowns`.

### `/api/block/getBlockTreeInfos` ✅ — `.getTreeInfos(ids)`
- Request: `{ ids: string[] }`
- Response `data`: `Record<blockID, BlockTreeInfo>` where `BlockTreeInfo` =
  `{ id, type, parentID, parentType, previousID, previousType, nextID, nextType }`.
  Used to find the previous sibling / parent so an edit re-inserts in place.
  Source: `kernel/api/block.go` → `model.GetBlockTreeInfos` (`kernel/model/block.go`).
- ⚠ **Discrepancy:** `edit-tools.ts` reads `info.rootID`, but the master kernel
  `BlockTreeInfo` exposes **no `rootID`** field — so `rootDocId` likely resolves to
  `undefined` against current kernels. Verify against your target kernel version;
  if confirmed, derive the root via another call (e.g. SQL on the block ID).

---

## Export · Search · SQL

### `/api/export/exportMdContent` ✅ — `kernel.exportApi.mdContent(id)`
- Request: `{ id: string }`
- Response `data`: `{ hPath: string, content: string }` — `content` is the full doc
  as Markdown. Also used directly in `agent.ts` `fetchGuideDoc`.

### `/api/search/fullTextSearchBlock` ✅ — `kernel.search.fullText(req)`
- Request: `{ query: string, page: number, pageSize: number, types: Record<string,boolean>,
  method: number, orderBy: number, groupBy: number, paths?: string[] }`
- Response `data`: `{ blocks: Block[], matchedBlockCount, matchedRootCount, pageCount, docMode }`.
  Each `Block` is a SQL block row (`id, rootID, box, path, hPath, content, markdown,
  type, subType, …`); this plugin reads `hPath` and content fields in `document-tools.ts`.
  Source: `kernel/api/search.go` → `model.FullTextSearchBlock`.

### `/api/query/sql` ✅ — `kernel.sql(stmt)`
- Request: `{ stmt: string }`
- Response `data`: result rows (`any[]`). Interpolate string literals via `sqlValue()`
  to escape quotes. Prefer the filetree APIs over SQL enumeration where possible.
