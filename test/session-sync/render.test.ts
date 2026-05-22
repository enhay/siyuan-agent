import { describe, expect, it } from "vitest";
import { renderSession, cleanMessageText, FOLDABLE_HEADING_PREFIXES } from "../../src/core/session-sync/engine/render";
import type { NormalizedSession } from "../../src/core/session-sync/engine/types";

function session(over: Partial<NormalizedSession> = {}): NormalizedSession {
	return {
		source: "codex",
		sessionId: "p1",
		createdAt: "2026-05-01T10:00:00Z",
		updatedAt: "2026-05-01T11:00:00Z",
		cwd: "/x/proj",
		messages: [
			{ role: "user", text: "fix the login bug", timestamp: "t1" },
			{ role: "assistant", text: "Done.\n\n```js\nok()\n```", timestamp: "t2" },
		],
		toolActivities: [],
		parseWarnings: [],
		...over,
	};
}

describe("renderSession readability", () => {
	it("emits no body H1 (the doc title is the heading)", () => {
		const md = renderSession(session());
		expect(md.startsWith("## 📋 概览")).toBe(true);
		expect(md).not.toMatch(/^# /m);
	});

	it("user turns are blockquotes (🧑), assistant turns are plain blocks (🤖)", () => {
		const md = renderSession(session());
		expect(md).toContain("> 🧑 **用户**");
		expect(md).toContain("> fix the login bug");
		expect(md).toContain("🤖 **助手**");
		expect(md).toContain("```js"); // assistant code renders natively (not quoted)
		expect(md).not.toContain("> ```js");
	});

	it("结论 is a 问→答 TL;DR, not the full last message repeated verbatim", () => {
		const md = renderSession(session());
		expect(md).toContain("## 🎯 结论");
		expect(md).toContain("**问：** fix the login bug");
		expect(md).toContain("**答：** Done.");
	});

	it("tool + warning sections use foldable heading prefixes", () => {
		const md = renderSession(
			session({
				toolActivities: [{ kind: "shell", summary: "`npm test` → exit 0", timestamp: "t", status: "success" }],
				parseWarnings: ["ignored trailing partial json line"],
			}),
		);
		expect(md).toContain("## 🔧 工具调用 (1)");
		expect(md).toContain("## ⚠️ 解析警告");
		// every foldable section heading must match a prefix the writer folds
		for (const prefix of FOLDABLE_HEADING_PREFIXES) {
			expect(md).toContain(`## ${prefix}`);
		}
		expect(md).toContain("- ✅ **shell** `npm test` → exit 0");
	});

	it("flags failed tools in the conclusion", () => {
		const md = renderSession(
			session({ toolActivities: [{ kind: "shell", summary: "`x` → exit 1", timestamp: "t", status: "failure" }] }),
		);
		expect(md).toContain("⚠️ 有 1 个工具调用失败");
		expect(md).toContain("- ❌ **shell**");
	});

	it("strips injected noise and skips emptied turns", () => {
		const md = renderSession(
			session({
				messages: [
					{ role: "user", text: "<system-reminder>CLAUDE.md ...</system-reminder>", timestamp: "t1" }, // → empty, skipped
					{ role: "user", text: "real question\n<system-reminder>noise</system-reminder>", timestamp: "t2" },
					{ role: "assistant", text: "ok", timestamp: "t3" },
				],
			}),
		);
		expect(md).not.toContain("system-reminder");
		expect(md).toContain("> real question");
		// the reminder-only user turn is dropped, so only one 用户 block
		expect(md.match(/🧑 \*\*用户\*\*/g)?.length).toBe(1);
	});

	it("inlines sub-agent entries (no standalone section) with rollup + escaped refs", () => {
		const md = renderSession(session(), {
			subAgents: [
				{ docId: "d1", title: 'fix the "login" bug', role: "worker", nickname: "Ada", toolCount: 5, failedToolCount: 1, createdAt: "2026-05-01T10:30:00Z" },
				{ docId: "d2", title: "b", role: "worker", nickname: "Ada", toolCount: 3, failedToolCount: 0, createdAt: "2026-05-01T10:31:00Z" },
			],
		});
		expect(md).not.toContain("## 🧩 子代理"); // no standalone section
		expect(md).toContain("> 🧩 **子代理** ((d1 \"worker · Ada — fix the 'login' bug\"))");
		expect(md).toContain("worker · Ada (2)"); // de-duped label
		expect(md).toContain("| 子代理 | 2（工具 8，失败 1） |"); // overview rollup kept
	});

	it("places a sub-agent entry between the turns it was triggered between (by createdAt)", () => {
		const md = renderSession(
			session({
				messages: [
					{ role: "user", text: "do A", timestamp: "2026-05-01T10:00:00Z" },
					{ role: "assistant", text: "spawning a worker", timestamp: "2026-05-01T10:00:10Z" },
					{ role: "assistant", text: "worker finished", timestamp: "2026-05-01T10:05:00Z" },
				],
			}),
			{ subAgents: [{ docId: "w1", title: "the worker", role: "worker", createdAt: "2026-05-01T10:00:30Z" }] },
		);
		const convo = md.slice(md.indexOf("## 💬 对话"));
		const iSpawn = convo.indexOf("spawning a worker");
		const iSub = convo.indexOf("🧩 **子代理**");
		const iDone = convo.indexOf("worker finished");
		expect(iSpawn).toBeGreaterThan(-1);
		expect(iSub).toBeGreaterThan(iSpawn); // after the spawning turn
		expect(iDone).toBeGreaterThan(iSub); // before the finished turn
	});

	it("omits sub-agent markers when there are none", () => {
		const md = renderSession(session());
		expect(md).not.toContain("🧩");
	});

	it("inlines a cross-tool invocation note (codex→claude), ignoring noise", () => {
		const md = renderSession(
			session({
				toolActivities: [
					{ kind: "shell", summary: "`which claude` → exit 0", timestamp: "2026-05-01T10:00:01Z", status: "success" },
					{ kind: "shell", summary: "`claude -p \"do the work\"` → exit 0", timestamp: "2026-05-01T10:00:02Z", status: "success" },
					{ kind: "shell", summary: "`grep claude-code/src` → exit 0", timestamp: "2026-05-01T10:00:03Z", status: "success" },
				],
			}),
		);
		expect(md).toContain("↗ **调用 claude**");
		expect(md).toContain('claude -p "do the work"');
		expect((md.match(/↗ \*\*调用/g) || []).length).toBe(1); // which/path noise excluded
	});
});

describe("cleanMessageText", () => {
	it("removes wrapper tags + caveats, collapses blank lines", () => {
		expect(cleanMessageText("a\n\n\n\nb")).toBe("a\n\nb");
		expect(cleanMessageText("<command-name>/x</command-name>keep")).toBe("keep");
		expect(cleanMessageText("Caveat: local thing\nkeep")).toBe("keep");
		expect(cleanMessageText("<system-reminder>x</system-reminder>")).toBe("");
	});
});
