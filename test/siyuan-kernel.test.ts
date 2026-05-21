import { describe, expect, it } from "vitest";
import { makeKernel, sqlValue, type KernelFetcher } from "../src/core/tools/siyuan-kernel";

function createFetcher(returnValue: any = undefined) {
	const calls: Array<{ url: string; data: any }> = [];
	const fetcher: KernelFetcher = async (url, data) => {
		calls.push({ url, data });
		return returnValue;
	};
	return { fetcher, calls };
}

describe("sqlValue", () => {
	it("wraps a plain string in single quotes", () => {
		expect(sqlValue("doc-123")).toBe("'doc-123'");
	});

	it("doubles single quotes to escape them", () => {
		expect(sqlValue("O'Brien")).toBe("'O''Brien'");
		expect(sqlValue("a'b'c")).toBe("'a''b''c'");
	});

	it("escapes a string that is only quotes", () => {
		expect(sqlValue("'")).toBe("''''");
	});

	it("preserves LIKE wildcards inside the quoted literal", () => {
		expect(sqlValue("%term%")).toBe("'%term%'");
	});
});

describe("siyuan-kernel operations", () => {
	it("blocks.getKramdowns posts ids", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.getKramdowns(["a", "b"]);
		expect(calls[0]).toEqual({ url: "/api/block/getBlockKramdowns", data: { ids: ["a", "b"] } });
	});

	it("blocks.getTreeInfos posts ids", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.getTreeInfos(["x"]);
		expect(calls[0]).toEqual({ url: "/api/block/getBlockTreeInfos", data: { ids: ["x"] } });
	});

	it("blocks.getChildren posts id", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.getChildren("doc1");
		expect(calls[0]).toEqual({ url: "/api/block/getChildBlocks", data: { id: "doc1" } });
	});

	it("blocks.insert defaults dataType to markdown", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.insert({ data: "# hi", previousID: "prev" });
		expect(calls[0]).toEqual({
			url: "/api/block/insertBlock",
			data: { dataType: "markdown", data: "# hi", previousID: "prev" },
		});
	});

	it("blocks.insert allows overriding dataType", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.insert({ data: "x", dataType: "dom", parentID: "p" });
		expect(calls[0]).toEqual({
			url: "/api/block/insertBlock",
			data: { dataType: "dom", data: "x", parentID: "p" },
		});
	});

	it("blocks.prepend defaults dataType to markdown", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.prepend({ data: "y", parentID: "p" });
		expect(calls[0]).toEqual({
			url: "/api/block/prependBlock",
			data: { dataType: "markdown", data: "y", parentID: "p" },
		});
	});

	it("blocks.append defaults dataType to markdown", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.append({ data: "z", parentID: "p" });
		expect(calls[0]).toEqual({
			url: "/api/block/appendBlock",
			data: { dataType: "markdown", data: "z", parentID: "p" },
		});
	});

	it("blocks.delete posts id", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).blocks.delete("b1");
		expect(calls[0]).toEqual({ url: "/api/block/deleteBlock", data: { id: "b1" } });
	});

	it("filetree.createDocWithMd posts notebook/path/markdown", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.createDocWithMd({ notebook: "nb", path: "/p", markdown: "md" });
		expect(calls[0]).toEqual({
			url: "/api/filetree/createDocWithMd",
			data: { notebook: "nb", path: "/p", markdown: "md" },
		});
	});

	it("filetree.moveDocsByID posts fromIDs/toID", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.moveDocsByID(["a", "b"], "t");
		expect(calls[0]).toEqual({
			url: "/api/filetree/moveDocsByID",
			data: { fromIDs: ["a", "b"], toID: "t" },
		});
	});

	it("filetree.renameDocByID posts id/title", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.renameDocByID("d1", "New Title");
		expect(calls[0]).toEqual({
			url: "/api/filetree/renameDocByID",
			data: { id: "d1", title: "New Title" },
		});
	});

	it("filetree.removeDocByID posts id", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.removeDocByID("d1");
		expect(calls[0]).toEqual({ url: "/api/filetree/removeDocByID", data: { id: "d1" } });
	});

	it("filetree.getIDsByHPath posts notebook/path", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.getIDsByHPath("nb", "/A/B");
		expect(calls[0]).toEqual({
			url: "/api/filetree/getIDsByHPath",
			data: { notebook: "nb", path: "/A/B" },
		});
	});

	it("filetree.getPathByID posts id", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.getPathByID("d1");
		expect(calls[0]).toEqual({ url: "/api/filetree/getPathByID", data: { id: "d1" } });
	});

	it("filetree.listDocsByPath injects ignoreMaxListHint", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.listDocsByPath({ notebook: "nb", path: "/p", maxListCount: 5 });
		expect(calls[0]).toEqual({
			url: "/api/filetree/listDocsByPath",
			data: { notebook: "nb", path: "/p", maxListCount: 5, ignoreMaxListHint: true },
		});
	});

	it("filetree.getHPathByID posts id", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).filetree.getHPathByID("d1");
		expect(calls[0]).toEqual({ url: "/api/filetree/getHPathByID", data: { id: "d1" } });
	});

	it("notebooks.list posts empty payload", async () => {
		const { fetcher, calls } = createFetcher();
		await makeKernel(fetcher).notebooks.list();
		expect(calls[0]).toEqual({ url: "/api/notebook/lsNotebooks", data: {} });
	});

	it("exportApi.mdContent posts id", async () => {
		const { fetcher, calls } = createFetcher({ content: "c", hPath: "/h" });
		const result = await makeKernel(fetcher).exportApi.mdContent("d1");
		expect(calls[0]).toEqual({ url: "/api/export/exportMdContent", data: { id: "d1" } });
		expect(result).toEqual({ content: "c", hPath: "/h" });
	});

	it("search.fullText forwards the full request payload", async () => {
		const { fetcher, calls } = createFetcher();
		const req = {
			query: "hello",
			page: 1,
			pageSize: 10,
			types: { document: true },
			method: 0,
			orderBy: 0,
			groupBy: 0,
		};
		await makeKernel(fetcher).search.fullText(req);
		expect(calls[0]).toEqual({ url: "/api/search/fullTextSearchBlock", data: req });
	});

	it("sql posts the statement under stmt", async () => {
		const { fetcher, calls } = createFetcher([{ id: "a" }]);
		const rows = await makeKernel(fetcher).sql("SELECT id FROM blocks LIMIT 1");
		expect(calls[0]).toEqual({
			url: "/api/query/sql",
			data: { stmt: "SELECT id FROM blocks LIMIT 1" },
		});
		expect(rows).toEqual([{ id: "a" }]);
	});
});
