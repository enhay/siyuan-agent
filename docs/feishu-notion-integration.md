# Feishu (Lark) + Notion Integration — Plan

Status: **planned** · Owner: TBD · Last updated: 2026-05-21

Let the SiYuan Agent **read from** and **export to** Notion and Feishu, as a new
group of native agent tools. No two-way sync.

## Decisions (locked)

| Question | Decision |
|---|---|
| Scope | **Read + one-way export.** Search/read external pages into SiYuan; create/append SiYuan content into Notion/Feishu. No pull-back sync, no conflict resolution. |
| Approach | **Native tools via SiYuan kernel `forwardProxy`.** Not MCP. |
| Targets | **Notion and Feishu together** (shared proxy/credential/settings scaffold built once). |

**Non-goals:** two-way sync, incremental sync, ID-mapping/state tracking, OAuth
login flows (use tokens/app-secrets), Notion databases-as-tables editing, Feishu
Bitable/Sheets (docs only for v1).

## Why native tools (not MCP)

- The repo's MCP client (`src/core/mcp-client.ts`) is **remote Streamable HTTP +
  `Bearer` only** and **cannot spawn stdio servers**, and connects via direct
  `fetch` (CORS-exposed).
- Notion's hosted MCP uses OAuth (doesn't fit the `Bearer apiKey` client); **Feishu
  has no usable remote MCP** (only stdio `npx lark-mcp`).
- → Native tools through `forwardProxy` is the only path that covers **both** and
  stays consistent with the existing 20-tool architecture.

## Hard constraints

1. **CORS.** The plugin runs in SiYuan's Electron renderer; direct `fetch` to
   `api.notion.com` / `open.feishu.cn` is blocked. Route every external call through
   the kernel **`/api/network/forwardProxy`** (server-side proxy, no CORS). The repo
   does not use it yet — we add a helper.
2. **Auth.**
   - Notion: **internal integration token** (user creates at notion.so/my-integrations,
     pastes into settings). Header `Authorization: Bearer <token>`, `Notion-Version: 2022-06-28`.
   - Feishu: **self-built app** `app_id` + `app_secret` → exchange for
     `tenant_access_token` (cache ~2h). App needs scopes: `docx:document`,
     `drive:drive` (read/list), plus write scopes for export.
3. **Content mapping.** Notion block JSON ↔ Markdown and Feishu docx blocks ↔
   Markdown are the main effort. v1 keeps mapping deliberately small (see below).

## Architecture

```
src/core/tools/siyuan-kernel.ts   + forwardProxy(url, {method, headers, payload, contentType})
src/core/integrations/
  notion-client.ts                 thin REST wrapper (search/read/create/append) over forwardProxy
  feishu-client.ts                 token exchange + docx REST wrapper over forwardProxy
  notion-markdown.ts               Notion blocks ↔ markdown (pure, unit-tested)
  feishu-markdown.ts               Feishu docx blocks ↔ markdown (pure, unit-tested)
src/core/tools/notion-tools.ts     notion_search / notion_read_page / notion_create_page / notion_append
src/core/tools/feishu-tools.ts     feishu_search_docs / feishu_read_doc / feishu_create_doc / feishu_append
src/core/tools/index.ts            register (gate write tools behind opts, like delete_document)
src/types/model-config.ts          AgentConfig.integrations: { notion?, feishu? }
src/ui/settings-view.ts            credential inputs + "test connection"
src/i18n/*.json                    tool titles, settings labels, errors
src/i18n/* agent.systemPrompt      add the new tools to the catalog + usage guidance
```

### `forwardProxy` helper (kernel)

`/api/network/forwardProxy` body: `{ url, method, timeout, contentType, headers:[{...}], payload }`,
returns `{ status, body, headers, ... }`. Helper unwraps to parsed JSON and throws on
non-2xx. Restrict to the two known hosts (`api.notion.com`, `open.feishu.cn`) as a
guardrail.

### Tools (v1 surface)

