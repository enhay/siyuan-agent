/** SiyuanWriter backed by the kernel API (same-origin `siyuanFetch`).
 *
 *  Update overwrites the body via clear-children + append (kernel `updateBlock`
 *  only keeps FirstChild). Recovery and existence checks go through SQL on the
 *  document's IAL. Inject a fake `SiyuanKernel` in tests. See plan §8. */

import { kernel as defaultKernel, sqlValue, type SiyuanKernel } from "../../tools/siyuan-kernel";
import type { SiyuanWriter } from "../engine/ports";

/** Escape a value for embedding inside a SQL `LIKE '…' ESCAPE '\'` pattern.
 *  - `\`, `%`, `_` are LIKE metacharacters → backslash-escaped.
 *  - IAL attribute values are HTML-escaped, so a literal `"` is stored as `&quot;`
 *    (load-bearing for values with quotes; harmless otherwise).
 *  - `'` is doubled for the SQL string literal. */
function escapeIalLike(value: string): string {
	return value
		.replace(/[\\%_]/g, "\\$&")
		.replace(/'/g, "''")
		.replace(/"/g, "&quot;");
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
			const children = await k.blocks.getChildren(docId);
			for (const child of children ?? []) {
				if (child?.id) await k.blocks.delete(child.id);
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
				`SELECT id FROM blocks WHERE type='d' AND ial LIKE '%custom-ai-session-key="${escapeIalLike(sessionKey)}"%' ESCAPE '\\' LIMIT 1`,
			);
			return rows.find((r) => typeof r.id === "string")?.id;
		},

		async docExists(docId) {
			const rows = await k.sql<IdRow>(
				`SELECT id FROM blocks WHERE id=${sqlValue(docId)} AND type='d' LIMIT 1`,
			);
			return rows.some((r) => typeof r.id === "string");
		},
	};
}
