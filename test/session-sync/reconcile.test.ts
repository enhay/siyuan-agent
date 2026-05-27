import { describe, expect, it } from "vitest";
import { reconcileOnce } from "../../src/core/session-sync/engine/reconcile";
import type { DiscoveredFile, FileSource, SiyuanWriter, StateStore } from "../../src/core/session-sync/engine/ports";
import type { SyncState } from "../../src/core/session-sync/engine/types";
import { createFsSource, type FsPromisesLike } from "../../src/core/session-sync/adapters/fs-source";

function codexContent(id: string, extra: unknown[] = []): string {
	return [
		{ timestamp: "2026-05-01T10:00:00Z", type: "session_meta", payload: { id, cwd: "/x/proj", model: "m", timestamp: "2026-05-01T10:00:00Z" } },
		{ timestamp: "2026-05-01T10:00:05Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
		...extra,
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
}

class FakeWriter implements SiyuanWriter {
	docs = new Map<
		string,
		{
			markdown: string;
			attrs: Record<string, string>;
			title?: string;
			exists: boolean;
			/** Section-keyed markdown bodies, after incremental updates. */
			sections: Partial<Record<string, string>>;
			/** Dialog tail appends (concatenated in order). */
			dialogAppended: string;
		}
	>();
	byKey = new Map<string, string>();
	calls = {
		create: 0,
		overwrite: 0,
		rename: 0,
		setAttrs: 0,
		move: 0,
		tag: 0,
		replaceSection: 0,
		appendToSection: 0,
	};
	private seq = 0;
	async createDoc({ markdown }: { notebook: string; path: string; markdown: string }) {
		const id = `doc-${++this.seq}`;
		this.docs.set(id, { markdown, attrs: {}, exists: true, sections: {}, dialogAppended: "" });
		this.calls.create++;
		return { id };
	}
	async overwriteDoc({ docId, markdown }: { docId: string; markdown: string }) {
		const d = this.docs.get(docId);
		if (d) {
			d.markdown = markdown;
			d.sections = {};
			d.dialogAppended = "";
		}
		this.calls.overwrite++;
	}
	async setAttrs({ docId, attrs }: { docId: string; attrs: Record<string, string> }) {
		const d = this.docs.get(docId);
		if (d) d.attrs = { ...d.attrs, ...attrs };
		const key = attrs["custom-ai-session-key"];
		if (key) this.byKey.set(key, docId);
		this.calls.setAttrs++;
	}
	async renameDoc({ docId, title }: { docId: string; title: string }) {
		const d = this.docs.get(docId);
		if (d) d.title = title;
		this.calls.rename++;
	}
	async moveUnder() {
		this.calls.move++;
	}
	async foldHeadings() {}
	async putAsset() { return "assets/x.md"; }
	async findDocBySessionKey(key: string) {
		const id = this.byKey.get(key);
		return id && this.docs.get(id)?.exists ? id : undefined;
	}
	async docExists(docId: string) {
		return !!this.docs.get(docId)?.exists;
	}
	async tagSectionAnchors(_docId: string) {
		this.calls.tag++;
		return {};
	}
	async findSectionBlock(_docId: string, _kind: string) {
		return undefined;
	}
	async replaceSection(docId: string, kind: string, markdown: string) {
		const d = this.docs.get(docId);
		if (d) d.sections[kind] = markdown;
		this.calls.replaceSection++;
		return { anchorId: undefined };
	}
	async appendToSection(docId: string, kind: string, markdown: string) {
		const d = this.docs.get(docId);
		if (d && kind === "dialog") d.dialogAppended += markdown + "\n";
		this.calls.appendToSection++;
		return { ids: [] };
	}
}

function memState(initial?: SyncState): StateStore {
	let s: SyncState = initial ?? { files: {}, sessions: {} };
	return {
		async load() {
			return s;
		},
		async save(next) {
			s = next;
		},
	};
}

function fileSource(files: Array<{ file: DiscoveredFile; content: string }>): FileSource & { reads: number } {
	const wrap = {
		reads: 0,
		async list() {
			return files.map((f) => f.file);
		},
		async read(path: string) {
			wrap.reads++;
			const f = files.find((x) => x.file.path === path);
			if (!f) throw new Error("not found");
			return f.content;
		},
		async probe() {
			return String(files.length);
		},
	};
	return wrap;
}

const deps = (files: FileSource, writer: SiyuanWriter, state: StateStore) => ({
	files,
	writer,
	state,
	notebookId: "nb",
	rootPath: "/AI 会话",
});

describe("reconcileOnce", () => {
	it("creates a doc for a new session and writes attrs + title", async () => {
		const writer = new FakeWriter();
		const fs = fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]);
		const r = await reconcileOnce(deps(fs, writer, memState()));
		expect(r.newSessions).toBe(1);
		expect(r.updatedSessions).toBe(1);
		expect(writer.calls.create).toBe(1);
		expect(writer.calls.setAttrs).toBe(1);
		expect(writer.calls.rename).toBe(1);
	});

	it("skips unchanged files via the size/mtime cursor (no read, no write)", async () => {
		const writer = new FakeWriter();
		const fs = fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]);
		const state = memState();
		await reconcileOnce(deps(fs, writer, state));
		const readsAfterFirst = fs.reads;
		const r2 = await reconcileOnce(deps(fs, writer, state));
		expect(r2.updatedSessions).toBe(0);
		expect(writer.calls.create).toBe(1);
		expect(fs.reads).toBe(readsAfterFirst); // fast-path skipped the read
	});

	it("appends new dialog to the same doc when content changes (incremental)", async () => {
		const writer = new FakeWriter();
		const state = memState();
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		const changed = fileSource([
			{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 220, mtimeMs: 2000 }, content: codexContent("c1", [{ timestamp: "2026-05-01T10:01:00Z", type: "event_msg", payload: { type: "agent_message", message: "done" } }]) },
		]);
		const r = await reconcileOnce(deps(changed, writer, state));
		expect(r.newSessions).toBe(0);
		expect(r.updatedSessions).toBe(1);
		expect(writer.calls.create).toBe(1); // still one doc — incremental path doesn't recreate
		expect(writer.calls.overwrite).toBe(0); // legacy overwrite path NOT used for incremental sessions
		expect(writer.calls.appendToSection).toBeGreaterThan(0); // new assistant turn appended to dialog
	});

	it("recovers an existing doc by session key when local state is lost", async () => {
		const writer = new FakeWriter();
		// Simulate a doc created by a previous run / the sidecar.
		writer.docs.set("docX", { markdown: "old", attrs: {}, exists: true, title: "t" });
		writer.byKey.set("codex:c1", "docX");
		const r = await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, memState()));
		expect(r.newSessions).toBe(0); // reused, not duplicated
		expect(writer.calls.create).toBe(0);
		expect(writer.calls.overwrite).toBe(1);
	});

	it("settle-gate: defers a still-active session, writes once it goes idle", async () => {
		const writer = new FakeWriter();
		const state = memState();
		// codexContent's last activity is 2026-05-01T10:00:05Z.
		const mk = () => deps(fileSource([{ file: { source: "codex" as const, path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state);
		// 2 min after last activity → still active → deferred (nothing written).
		const r1 = await reconcileOnce({ ...mk(), now: () => Date.parse("2026-05-01T10:02:00Z"), settleMs: 5 * 60 * 1000 });
		expect(r1.updatedSessions).toBe(0);
		expect(writer.calls.create).toBe(0);
		// 10 min after → settled → written exactly once.
		const r2 = await reconcileOnce({ ...mk(), now: () => Date.parse("2026-05-01T10:10:00Z"), settleMs: 5 * 60 * 1000 });
		expect(r2.newSessions).toBe(1);
		expect(writer.calls.create).toBe(1);
	});

	it("settle-gate: a re-activated session re-defers, then appends to the same doc once re-settled", async () => {
		const writer = new FakeWriter();
		const state = memState();
		const at = (size: number, content: string) => fileSource([{ file: { source: "codex" as const, path: "/a/c1.jsonl", sizeBytes: size, mtimeMs: size }, content }]);
		// 1) settled → written once.
		await reconcileOnce({ ...deps(at(100, codexContent("c1")), writer, state), now: () => Date.parse("2026-05-01T10:10:00Z"), settleMs: 5 * 60 * 1000 });
		expect(writer.calls.create).toBe(1);
		// 2) re-activated: file grows, last activity recent → deferred (no append yet).
		const resumed = codexContent("c1", [{ timestamp: "2026-05-01T11:00:00Z", type: "event_msg", payload: { type: "agent_message", message: "more" } }]);
		await reconcileOnce({ ...deps(at(300, resumed), writer, state), now: () => Date.parse("2026-05-01T11:02:00Z"), settleMs: 5 * 60 * 1000 });
		expect(writer.calls.create).toBe(1); // still one doc
		expect(writer.calls.appendToSection).toBe(0); // deferred
		// 3) re-settled → same doc gets the new dialog appended (no duplicate doc).
		await reconcileOnce({ ...deps(at(300, resumed), writer, state), now: () => Date.parse("2026-05-01T11:10:00Z"), settleMs: 5 * 60 * 1000 });
		expect(writer.calls.create).toBe(1);
		expect(writer.calls.appendToSection).toBeGreaterThan(0);
	});

	it("recreates when the stored doc was deleted and no recovery match exists", async () => {
		const writer = new FakeWriter();
		const state = memState({ files: {}, sessions: { "codex:c1": { target: "siyuan", docId: "gone", contentHash: "sha256:x", sessionId: "c1", source: "codex" } } });
		const r = await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		expect(writer.calls.create).toBe(1);
		expect(r.newSessions).toBe(1);
	});

	it("B1: a recreated doc still gets its readable title even when the title is unchanged", async () => {
		const writer = new FakeWriter();
		// Stored record's title equals what inferTitle() will produce (first user msg "hello"),
		// and the doc was deleted. Without forcing rename on isNew, the new doc keeps the slug.
		const state = memState({
			files: {},
			sessions: { "codex:c1": { target: "siyuan", docId: "gone", contentHash: "sha256:x", sessionId: "c1", source: "codex", title: "hello" } },
		});
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		expect(writer.calls.create).toBe(1);
		expect(writer.calls.rename).toBe(1); // forced because isNew
		// Renamed to the readable name (emoji + MM-DD + clean title), not the slug leaf.
		const created = [...writer.docs.values()].find((d) => /^🧪\d\d-\d\d hello$/.test(d.title));
		expect(created).toBeDefined();
	});

	it("incremental: new session records partDocIds + appended counts + metaHash", async () => {
		const writer = new FakeWriter();
		const state = memState();
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		const rec = (await state.load()).sessions["codex:c1"];
		expect(rec.incrementalEnabled).toBe(true);
		expect(rec.partDocIds).toHaveLength(1);
		expect(rec.partDocIds?.[0]).toBe(rec.docId);
		expect(rec.appendedMessageCount).toBeGreaterThan(0);
		expect(rec.appendedToolCount).toBe(0);
		expect(rec.metaHash).toMatch(/^sha256:/);
		expect(rec.currentPartBytes).toBeGreaterThan(0);
		// First write tags section anchors so future ticks can find them.
		expect(writer.calls.tag).toBe(1);
	});

	it("incremental: a tick with no new content does nothing (no replace, no append)", async () => {
		const writer = new FakeWriter();
		const state = memState();
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		const beforeAppend = writer.calls.appendToSection;
		const beforeReplace = writer.calls.replaceSection;
		// Same file content, mtime moved — should be a true no-op for the writer.
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 200, mtimeMs: 2000 }, content: codexContent("c1") }]), writer, state));
		expect(writer.calls.appendToSection).toBe(beforeAppend);
		expect(writer.calls.replaceSection).toBe(beforeReplace);
	});

	it("incremental: spill creates a new part doc when active part exceeds partMaxBytes", async () => {
		const writer = new FakeWriter();
		const state = memState();
		// First tick lays the doc down.
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		expect(writer.calls.create).toBe(1);
		// Second tick with a new turn — set a tiny partMaxBytes so any growth triggers spill.
		const grown = codexContent("c1", [{ timestamp: "2026-05-01T11:00:00Z", type: "event_msg", payload: { type: "agent_message", message: "additional response" } }]);
		await reconcileOnce({
			...deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 300, mtimeMs: 2000 }, content: grown }]), writer, state),
			partMaxBytes: 100,
		});
		// Expect a 2nd doc was created (the spill new part).
		expect(writer.calls.create).toBe(2);
		const rec = (await state.load()).sessions["codex:c1"];
		expect(rec.partDocIds).toHaveLength(2);
		expect(rec.docId).toBe(rec.partDocIds?.[1]); // active = new part
	});

	it("legacy doc (no incrementalEnabled in state) keeps overwrite behavior", async () => {
		const writer = new FakeWriter();
		// Seed state as if produced by a pre-incremental build.
		writer.docs.set("legacy-1", { markdown: "old", attrs: { "custom-ai-session-key": "codex:c1" }, exists: true, sections: {}, dialogAppended: "", title: "old title" });
		writer.byKey.set("codex:c1", "legacy-1");
		const state = memState({
			files: {},
			sessions: {
				"codex:c1": {
					target: "siyuan",
					docId: "legacy-1",
					contentHash: "sha256:stale", // forces a rewrite
					sessionId: "c1",
					source: "codex",
					// No incrementalEnabled — this is the migration boundary.
				},
			},
		});
		await reconcileOnce(deps(fileSource([{ file: { source: "codex", path: "/a/c1.jsonl", sizeBytes: 100, mtimeMs: 1000 }, content: codexContent("c1") }]), writer, state));
		// Legacy path: overwriteDoc, NO tagSectionAnchors / appendToSection / replaceSection.
		expect(writer.calls.overwrite).toBe(1);
		expect(writer.calls.tag).toBe(0);
		expect(writer.calls.appendToSection).toBe(0);
		expect(writer.calls.replaceSection).toBe(0);
		// State stays on the legacy track.
		expect((await state.load()).sessions["codex:c1"].incrementalEnabled).toBe(false);
	});
});