**Notion** (`Authorization: Bearer`, `Notion-Version`):
- `notion_search(query)` → POST `/v1/search` (filter object=page) → `[{id,title,url}]`
- `notion_read_page(id)` → GET `/v1/blocks/{id}/children` (paginate) → markdown
- `notion_create_page(parentId, title, markdown)` → POST `/v1/pages` (markdown→blocks) ⚠ write
- `notion_append(blockId, markdown)` → PATCH `/v1/blocks/{id}/children` ⚠ write

**Feishu** (`tenant_access_token`):
- `feishu_search_docs(query)` → Drive file list / docs search → `[{id,title}]`
- `feishu_read_doc(id)` → GET `/docx/v1/documents/{id}/raw_content` (plain-text shortcut for v1) → text
- `feishu_create_doc(folderToken, title, markdown)` → POST `/docx/v1/documents` then append blocks ⚠ write
- `feishu_append(documentId, markdown)` → POST `/docx/v1/documents/{id}/blocks/{blockId}/children` ⚠ write

### Content mapping (v1 = small, lossy-OK)

Support the common blocks both ways; pass others through as plain paragraphs:
headings (#/##/###), paragraphs, bulleted/numbered lists, to-do (`- [ ]`), quote,
code fence, divider. Tables / nested toggles / embeds → best-effort or skipped with
a note in the result. Read uses Feishu `raw_content` (plain text) in v1 to avoid the
full docx block parser; upgrade to structured blocks later.

### Auth & safety

- Credentials in `AgentConfig.integrations` (plugin local storage — **not encrypted**;
  document this; acceptable for a local note tool).
- Feishu `tenant_access_token` cached in memory with expiry; never persisted.
- **Write tools require confirmation** (reuse "read freely / confirm on writes"); register
  write tools **interactive-chat only** (like `delete_document`), keep them out of the
  autonomous scheduled-task toolset.
- forwardProxy host allowlist; never forward arbitrary URLs from model input.

## Implementation phases (incremental, each shippable)

- **Phase 0 — scaffold**
  - [ ] `forwardProxy` helper in `siyuan-kernel.ts` (+ test with mocked fetch)
  - [ ] `AgentConfig.integrations` type + migration default
  - [ ] Settings UI: Notion token; Feishu app_id/app_secret; "test connection"
- **Phase 1 — read (validate the whole path)**
  - [ ] `notion-client` + `notion_search` / `notion_read_page`
  - [ ] `feishu-client` (token exchange) + `feishu_search_docs` / `feishu_read_doc` (raw_content)
  - [ ] register read tools; add to system-prompt catalog; i18n
- **Phase 2 — write (one-way export, gated)**
  - [ ] markdown→blocks mappers (`notion-markdown`, `feishu-markdown`) + unit tests
  - [ ] `notion_create_page` / `notion_append`, `feishu_create_doc` / `feishu_append`
  - [ ] register write tools interactive-only; confirmation guidance in prompt
- **Phase 3 — polish**
  - [ ] blocks→markdown read fidelity (Notion structured; Feishu structured blocks)
  - [ ] error mapping (auth/scope/rate-limit) → localized messages
  - [ ] docs: update `docs/siyuan-kernel-api.md` if forwardProxy is documented there

## Testing

- Pure mappers (`*-markdown.ts`): TDD, table-driven round-trip tests (no network).
- `forwardProxy` + clients: mock global `fetch`, assert request shape + envelope unwrap
  (mirror `test/tools.test.ts` patterns).
- Tools: invoke with mocked client/proxy; assert returned JSON + that write tools emit
  an activity card and are absent from the scheduled toolset.

## Open questions / risks

- **Feishu doc search**: Feishu's search API is awkward; v1 may list a folder or require
  a doc URL/ID rather than free-text search. Confirm the user's primary entry (paste a
  link vs. browse). May ship `feishu_read_doc` first, search later.
- **Feishu scopes**: the self-built app must be granted doc scopes and published to the
  tenant; read/write need different scopes. User action required.
- **Notion parent**: creating a page needs a parent page/database the integration was
  shared with. Surface a configurable "default Notion parent".
- **Mapping fidelity**: round-tripping rich content is lossy in v1 — acceptable, noted in
  tool results.
- **Token storage** is plaintext in plugin data — acceptable for local use; flag in docs.
