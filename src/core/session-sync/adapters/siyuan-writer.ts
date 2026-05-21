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

export function createSiyuanWriter(k: SiyuanKernel = defaultKernel): SiyuanWriter {
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

		async moveUnder({ childIds, parentDocId }) {
			if (childIds.length > 0) await k.filetree.moveDocsByID(childIds, parentDocId);
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
