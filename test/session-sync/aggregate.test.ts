import { describe, expect, it } from "vitest";
import { reconcileOnce } from "../../src/core/session-sync/engine/reconcile";
import { collectChildLinks } from "../../src/core/session-sync/engine/aggregate";
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
		// 2nd message keeps the fixture above the trivial-session threshold.
		{ timestamp: "2026-05-01T10:00:10Z", type: "event_msg", payload: { type: "agent_message", message: `working on ${id}` } },
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
}

class FakeWriter implements SiyuanWriter {
	docs = new Map<string, { markdown: string; exists: boolean }>();
	assets = new Map<string, string>(); // relPath -> content
	byKey = new Map<string, string>();
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
	async foldHeadings() {}
	async putAsset({ relPath, content }: { relPath: string; content: string }) {
		this.assets.set(relPath, content);
		return `assets/${relPath}`;
	}
	async findDocBySessionKey(k: string) {
		const id = this.byKey.get(k);
		return id && this.docs.get(id)?.exists ? id : undefined;
	}
	async docExists(id: string) {
		return !!this.docs.get(id)?.exists;
	}
	async tagSectionAnchors() { return {}; }
	async findSectionBlock() { return undefined; }
	async replaceSection() { return { anchorId: undefined }; }
	async appendToSection() { return { ids: [] }; }
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

describe("collectChildLinks (asset attachments)", () => {
	const state: SyncState = {
		files: {},
		sessions: {
			"codex:main": { target: "siyuan", docId: "pdoc", sessionId: "main", source: "codex" },
			"codex:w1": { target: "siyuan", assetPath: "assets/session-sync/codex-w1.md", sessionId: "w1", source: "codex", parentSessionId: "main", agentRole: "worker", createdAt: "2026-05-01T10:00:00Z", title: "task w1" },
			"codex:w2": { target: "siyuan", assetPath: "assets/session-sync/codex-w2.md", sessionId: "w2", source: "codex", parentSessionId: "main", agentRole: "explorer", createdAt: "2026-05-01T11:00:00Z", title: "task w2" },
		},
	};
	it("returns sub-agent asset links sorted by createdAt", () => {
		const links = collectChildLinks(state, "codex", "main");
		expect(links.map((l) => l.assetPath)).toEqual(["assets/session-sync/codex-w1.md", "assets/session-sync/codex-w2.md"]);
		expect(links[0]).toMatchObject({ title: "task w1", role: "worker" });
	});
});

describe("reconcile: sub-agents → attachments, mains → docs", () => {
	it("writes children as .md assets and links them inline in the parent doc", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const files = fileSource([
			f("codex", "/a/main.jsonl", 100, codex("main")),
			f("codex", "/a/w1.jsonl", 110, codex("w1", { role: "worker", parent: "main" })),
			f("codex", "/a/w2.jsonl", 120, codex("w2", { role: "explorer", parent: "main" })),
		]);
		const r = await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });

		// Only the main session is a document; the two sub-agents are attachments.
		expect(writer.docs.size).toBe(1);
		expect([...writer.assets.keys()].sort()).toEqual(["session-sync/codex-w1.md", "session-sync/codex-w2.md"]);
		expect(r.newSessions).toBe(3);

		// Parent doc links the children inline as asset links.
		const parentMd = [...writer.docs.values()][0].markdown;
		expect(parentMd).toContain("🧩 **子代理**");
		expect(parentMd).toContain("(assets/session-sync/codex-w1.md)");
		expect(parentMd).toContain("(assets/session-sync/codex-w2.md)");
	});

	it("B2: a mid-chain sub-agent's attachment links its own child attachment (A→B→C)", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const files = fileSource([
			f("codex", "/a/A.jsonl", 100, codex("A")),
			f("codex", "/a/B.jsonl", 110, codex("B", { role: "worker", parent: "A" })),
			f("codex", "/a/C.jsonl", 120, codex("C", { role: "explorer", parent: "B" })),
		]);
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });
		expect(writer.docs.size).toBe(1); // only A is a doc
		const bMd = writer.assets.get("session-sync/codex-b.md")!; // slugify lowercases the id
		expect(bMd).toContain("(assets/session-sync/codex-c.md)"); // B's attachment links C
		const aMd = [...writer.docs.values()][0].markdown;
		expect(aMd).toContain("(assets/session-sync/codex-b.md)"); // A's doc links B
	});

	it("skips re-uploading an unchanged sub-agent attachment", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const files = fileSource([
			f("codex", "/a/main.jsonl", 100, codex("main")),
			f("codex", "/a/w1.jsonl", 110, codex("w1", { role: "worker", parent: "main" })),
		]);
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" });
		let puts = 0;
		const origPut = writer.putAsset.bind(writer);
		writer.putAsset = async (i) => { puts++; return origPut(i); };
		await reconcileOnce({ files, writer, state, notebookId: "nb", rootPath: "/AI" }); // unchanged
		expect(puts).toBe(0); // fast-path skip, no re-upload
	});
});
