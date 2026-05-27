import { describe, expect, it } from "vitest";
import { createSiyuanWriter } from "../../src/core/session-sync/adapters/siyuan-writer";
import type { SiyuanKernel } from "../../src/core/session-sync/../tools/siyuan-kernel";

/** Minimal in-memory kernel that records children + attrs and supports the
 *  block ops the section writer needs (getChildren, getKramdowns, setBlockAttrs,
 *  getBlockAttrs, insert/append/prepend/delete). One doc per test. */
function makeKernel(initial: Array<{ id: string; type?: string; firstLine?: string }>): {
	kernel: SiyuanKernel;
	state: {
		children: Array<{ id: string; type?: string; firstLine?: string }>;
		attrs: Record<string, Record<string, string>>;
		log: string[];
	};
} {
	let counter = 100;
	const children = [...initial];
	const attrs: Record<string, Record<string, string>> = {};
	const log: string[] = [];
	const nextId = () => `b${++counter}`;

	const kernel: SiyuanKernel = {
		blocks: {
			getKramdowns: async (ids) => {
				const out: Record<string, string> = {};
				for (const id of ids) {
					const b = children.find((c) => c.id === id);
					if (b) out[id] = b.firstLine ?? "";
				}
				return out;
			},
			getTreeInfos: async () => ({}),
			getChildren: async () => children.map((c) => ({ id: c.id, type: c.type })),
			insert: async ({ data, previousID, nextID }) => {
				const id = nextId();
				const firstLine = data.split("\n")[0] ?? "";
				const idx = previousID
					? children.findIndex((c) => c.id === previousID) + 1
					: nextID
						? children.findIndex((c) => c.id === nextID)
						: children.length;
				children.splice(idx, 0, { id, type: firstLine.startsWith("##") ? "h" : firstLine.startsWith(">") ? "bq" : "p", firstLine });
				log.push(`insert ${id} @${idx} "${firstLine}"`);
				return [{ doOperations: [{ id }], undoOperations: [] }];
			},
			prepend: async ({ data, parentID: _parentID }) => {
				const id = nextId();
				const firstLine = data.split("\n")[0] ?? "";
				children.unshift({ id, type: firstLine.startsWith("##") ? "h" : firstLine.startsWith(">") ? "bq" : "p", firstLine });
				log.push(`prepend ${id} "${firstLine}"`);
				return [{ doOperations: [{ id }], undoOperations: [] }];
			},
			append: async ({ data, parentID: _parentID }) => {
				const id = nextId();
				const firstLine = data.split("\n")[0] ?? "";
				children.push({ id, type: firstLine.startsWith("##") ? "h" : firstLine.startsWith(">") ? "bq" : "p", firstLine });
				log.push(`append ${id} "${firstLine}"`);
				return [{ doOperations: [{ id }], undoOperations: [] }];
			},
			delete: async (id) => {
				const i = children.findIndex((c) => c.id === id);
				if (i >= 0) {
					children.splice(i, 1);
					log.push(`delete ${id}`);
				}
				return [];
			},
		},
		attr: {
			setBlockAttrs: async (id, a) => {
				attrs[id] = { ...(attrs[id] ?? {}), ...a };
				log.push(`setAttr ${id} ${JSON.stringify(a)}`);
			},
			getBlockAttrs: async (id) => attrs[id] ?? {},
		},
		filetree: {} as never,
		notebooks: {} as never,
		exportApi: {} as never,
		search: {} as never,
		sql: async <T,>() => [] as T[],
	};
	return { kernel, state: { children, attrs, log } };
}

