import { defineTool } from "./define-tool";
import { z } from "zod";
import { openTab } from "siyuan";
import { emitActivity } from "./siyuan-api";
import { kernel, sqlValue } from "./siyuan-kernel";
import { defaultTranslator, type Translator } from "../../i18n";

function extractOperationBlockIds(data: any): string[] {
	if (!Array.isArray(data)) return [];
	const ids: string[] = [];
	for (const item of data) {
		const operations = Array.isArray(item?.doOperations) ? item.doOperations : [];
		for (const operation of operations) {
			if (typeof operation?.id === "string" && operation.id) {
				ids.push(operation.id);
			}
		}
	}
	return ids;
}

export function createEditBlocksTool(i18n: Translator = defaultTranslator) {
return defineTool(
	async ({ blocks }, ctx) => {
		const ids = blocks.map((b: { id: string }) => b.id);
		const originals: Record<string, string> = await kernel.blocks.getKramdowns(ids);
		const treeInfos: Record<string, any> = await kernel.blocks.getTreeInfos(ids);

		const results: any[] = [];

		for (const block of blocks) {
			const original = originals[block.id];
			const info = treeInfos[block.id];
			const rootDocId: string | undefined = typeof info?.rootID === "string" && info.rootID ? info.rootID : undefined;
			if (original === undefined) {
				results.push({
					oldId: block.id,
					rootDocId,
					status: "error",
					error: i18n.t("tool.error.blockNotFound", { id: block.id }),
				});
				continue;
			}

			try {
				// Use insertBlock + deleteBlock instead of updateBlock so that
				// multi-block markdown is correctly expanded into multiple blocks.
				// (updateBlock only keeps FirstChild, discarding the rest.)
				//
				// insertBlock with previousID correctly inserts ALL parsed blocks.
				// nextID has a bug in siyuan's doInsert: it only inserts FirstChild.
				// So we must use previousID. When the block has no previous sibling,
				// fall back to prependBlock (insert as first child of parent).
				const previousID: string = info?.previousID ?? "";
				const parentID: string = info?.parentID ?? "";
				let insertResult: any;

				if (previousID) {
					insertResult = await kernel.blocks.insert({
						data: block.content,
						previousID,
					});
				} else {
					insertResult = await kernel.blocks.prepend({
						data: block.content,
						parentID,
					});
				}
				const newIds = extractOperationBlockIds(insertResult);
				await kernel.blocks.delete(block.id);
				results.push({
					oldId: block.id,
					newIds,
					rootDocId,
					status: "ok",
					original,
					updated: block.content,
				});
			} catch (err: any) {
				results.push({
					oldId: block.id,
					rootDocId,
					status: "error",
					error: err.message,
					original,
				});
			}
		}

		if (ctx.canEmit) {
			const rootIDs = [...new Set(
				ids
					.map((id) => treeInfos[id]?.rootID)
					.filter((rootID: unknown): rootID is string => typeof rootID === "string" && rootID.length > 0)
			)];
			let path = "";
			if (rootIDs.length > 0) {
				const rootDoc = await kernel.sql(
					`SELECT id, hpath FROM blocks WHERE id=${sqlValue(rootIDs[0])} LIMIT 1`,
				);
				path = rootDoc?.[0]?.hpath || "";
			}
			emitActivity(ctx, {
				category: "change",
				action: "edit",
				id: rootIDs[0],
				path,
				label: path || rootIDs[0],
				meta: i18n.t("tool.editBlocks.meta", { count: results.filter((item) => item.status === "ok").length }),
				open: true,
			});
		}

		return JSON.stringify({ __tool_type: "edit_blocks", results });
	},
	{
		name: "edit_blocks",
		description: "Edit one or more blocks by providing new markdown content. First use get_document_blocks to get block IDs and current content, then call this tool with the modified content. Changes are applied immediately by inserting replacement blocks and deleting the old blocks, so the original block IDs become invalid. The result returns oldId, newIds, and rootDocId for each edit; use newIds for any further edits in the same turn, or call get_document_blocks again before continuing. Only modify the blocks that need changes — do not rewrite entire documents. Provide complete plain markdown content (not kramdown).",
		schema: z.object({
			blocks: z.array(z.object({
				id: z.string().describe("Block ID to edit (from get_document_blocks)"),
				content: z.string().min(1).describe("New markdown content for this block"),
			})).describe("Array of blocks to edit"),
		}),
	}
);
}

export function createAppendBlockTool(i18n: Translator = defaultTranslator) {
return defineTool(
	async ({ parentID, markdown }, ctx) => {
		const data = await kernel.blocks.append({
			data: markdown,
			parentID,
		});
		const docInfo = await kernel.sql(
			`SELECT id, hpath FROM blocks WHERE id=${sqlValue(parentID)} LIMIT 1`,
		);
		const blockIDs = Array.isArray(data)
			? data.map((item: any) => item?.doOperations?.[0]?.id).filter(Boolean)
			: [];
		emitActivity(ctx, {
			category: "change",
			action: "append",
			id: parentID,
			path: docInfo?.[0]?.hpath || "",
			label: docInfo?.[0]?.hpath || parentID,
			meta: i18n.t("tool.appendBlock.meta", { count: blockIDs.length || 0 }),
			open: true,
		});
		return JSON.stringify(data, null, 2);
	},
	{
		name: "append_block",
		description: "Append Markdown content as child blocks to an existing block (usually a document). Use this to add new content to a document.",
		schema: z.object({
			parentID: z.string().describe("The parent block ID to append content to. Usually a document ID from list_documents or search results."),
			markdown: z.string().describe("Markdown content to append"),
		}),
	}
);
}

