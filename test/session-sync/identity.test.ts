import { describe, expect, it } from "vitest";
import {
	buildDocName,
	buildSiyuanDocPath,
	contentHash,
	fileKey,
	inferTitle,
	projectSlug,
	sessionKey,
	shortSessionId,
	slugify,
} from "../../src/core/session-sync/engine/identity";
import type { NormalizedSession } from "../../src/core/session-sync/engine/types";

function makeSession(over: Partial<NormalizedSession> = {}): NormalizedSession {
	return {
		source: "codex",
		sessionId: "sess-1",
		createdAt: "2026-05-21T08:30:00Z",
		updatedAt: "2026-05-21T09:00:00Z",
		cwd: "/home/zhaohua/code/demo/siyuan-agent",
		messages: [],
		toolActivities: [],
		parseWarnings: [],
		...over,
	};
}

describe("identity helpers", () => {
	it("sessionKey / fileKey", () => {
		expect(sessionKey({ source: "claude", sessionId: "abc" })).toBe("claude:abc");
		expect(fileKey("codex", "/a/b.jsonl")).toBe("codex:/a/b.jsonl");
	});

	it("slugify keeps CJK, drops punctuation", () => {
		expect(slugify("Hello, World!")).toBe("hello-world");
		expect(slugify("修复 登录 bug")).toBe("修复-登录-bug");
	});

	it("projectSlug from cwd basename (handles UNC backslashes)", () => {
		expect(projectSlug("/home/zhaohua/code/yunyazu")).toBe("yunyazu");
		expect(projectSlug("\\\\wsl.localhost\\Ubuntu\\home\\z\\proj")).toBe("proj");
		expect(projectSlug(undefined)).toBe("unknown");
	});

	it("shortSessionId truncates to 12", () => {
		expect(shortSessionId("019d84b0-2520-79c2-892a")).toHaveLength(12);
	});

	it("buildSiyuanDocPath is <root>/<project>/<leaf> (depth 2), no title", () => {
		const p = buildSiyuanDocPath("/AI 会话", makeSession({ sessionId: "019d84b0-2520-79c2", cwd: "/x/proj" }));
		// leaf = <source>-<shortSessionId> (slugified id truncated to 12 chars).
		expect(p).toBe("/AI 会话/proj/codex-019d84b0-252");
	});

	it("buildSiyuanDocPath groups no-cwd sessions under 未归类", () => {
		const p = buildSiyuanDocPath("会话", makeSession({ sessionId: "abc", cwd: undefined }));
		expect(p).toBe("/会话/未归类/codex-abc");
	});

	it("buildDocName prefixes emoji + MM-DD, keeps title clean", () => {
		expect(buildDocName(makeSession({ source: "codex" }), "修复登录")).toBe("🔵05-21 修复登录");
		expect(buildDocName(makeSession({ source: "claude" }), "调研")).toBe("🟣05-21 调研");
	});

	it("inferTitle truncates long first user message; falls back when none", () => {
		const withMsg = makeSession({
			messages: [{ role: "user", text: "  hello   there  ", timestamp: "t" }],
		});
		expect(inferTitle(withMsg)).toBe("hello there");
		const none = makeSession({ sessionId: "zzzz", cwd: "/x/proj" });
		expect(inferTitle(none)).toBe("proj codex session zzzz");
	});

	it("inferTitle strips a leading slash-command and skips bare slash commands", () => {
		expect(inferTitle(makeSession({ messages: [{ role: "user", text: "/loop summarize yesterday", timestamp: "t" }] }))).toBe("summarize yesterday");
		// bare slash command → skip to next substantive user message
		expect(
			inferTitle(
				makeSession({
					messages: [
						{ role: "user", text: "/clear", timestamp: "t1" },
						{ role: "assistant", text: "ok", timestamp: "t2" },
						{ role: "user", text: "fix the parser", timestamp: "t3" },
					],
				}),
			),
		).toBe("fix the parser");
	});

	it("inferTitle does NOT over-strip a leading path (S1)", () => {
		expect(inferTitle(makeSession({ messages: [{ role: "user", text: "/etc/hosts is broken", timestamp: "t" }] }))).toBe("/etc/hosts is broken");
	});

	it("contentHash is sha256-prefixed, stable, and change-sensitive", async () => {
		const h1 = await contentHash("abc");
		const h2 = await contentHash("abc");
		const h3 = await contentHash("abd");
		expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(h1).toBe(h2);
		expect(h1).not.toBe(h3);
	});
});
