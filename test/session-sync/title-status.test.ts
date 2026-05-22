import { describe, expect, it } from "vitest";
import { inferStatus } from "../../src/core/session-sync/engine/status";
import { reconcileOnce } from "../../src/core/session-sync/engine/reconcile";
import type { DiscoveredFile, FileSource, SiyuanWriter, StateStore, TitleProvider } from "../../src/core/session-sync/engine/ports";
import type { NormalizedSession, SyncState } from "../../src/core/session-sync/engine/types";

function makeSession(over: Partial<NormalizedSession> = {}): NormalizedSession {
	return { source: "codex", sessionId: "s", createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z", messages: [], toolActivities: [], parseWarnings: [], ...over };
}

describe("inferStatus", () => {
	const now = Date.parse("2026-05-21T12:00:00Z");
	it("active when updated within the window", () => {
		expect(inferStatus(makeSession({ updatedAt: "2026-05-21T11:55:00Z" }), now)).toBe("active");
	});
	it("completed when updated long ago", () => {
		expect(inferStatus(makeSession({ updatedAt: "2026-05-20T00:00:00Z" }), now)).toBe("completed");
	});
	it("interrupted when a parse warning signals abort/interrupt", () => {
		expect(inferStatus(makeSession({ updatedAt: "2026-05-20T00:00:00Z", parseWarnings: ["turn aborted"] }), now)).toBe("interrupted");
	});
});

function codexContent(id: string, msg = "hello", extra: unknown[] = []): string {
	return [
		{ timestamp: "2026-05-01T10:00:00Z", type: "session_meta", payload: { id, cwd: "/x/proj", timestamp: "2026-05-01T10:00:00Z" } },
		{ timestamp: "2026-05-01T10:00:05Z", type: "event_msg", payload: { type: "user_message", message: msg } },
		...extra,
	].map((r) => JSON.stringify(r)).join("\n");
}

class FakeWriter implements SiyuanWriter {
	docs = new Map<string, { exists: boolean; title?: string }>();
	byKey = new Map<string, string>();
	private seq = 0;
	async createDoc() { const id = `doc-${++this.seq}`; this.docs.set(id, { exists: true }); return { id }; }
	async overwriteDoc() {}
	async setAttrs({ docId, attrs }: { docId: string; attrs: Record<string, string> }) { const k = attrs["custom-ai-session-key"]; if (k) this.byKey.set(k, docId); }
	async renameDoc({ docId, title }: { docId: string; title: string }) { const d = this.docs.get(docId); if (d) d.title = title; }
	async moveUnder() {}
	async foldHeadings() {}
	async putAsset() { return "assets/x.md"; }
	async findDocBySessionKey(k: string) { const id = this.byKey.get(k); return id && this.docs.get(id)?.exists ? id : undefined; }
	async docExists(id: string) { return !!this.docs.get(id)?.exists; }
}
function memState(initial?: SyncState): StateStore { let s = initial ?? { files: {}, sessions: {} }; return { async load() { return s; }, async save(n) { s = n; } }; }
function fileSource(files: Array<{ file: DiscoveredFile; content: string }>): FileSource {
	return { async list() { return files.map((f) => f.file); }, async read(p) { const f = files.find((x) => x.file.path === p); if (!f) throw new Error("nf"); return f.content; }, async probe() { return "p"; } };
}
const aiProvider = (out: string | undefined): TitleProvider => ({ async generate() { return out; } });

describe("reconcile AI title resolution", () => {
	it("uses the AI title and records titleSource=ai", async () => {
		const writer = new FakeWriter();
		const state = memState();
		await reconcileOnce({ files: fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1 }, content: codexContent("c1") }]), writer, state, notebookId: "nb", rootPath: "/AI", titleProvider: aiProvider("精炼标题"), aiTitleEnabled: true });
		const s = await state.load();
		expect(s.sessions["codex:c1"].title).toBe("精炼标题");
		expect(s.sessions["codex:c1"].titleSource).toBe("ai");
		// Tree name = emoji + MM-DD prefix + clean title (date varies with fixture).
		expect([...writer.docs.values()][0].title).toMatch(/^🔵\d\d-\d\d 精炼标题$/);
	});

	it("falls back to the heuristic when the provider returns nothing", async () => {
		const writer = new FakeWriter();
		const state = memState();
		await reconcileOnce({ files: fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1 }, content: codexContent("c1", "fix the bug") }]), writer, state, notebookId: "nb", rootPath: "/AI", titleProvider: aiProvider(undefined), aiTitleEnabled: true });
		const s = await state.load();
		expect(s.sessions["codex:c1"].title).toBe("fix the bug");
		expect(s.sessions["codex:c1"].titleSource).toBe("heuristic");
	});

	it("AI title is sticky: not reverted when AI is later disabled", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const deps = (ai: boolean, provider: TitleProvider | undefined, content: string, size: number) => ({
			files: fileSource([{ file: { source: "codex" as const, path: "/a/c1.jsonl", sizeBytes: size, mtimeMs: size }, content }]),
			writer, state, notebookId: "nb", rootPath: "/AI", titleProvider: provider, aiTitleEnabled: ai,
		});
		await reconcileOnce(deps(true, aiProvider("AI标题"), codexContent("c1"), 100));
		expect((await state.load()).sessions["codex:c1"].title).toBe("AI标题");
		// AI now off, file changed → reprocessed, but the AI title must persist.
		await reconcileOnce(deps(false, undefined, codexContent("c1", "hello", [{ timestamp: "2026-05-01T10:01:00Z", type: "event_msg", payload: { type: "agent_message", message: "done" } }]), 220));
		const s = await state.load();
		expect(s.sessions["codex:c1"].title).toBe("AI标题");
		expect(s.sessions["codex:c1"].titleSource).toBe("ai");
	});
});