export function createCreateDocumentTool(i18n: Translator = defaultTranslator) {
return defineTool(
	async ({ notebook, path, markdown }, ctx) => {
		const id = await kernel.filetree.createDocWithMd({
			notebook,
			path,
			markdown: markdown || "",
		});
		openTab({ app: (globalThis as any).siyuanApp, doc: { id } });
		emitActivity(ctx, {
			category: "change",
			action: "create",
			id,
			path,
			label: path,
			meta: i18n.t("tool.createDocument.meta"),
			open: true,
		});
		return JSON.stringify({ id, notebook, path });
	},
	{
		name: "create_document",
		description: "Create a new document (note) in a notebook with optional Markdown content. The path is the human-readable path (hpath) like '/Folder/My Note'. Returns the new document's ID.",
		schema: z.object({
			notebook: z.string().describe("Notebook ID (from list_notebooks)"),
			path: z.string().describe("Human-readable path for the new document, e.g. '/Daily Notes/2024-01-01' or '/Project/Meeting Notes'"),
			markdown: z.string().optional().describe("Initial Markdown content for the document. Defaults to empty."),
		}),
	}
);
}

export function createMoveDocumentTool(i18n: Translator = defaultTranslator) {
return defineTool(
	async ({ fromIDs, toID }, ctx) => {
		await kernel.filetree.moveDocsByID(fromIDs, toID);
		emitActivity(ctx, {
			category: "change",
			action: "move",
			id: fromIDs[0],
			label: fromIDs.length > 1 ? i18n.t("tool.moveDocument.labelMultiple", { first: fromIDs[0], count: fromIDs.length }) : fromIDs[0],
			meta: i18n.t("tool.moveDocument.meta", { target: toID }),
		});
		return JSON.stringify({ ok: true, fromIDs, toID });
	},
	{
		name: "move_document",
		description: "Move one or more documents to a different location. toID can be a notebook ID (moves to notebook root) or a document ID (moves inside that document as sub-document).",
		schema: z.object({
			fromIDs: z.array(z.string()).describe("Array of document IDs to move"),
			toID: z.string().describe("Target notebook ID or parent document ID"),
		}),
	}
);
}

export function createRenameDocumentTool(i18n: Translator = defaultTranslator) {
return defineTool(
	async ({ id, title }, ctx) => {
		await kernel.filetree.renameDocByID(id, title);
		emitActivity(ctx, {
			category: "change",
			action: "rename",
			id,
			label: title,
			meta: i18n.t("tool.renameDocument.meta"),
			open: true,
		});
		return JSON.stringify({ ok: true, id, title });
	},
	{
		name: "rename_document",
		description: "Rename a document by changing its title.",
		schema: z.object({
			id: z.string().describe("Document ID to rename"),
			title: z.string().describe("New title for the document"),
		}),
	}
);
}

// High-impact and not undoable in-app — only registered in interactive chat
// (via getDefaultTools opts), never in the autonomous scheduled-task toolset.
export function createDeleteDocumentTool(i18n: Translator = defaultTranslator) {
return defineTool(
	async ({ id }, ctx) => {
		// Best-effort: resolve a human-readable target before deleting so the
		// activity card and the returned record name the doc, not just its ID.
		let hPath = "";
		try {
			hPath = await kernel.filetree.getHPathByID(id);
		} catch {
			// Ignore: a bad/stale ID surfaces below when removeDocByID errors.
		}
		const title = hPath.split("/").filter(Boolean).pop() || id;
		await kernel.filetree.removeDocByID(id);
		emitActivity(ctx, {
			category: "change",
			action: "delete",
			id,
			label: title,
			meta: i18n.t("tool.deleteDocument.meta"),
		});
		return JSON.stringify({ ok: true, id, title, path: hPath || undefined });
	},
	{
		name: "delete_document",
		description:
			"Delete a document and all of its sub-documents by ID. This removes the whole subtree and is NOT undoable in-app — recovery is only possible through SiYuan's Data History, if enabled. Confirm the exact target document with the user before calling this.",
		schema: z.object({
			id: z.string().describe("Document ID to delete (its sub-documents are deleted too)"),
		}),
	}
);
}

export const editBlocksTool = createEditBlocksTool();
export const appendBlockTool = createAppendBlockTool();
export const createDocumentTool = createCreateDocumentTool();
export const moveDocumentTool = createMoveDocumentTool();
export const renameDocumentTool = createRenameDocumentTool();
