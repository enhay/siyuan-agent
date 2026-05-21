import { describe, expect, it } from "vitest";
import { reconcileOnce } from "../../src/core/session-sync/engine/reconcile";
import { collectChildLinks, pendingChildMoves } from "../../src/core/session-sync/engine/aggregate";
import type { DiscoveredFile, FileSource, SiyuanWriter, StateStore } from "../../src/core/session-sync/engine/ports";
import type { SyncState } from "../../src/core/session-sync/engine/types";

function codex(id: string, opts: { role?: string; nickname?: string; parent?: string } = {}): string {
	const payload: Record<string, unknown> = { id, cwd: "/x/proj", model: "m", timestamp: "2026-05-01T10:00:00Z" };
	if (opts.role) payload.agent_role = opts.role;
	if (opts.nickname) payload.agent_nickname = opts.nickname;
	if (opts.parent) payload.source = { subagent: { thread_spawn: { parent_thread_id: opts.parent } } };
	return [
		{ timestamp: "2026-05-01T10:00:00Z", type: "session_meta", payload },
		{ timestamp: "2026-05-01T10:00:05Z", type: "event_msg", payload: { type: "user_message", message: `task ${id}` } },
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
}

class FakeWriter implements SiyuanWriter {
	docs = new Map<string, { markdown: string; exists: boolean }>();
	byKey = new Map<string, string>();
	moves: Array<{ childIds: string[]; parentDocId: string }> = [];
	private seq = 0;
	async createDoc({ markdown }: { notebook: string; path: string; markdown: string }) {
		const id = `doc-${++this.seq}`;
		this.docs.set(id, { markdown, exists: true });
		return { id };
	}
	async overwriteDoc({ docId, markdown }: { docId: string; markdown: string }) {
		const d = this.docs.get(docId);
		if (d) d.markdown = markdown;
	}
	async setAttrs({ docId, attrs }: { docId: string; attrs: Record<string, string> }) {
		const k = attrs["custom-ai-session-key"];
		if (k) this.byKey.set(k, docId);
	}
	async renameDoc() {}
	async moveUnder(input: { childIds: string[]; parentDocId: string }) {
		this.moves.push(input);
	}
	async foldHeadings() {}
	async findDocBySessionKey(k: string) {
		const id = this.byKey.get(k);
		return id && this.docs.get(id)?.exists ? id : undefined;
	}
	async docExists(id: string) {
		return !!this.docs.get(id)?.exists;
	}
}

function memState(initial?: SyncState): StateStore {
	let s: SyncState = initial ?? { files: {}, sessions: {} };
	return { async load() { return s; }, async save(n) { s = n; } };
}

function fileSource(files: Array<{ file: DiscoveredFile; content: string }>): FileSource {
	return {
		async list() { return files.map((f) => f.file); },
		async read(path) { const f = files.find((x) => x.file.path === path); if (!f) throw new Error("nf"); return f.content; },
		async probe() { return String(files.length); },
	};
}

const f = (source: "codex", path: string, size: number, content: string) => ({ file: { source, path, sizeBytes: size, mtimeMs: size }, content });

describe("aggregate helpers", () => {
	const state: SyncState = {
		files: {},
		sessions: {
			"codex:main": { target: "siyuan", docId: "pdoc", sessionId: "main", source: "codex" },
			"codex:w1": { target: "siyuan", docId: "c1", sessionId: "w1", source: "codex", parentSessionId: "main", agentRole: "worker", createdAt: "2026-05-01T10:00:00Z", title: "task w1" },
			"codex:w2": { target: "siyuan", docId: "c2", sessionId: "w2", source: "codex", parentSessionId: "main", agentRole: "explorer", createdAt: "2026-05-01T11:00:00Z", title: "task w2" },
		},
	};

	it("collectChildLinks returns children sorted by createdAt", () => {
		const links = collectChildLinks(state, "codex", "main");
		expect(links.map((l) => l.docId)).toEqual(["c1", "c2"]);
		expect(links[0]).toMatchObject({ title: "task w1", role: "worker" });
	});

	it("pendingChildMoves returns un-nested children, skips already nested + orphans", () => {
		expect(pendingChildMoves(state).map((m) => m.childDocId).sort()).toEqual(["c1", "c2"]);
		const nested: SyncState = { files: {}, sessions: { ...state.sessions, "codex:w1": { ...state.sessions["codex:w1"], movedUnderParent: "pdoc" } } };
		expect(pendingChildMoves(nested).map((m) => m.childDocId)).toEqual(["c2"]);
		const orphan: SyncState = { files: {}, sessions: { "codex:w9": { target: "siyuan", docId: "c9", sessionId: "w9", source: "codex", parentSessionId: "nope" } } };
		expect(pendingChildMoves(orphan)).toEqual([]);
	});
});

describe("reconcile aggregation (codex parent + children)", () => {
	it("nests children under the parent doc and links them in the parent body", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const files = fileSource([
			f("codex", "/a/main.jsonl", 100, codex("main")),
			f("codex", "/a/w1.jsonl", 110, codex("w1", { role: "worker", nickname: "Ada", parent: "main" })),
			f("codex", "/a/w2.jsonl", 120, codex("w2", { role: "explorer", nickname: "Tu", parent: "main" })),
		]);
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });

		// 3 docs created; 2 children moved under the parent doc.
		expect(writer.docs.size).toBe(3);
		const parentId = writer.byKey.get("codex:main")!;
		const c1 = writer.byKey.get("codex:w1")!;
		const c2 = writer.byKey.get("codex:w2")!;
		expect(writer.moves).toHaveLength(2);
		expect(writer.moves.every((m) => m.parentDocId === parentId)).toBe(true);
		expect(writer.moves.map((m) => m.childIds[0]).sort()).toEqual([c1, c2].sort());

		// Parent body lists the children as block refs.
		const parentMd = writer.docs.get(parentId)!.markdown;
		expect(parentMd).toContain("## 🧩 子代理");
		expect(parentMd).toContain(`((${c1}`);
		expect(parentMd).toContain(`((${c2}`);
	});

	it("B2: a mid-chain agent (A→B→C) lists its own child C in its body", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const files = fileSource([
			f("codex", "/a/A.jsonl", 100, codex("A")),
			f("codex", "/a/B.jsonl", 110, codex("B", { role: "worker", parent: "A" })),
			f("codex", "/a/C.jsonl", 120, codex("C", { role: "explorer", parent: "B" })),
		]);
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });
		const bId = writer.byKey.get("codex:B")!;
		const cId = writer.byKey.get("codex:C")!;
		// B is a sub-agent of A, but also a parent of C → B's body must link C.
		expect(writer.docs.get(bId)!.markdown).toContain(`((${cId}`);
		// C nested under B, B nested under A.
		expect(writer.moves.some((m) => m.childIds[0] === cId && m.parentDocId === bId)).toBe(true);
		expect(writer.moves.some((m) => m.childIds[0] === bId && m.parentDocId === writer.byKey.get("codex:A"))).toBe(true);
	});

	it("nests a late-arriving child under a parent synced on an earlier run", async () => {
		const writer = new FakeWriter();
		const state = memState();
		// Run 1: only the parent exists.
		await reconcileOnce({ files: fileSource([f("codex", "/a/main.jsonl", 100, codex("main"))]), writer, state, notebookId: "nb", rootPath: "/AI" });
		expect(writer.moves).toHaveLength(0);
		// Run 2: a child appears; the parent file is unchanged (fast-path skipped),
		// yet the full-state move pass nests the child under the existing parent.
		await reconcileOnce({
			files: fileSource([
				f("codex", "/a/main.jsonl", 100, codex("main")),
				f("codex", "/a/w1.jsonl", 110, codex("w1", { role: "worker", parent: "main" })),
			]),
			writer, state, notebookId: "nb", rootPath: "/AI",
		});
		expect(writer.moves).toHaveLength(1);
		expect(writer.moves[0].parentDocId).toBe(writer.byKey.get("codex:main"));
		expect(writer.moves[0].childIds[0]).toBe(writer.byKey.get("codex:w1"));
	});

	it("does not re-move children on an unchanged second run (idempotent)", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const files = fileSource([
			f("codex", "/a/main.jsonl", 100, codex("main")),
			f("codex", "/a/w1.jsonl", 110, codex("w1", { role: "worker", parent: "main" })),
		]);
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });
		expect(writer.moves).toHaveLength(1);
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });
		expect(writer.moves).toHaveLength(1); // fast-path skip + movedUnderParent flag → no re-move
	});
});