describe("createFsSource (injected fs)", () => {
	function fakeFs(tree: Record<string, { dirs?: string[]; files?: string[] } | { mtimeMs: number; size: number; content: string }>): FsPromisesLike {
		return {
			async readdir(path) {
				const node = tree[path];
				if (!node || !("dirs" in node || "files" in node)) throw new Error("not a dir");
				const d = node as { dirs?: string[]; files?: string[] };
				return [
					...(d.dirs ?? []).map((name) => ({ name, isDirectory: () => true, isFile: () => false })),
					...(d.files ?? []).map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
				];
			},
			async readFile(path) {
				const node = tree[path] as { content?: string };
				return node?.content ?? "";
			},
			async stat(path) {
				const node = tree[path] as { mtimeMs: number; size: number };
				return { mtimeMs: node.mtimeMs, size: node.size };
			},
		};
	}

	it("walks recursively, filters by backfill window, and probes", async () => {
		const now = Date.now();
		const old = now - 40 * 24 * 3600 * 1000;
		const tree = {
			"/codex": { dirs: ["2026"] },
			"/codex/2026": { files: ["a.jsonl", "b.jsonl", "note.txt"] },
			"/codex/2026/a.jsonl": { mtimeMs: now, size: 10, content: "a" },
			"/codex/2026/b.jsonl": { mtimeMs: old, size: 20, content: "b" }, // outside window
		} as Record<string, any>;
		const src = createFsSource(
			{ sources: { codex: true, claude: false }, sourcePaths: { codex: ["/codex"], claude: [] }, backfillDays: 7, backfillLimit: 50 },
			fakeFs(tree),
		);
		const list = await src.list();
		expect(list.map((f) => f.path)).toEqual(["/codex/2026/a.jsonl"]); // .txt ignored, old dropped
		expect(await src.probe()).toBe(`1:${now}:10`);
	});

	it("returns no files (not an error) when a root is unreadable", async () => {
		const src = createFsSource(
			{ sources: { codex: true, claude: false }, sourcePaths: { codex: ["/missing"], claude: [] }, backfillDays: 7, backfillLimit: 50 },
			fakeFs({}),
		);
		expect(await src.list()).toEqual([]);
	});
});
