/** SiyuanWriter backed by the kernel API (same-origin `siyuanFetch`).
 *
 *  Update overwrites the body via clear-children + append (kernel `updateBlock`
 *  only keeps FirstChild). Recovery and existence checks go through SQL on the
 *  document's IAL. Inject a fake `SiyuanKernel` in tests. See plan §8. */

import { kernel as defaultKernel, sqlValue, type SiyuanKernel } from "../../tools/siyuan-kernel";
import type { SiyuanWriter } from "../engine/ports";
import { SECTION_ATTR_KEY, SECTION_KIND, type SectionKind } from "../engine/render";

/** Fixed top-to-bottom order of sections in a session doc. Used when finding
 *  the boundaries of a section to replace / append into. */
const SECTION_ORDER: SectionKind[] = [
	SECTION_KIND.overview,
	SECTION_KIND.summary,
	SECTION_KIND.dialog,
	SECTION_KIND.tools,
	SECTION_KIND.warnings,
];

/** Best-effort classification of a top-level block (by its first kramdown line)
 *  to a section kind. Returns undefined for body blocks (table rows, items, etc).
 *  Used only during `tagSectionAnchors` — once the attr is set, lookups go
 *  through SQL on `custom-section`. */
function classifyAnchor(firstLine: string, type: string | undefined): SectionKind | undefined {
	if (type === "h") {
		if (/^##\s*📋\s*概览/.test(firstLine)) return SECTION_KIND.overview;
		if (/^##\s*💬\s*对话/.test(firstLine)) return SECTION_KIND.dialog;
		if (/^##\s*🔧\s*工具调用/.test(firstLine)) return SECTION_KIND.tools;
		if (/^##\s*⚠️\s*解析警告/.test(firstLine)) return SECTION_KIND.warnings;
		return undefined;
	}
	if (type === "bq" && /🎯/.test(firstLine)) return SECTION_KIND.summary;
	return undefined;
}

/** Extract block ids from a kernel insert/append/prepend result. The kernel
 *  returns an operation transaction `[{ doOperations: [{id, …}, …], … }]`. */
function extractInsertedBlockIds(result: unknown): string[] {
	if (!Array.isArray(result)) return [];
	const ids: string[] = [];
	for (const item of result) {
		const ops = Array.isArray((item as { doOperations?: unknown[] })?.doOperations)
			? ((item as { doOperations: unknown[] }).doOperations as Array<{ id?: unknown }>)
			: [];
		for (const op of ops) {
			if (typeof op?.id === "string" && op.id) ids.push(op.id);
		}
	}
	return ids;
}

/** Escape a value for embedding inside a SQL `LIKE '…'` pattern.
 *
 *  IMPORTANT: SiYuan's SQL parser PANICS on a `LIKE … ESCAPE …` clause
 *  (`sql.BinaryExpr.String(): invalid op ESCAPE`), which silently breaks every
 *  dedup lookup → the sync can no longer find existing docs → it creates
 *  duplicates. So we must NOT emit an ESCAPE clause, and therefore must not rely
 *  on backslash-escaping LIKE metacharacters either. That's safe here: session
 *  keys are `<source>:<uuid/hex>` and carry no `%`/`_`/`\`.
 *  - `'` is doubled for the SQL string literal.
 *  - IAL attribute values are HTML-escaped, so a literal `"` is stored as `&quot;`. */
function escapeIalLike(value: string): string {
	return value.replace(/'/g, "''").replace(/"/g, "&quot;");
}

interface IdRow {
	id?: string;
}

/** Write a workspace file via multipart /api/file/putFile (kernel's JSON fetcher
 *  can't do multipart). Default is same-origin (plugin); inject for the CLI/sidecar. */
async function defaultPutFile(path: string, content: string): Promise<void> {
	const fd = new FormData();
	fd.append("path", path);
	fd.append("isDir", "false");
	fd.append("file", new Blob([content], { type: "text/markdown" }), path.split("/").pop() || "file.md");
	const resp = await fetch("/api/file/putFile", { method: "POST", body: fd });
	const json = (await resp.json()) as { code: number; msg?: string };
	if (json.code !== 0) throw new Error(`putFile ${path} failed: ${json.msg ?? json.code}`);
}

export interface SiyuanWriterOptions {
	/** Override the file writer (e.g. CLI sidecar pointing at a remote endpoint). */
	putFile?: (path: string, content: string) => Promise<void>;
}

/** Retry a kernel op that can transiently fail right after createDocWithMd while
 *  SiYuan's filetree index catches up (e.g. moveDocsByID "tree not found"). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 400): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
		}
	}
	throw lastErr;
}

export function createSiyuanWriter(k: SiyuanKernel = defaultKernel, opts: SiyuanWriterOptions = {}): SiyuanWriter {
	const putFile = opts.putFile ?? defaultPutFile;
	return {
		async createDoc({ notebook, path, markdown }) {
			const id = await k.filetree.createDocWithMd({ notebook, path, markdown });
			if (!id || typeof id !== "string") {
				throw new Error("createDocWithMd returned no document id");
			}
			return { id };
		},

		async overwriteDoc({ docId, markdown }) {
			// The earlier "snapshot getChildren + serial delete + append" pattern
			// produced bloat in the wild: one mastra session whose render is
			// ~450 KB became a 47 MB .sy file (104× inflation). Likely cause: a
			// stale snapshot from getChildren — by the time we run `delete(id)`
			// SiYuan's background maintenance (heading fold rebalance, kramdown
			// IAL reflow, …) may have changed the tree such that some ids no
			// longer match a top-level child, the delete is a silent no-op, the
			// block remains, and the subsequent `append` lands on top of the
			// leftover — accumulating across every overwrite cycle.
			//
			// Fix: re-fetch getChildren after each pass and only stop when it's
			// truly empty. Cap at 10 passes to avoid an infinite loop on the
			// pathological case where SiYuan keeps re-creating children we just
			// deleted (would surface as a thrown error so the bug is visible).
			let lastCount = Infinity;
			for (let pass = 0; pass < 10; pass++) {
				const children = await k.blocks.getChildren(docId);
				if (!children || children.length === 0) break;
				if (children.length >= lastCount && pass > 0) {
					// Not making progress — bail before we silently overwrite on top.
					throw new Error(
						`overwriteDoc: stuck clearing doc ${docId} (${children.length} children remain after pass ${pass})`,
					);
				}
				lastCount = children.length;
				for (const child of children) {
					if (child?.id) await k.blocks.delete(child.id);
				}
			}
			await k.blocks.append({ data: markdown, parentID: docId });
		},

		async setAttrs({ docId, attrs }) {
			await k.attr.setBlockAttrs(docId, attrs);
		},

		async renameDoc({ docId, title }) {
			await k.filetree.renameDocByID(docId, title);
		},

		async foldHeadings({ docId, headingPrefixes }) {
			const children = (await withRetry(() => k.blocks.getChildren(docId))) ?? [];
			for (const block of children) {
				if (block?.type !== "h" || typeof block.content !== "string") continue;
				if (headingPrefixes.some((p) => block.content.startsWith(p))) {
					await k.attr.setBlockAttrs(block.id, { fold: "1" });
				}
			}
		},

		async putAsset({ relPath, content }) {
			await withRetry(() => putFile(`/data/assets/${relPath}`, content));
			return `assets/${relPath}`;
		},

		async findDocBySessionKey(sessionKey) {
			const rows = await k.sql<IdRow>(
				`SELECT id FROM blocks WHERE type='d' AND ial LIKE '%custom-ai-session-key="${escapeIalLike(sessionKey)}"%' LIMIT 1`,
			);
			return rows.find((r) => typeof r.id === "string")?.id;
		},

		async docExists(docId) {
			const rows = await k.sql<IdRow>(
				`SELECT id FROM blocks WHERE id=${sqlValue(docId)} AND type='d' LIMIT 1`,
			);
			return rows.some((r) => typeof r.id === "string");
		},

		// ── Incremental section API (Phase 2) ────────────────────────────────

		async tagSectionAnchors(docId) {
			const children = ((await k.blocks.getChildren(docId)) ?? []) as Array<{
				id?: string;
				type?: string;
			}>;
			const candidateIds = children
				.filter((c) => c?.type === "h" || c?.type === "bq")
				.map((c) => c.id as string)
				.filter(Boolean);
			if (candidateIds.length === 0) return {};

			const kramdowns = await k.blocks.getKramdowns(candidateIds);
			const tagged: Partial<Record<SectionKind, string>> = {};
			for (const child of children) {
				const id = child?.id;
				if (!id) continue;
				const firstLine = (kramdowns[id] ?? "").split("\n", 1)[0] ?? "";
				const kind = classifyAnchor(firstLine, child?.type);
				if (!kind || tagged[kind]) continue;
				tagged[kind] = id;
				await k.attr.setBlockAttrs(id, { [SECTION_ATTR_KEY]: kind });
			}
			return tagged;
		},

		async findSectionBlock(docId, kind) {
			// SiYuan's SQL parser PANICS on ESCAPE — see escapeIalLike. Safe here:
			// section kinds are all simple lowercase strings, no LIKE metacharacters.
			const rows = await k.sql<IdRow>(
				`SELECT id FROM blocks WHERE root_id=${sqlValue(docId)} AND ial LIKE '%${SECTION_ATTR_KEY}="${kind}"%' LIMIT 1`,
			);
			return rows.find((r) => typeof r.id === "string")?.id;
		},

		async replaceSection(docId, kind, markdown) {
			// Strategy: walk top-level blocks once, resolve every anchor by attr,
			// figure out the deletion range (existing anchor → next anchor exclusive,
			// or end of doc), delete that range, then insert new markdown at the
			// preserved boundary. Tag the new anchor so subsequent ops can find it.
			const children = ((await k.blocks.getChildren(docId)) ?? []) as Array<{ id?: string }>;
			if (children.length === 0) return { anchorId: undefined };

			// Anchor map: kind → { id, index } (sequential getBlockAttrs is fine —
			// a doc has at most 5 anchors; this is cheaper than re-fetching kramdowns).
			const anchorByKind = new Map<SectionKind, { id: string; index: number }>();
			for (let i = 0; i < children.length; i++) {
				const id = children[i]?.id;
				if (!id) continue;
				const attrs = await k.attr.getBlockAttrs(id);
				const sec = attrs[SECTION_ATTR_KEY] as SectionKind | undefined;
				if (sec && !anchorByKind.has(sec)) anchorByKind.set(sec, { id, index: i });
			}

			const kindOrderIdx = SECTION_ORDER.indexOf(kind);
			const existing = anchorByKind.get(kind);

			// Where does the section currently end (exclusive)?
			let nextAnchorIdx = children.length;
			for (let i = kindOrderIdx + 1; i < SECTION_ORDER.length; i++) {
				const a = anchorByKind.get(SECTION_ORDER[i]);
				if (a) {
					nextAnchorIdx = a.index;
					break;
				}
			}

			// Pre-compute insertion boundary IDs before deletion shuffles children.
			let previousID: string | undefined;
			let nextID: string | undefined;
			if (existing) {
				if (existing.index > 0) previousID = children[existing.index - 1]?.id;
				if (nextAnchorIdx < children.length) nextID = children[nextAnchorIdx]?.id;
				// Delete the whole section (anchor + body until next anchor).
				for (let i = existing.index; i < nextAnchorIdx; i++) {
					const id = children[i]?.id;
					if (id) await k.blocks.delete(id);
				}
			} else {
				// New section: pick boundary just before the next existing anchor.
				for (let i = kindOrderIdx + 1; i < SECTION_ORDER.length; i++) {
					const a = anchorByKind.get(SECTION_ORDER[i]);
					if (a) {
						nextID = a.id;
						break;
					}
				}
				if (!nextID) {
					// No next section either — sit just after the last existing prior section.
					for (let i = kindOrderIdx - 1; i >= 0; i--) {
						const a = anchorByKind.get(SECTION_ORDER[i]);
						if (a) {
							// last block of that section = block right before the next-of-that anchor,
							// but easier: insert as append at doc end (sections are ordered, and
							// nothing tagged sits after it).
							previousID = children[children.length - 1]?.id;
							break;
						}
					}
				}
			}

			if (markdown.length === 0) {
				// Section removed; nothing to insert.
				return { anchorId: undefined };
			}

			let insertedIds: string[];
			if (previousID) {
				insertedIds = extractInsertedBlockIds(
					await k.blocks.insert({ data: markdown, previousID }),
				);
			} else if (nextID) {
				// Insert with nextID via the kernel's insertBlock — same API supports it.
				insertedIds = extractInsertedBlockIds(
					await k.blocks.insert({ data: markdown, nextID }),
				);
			} else {
				// Empty doc-body fallback (no prior nor next anchor) — prepend.
				insertedIds = extractInsertedBlockIds(
					await k.blocks.prepend({ data: markdown, parentID: docId }),
				);
			}

			const anchorId = insertedIds[0];
			if (anchorId) await k.attr.setBlockAttrs(anchorId, { [SECTION_ATTR_KEY]: kind });
			return { anchorId };
		},

		async appendToSection(docId, kind, markdown) {
			if (markdown.length === 0) return { ids: [] };

			// Find the section AND the next-section anchor; new blocks insert
			// right before that next anchor (or at doc end if none).
			const children = ((await k.blocks.getChildren(docId)) ?? []) as Array<{ id?: string }>;
			const anchorByKind = new Map<SectionKind, { id: string; index: number }>();
			for (let i = 0; i < children.length; i++) {
				const id = children[i]?.id;
				if (!id) continue;
				const attrs = await k.attr.getBlockAttrs(id);
				const sec = attrs[SECTION_ATTR_KEY] as SectionKind | undefined;
				if (sec && !anchorByKind.has(sec)) anchorByKind.set(sec, { id, index: i });
			}

			const kindOrderIdx = SECTION_ORDER.indexOf(kind);
			const existing = anchorByKind.get(kind);
			if (!existing) {
				// No anchor — caller should `replaceSection` first to materialize it.
				return { ids: [] };
			}

			let nextAnchorIdx = children.length;
			for (let i = kindOrderIdx + 1; i < SECTION_ORDER.length; i++) {
				const a = anchorByKind.get(SECTION_ORDER[i]);
				if (a) {
					nextAnchorIdx = a.index;
					break;
				}
			}

			let insertedIds: string[];
			if (nextAnchorIdx < children.length) {
				// Insert before the next anchor (preserves section ordering).
				const nextID = children[nextAnchorIdx]?.id as string;
				insertedIds = extractInsertedBlockIds(
					await k.blocks.insert({ data: markdown, nextID }),
				);
			} else {
				// Last section — just append at doc end.
				insertedIds = extractInsertedBlockIds(
					await k.blocks.append({ data: markdown, parentID: docId }),
				);
			}
			return { ids: insertedIds };
		},
	};
}