describe("siyuan-writer section API", () => {
	it("tagSectionAnchors classifies each anchor by content + sets custom-section attr", async () => {
		const { kernel, state } = makeKernel([
			{ id: "h1", type: "h", firstLine: "## 📋 概览" },
			{ id: "t1", type: "p", firstLine: "| field | value |" },
			{ id: "bq1", type: "bq", firstLine: "> 🎯 **问** hello" },
			{ id: "h2", type: "h", firstLine: "## 💬 对话" },
			{ id: "p1", type: "p", firstLine: "> 🧑" },
			{ id: "h3", type: "h", firstLine: "## 🔧 工具调用 (3)" },
			{ id: "h4", type: "h", firstLine: "## ⚠️ 解析警告" },
		]);
		const writer = createSiyuanWriter(kernel);
		const tagged = await writer.tagSectionAnchors("doc");
		expect(tagged).toEqual({ overview: "h1", summary: "bq1", dialog: "h2", tools: "h3", warnings: "h4" });
		expect(state.attrs.h1).toEqual({ "custom-section": "overview" });
		expect(state.attrs.bq1).toEqual({ "custom-section": "summary" });
		expect(state.attrs.h2).toEqual({ "custom-section": "dialog" });
		expect(state.attrs.h3).toEqual({ "custom-section": "tools" });
		expect(state.attrs.h4).toEqual({ "custom-section": "warnings" });
	});

	it("replaceSection deletes anchor + body until next anchor and inserts new content", async () => {
		const { kernel, state } = makeKernel([
			{ id: "h1", type: "h", firstLine: "## 📋 概览" },
			{ id: "t1", type: "p", firstLine: "| field | value |" },
			{ id: "t2", type: "p", firstLine: "| 来源 | codex |" },
			{ id: "h2", type: "h", firstLine: "## 💬 对话" },
			{ id: "p1", type: "p", firstLine: "> 🧑" },
		]);
		// Pre-tag (simulate prior tagSectionAnchors run).
		state.attrs.h1 = { "custom-section": "overview" };
		state.attrs.h2 = { "custom-section": "dialog" };

		const writer = createSiyuanWriter(kernel);
		const { anchorId } = await writer.replaceSection("doc", "overview", "## 📋 概览\n\n| 来源 | claude |");

		// Old overview blocks (h1 + t1 + t2) all deleted; new anchor inserted in their place.
		expect(state.children.map((c) => c.id)).not.toContain("h1");
		expect(state.children.map((c) => c.id)).not.toContain("t1");
		expect(state.children.map((c) => c.id)).not.toContain("t2");
		expect(state.children.find((c) => c.id === "h2")).toBeTruthy(); // dialog untouched
		expect(anchorId).toBeDefined();
		expect(state.attrs[anchorId!]).toEqual({ "custom-section": "overview" });
	});

	it("replaceSection on a missing section inserts before the next existing anchor", async () => {
		const { kernel, state } = makeKernel([
			{ id: "h1", type: "h", firstLine: "## 📋 概览" },
			{ id: "h2", type: "h", firstLine: "## 💬 对话" },
		]);
		state.attrs.h1 = { "custom-section": "overview" };
		state.attrs.h2 = { "custom-section": "dialog" };

		const writer = createSiyuanWriter(kernel);
		const { anchorId } = await writer.replaceSection("doc", "summary", "> 🎯 **问** new\n>\n> **答** new");

		// Summary block should sit between overview (h1) and dialog (h2).
		const ids = state.children.map((c) => c.id);
		const idxOverview = ids.indexOf("h1");
		const idxDialog = ids.indexOf("h2");
		const idxSummary = ids.indexOf(anchorId!);
		expect(idxSummary).toBeGreaterThan(idxOverview);
		expect(idxSummary).toBeLessThan(idxDialog);
	});

	it("replaceSection with empty markdown removes the section entirely", async () => {
		const { kernel, state } = makeKernel([
			{ id: "h1", type: "h", firstLine: "## 📋 概览" },
			{ id: "h2", type: "h", firstLine: "## 🔧 工具调用 (1)" },
			{ id: "p1", type: "p", firstLine: "- ✅ shell" },
		]);
		state.attrs.h1 = { "custom-section": "overview" };
		state.attrs.h2 = { "custom-section": "tools" };

		const writer = createSiyuanWriter(kernel);
		const { anchorId } = await writer.replaceSection("doc", "tools", "");

		expect(anchorId).toBeUndefined();
		expect(state.children.map((c) => c.id)).toEqual(["h1"]);
	});

	it("appendToSection inserts before the next section's anchor (preserves order)", async () => {
		const { kernel, state } = makeKernel([
			{ id: "h1", type: "h", firstLine: "## 💬 对话" },
			{ id: "p1", type: "p", firstLine: "> 🧑" },
			{ id: "p2", type: "p", firstLine: "> hi" },
			{ id: "h2", type: "h", firstLine: "## 🔧 工具调用 (1)" },
		]);
		state.attrs.h1 = { "custom-section": "dialog" };
		state.attrs.h2 = { "custom-section": "tools" };

		const writer = createSiyuanWriter(kernel);
		const { ids } = await writer.appendToSection("doc", "dialog", "🤖\n\nfollow-up");

		expect(ids.length).toBeGreaterThan(0);
		const finalIds = state.children.map((c) => c.id);
		const idxNew = finalIds.indexOf(ids[0]);
		const idxTools = finalIds.indexOf("h2");
		expect(idxNew).toBeGreaterThan(finalIds.indexOf("p2")); // after existing dialog body
		expect(idxNew).toBeLessThan(idxTools); // before tools section
	});

	it("appendToSection on the last section appends at doc end", async () => {
		const { kernel, state } = makeKernel([
			{ id: "h1", type: "h", firstLine: "## 💬 对话" },
			{ id: "h2", type: "h", firstLine: "## ⚠️ 解析警告" },
			{ id: "w1", type: "p", firstLine: "- warning 1" },
		]);
		state.attrs.h1 = { "custom-section": "dialog" };
		state.attrs.h2 = { "custom-section": "warnings" };

		const writer = createSiyuanWriter(kernel);
		const { ids } = await writer.appendToSection("doc", "warnings", "- warning 2");

		expect(ids).toHaveLength(1);
		expect(state.children[state.children.length - 1].id).toBe(ids[0]);
	});

	it("appendToSection with empty markdown is a no-op", async () => {
		const { kernel, state } = makeKernel([{ id: "h1", type: "h", firstLine: "## 💬 对话" }]);
		state.attrs.h1 = { "custom-section": "dialog" };
		const writer = createSiyuanWriter(kernel);
		const { ids } = await writer.appendToSection("doc", "dialog", "");
		expect(ids).toEqual([]);
		expect(state.log.filter((l) => l.startsWith("insert"))).toHaveLength(0);
	});

	it("appendToSection without a tagged anchor is a no-op (returns empty ids)", async () => {
		const { kernel } = makeKernel([{ id: "h1", type: "h", firstLine: "## 💬 对话" }]);
		// Note: no attrs set — anchor not tagged yet.
		const writer = createSiyuanWriter(kernel);
		const { ids } = await writer.appendToSection("doc", "dialog", "🤖\n\nfollow-up");
		expect(ids).toEqual([]);
	});
});
