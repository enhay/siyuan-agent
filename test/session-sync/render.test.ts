import { describe, expect, it } from "vitest";
import { renderSession } from "../../src/core/session-sync/engine/render";
import type { NormalizedSession } from "../../src/core/session-sync/engine/types";

function session(over: Partial<NormalizedSession> = {}): NormalizedSession {
	return {
		source: "codex",
		sessionId: "p1",
		createdAt: "2026-05-01T10:00:00Z",
		updatedAt: "2026-05-01T11:00:00Z",
		cwd: "/x/proj",
		messages: [{ role: "user", text: "do the thing", timestamp: "t" }],
		toolActivities: [],
		parseWarnings: [],
		...over,
	};
}

describe("renderSession sub-agent section", () => {
	it("B1: escapes double quotes in the block-ref anchor", () => {
		const md = renderSession(session(), {
			subAgents: [{ docId: "d1", title: 'fix the "login" bug', role: "worker" }],
		});
		expect(md).toContain("((d1 \"fix the 'login' bug\"))");
		expect(md).not.toContain('"fix the "login" bug"'); // would corrupt the ref
	});

	it("S2: de-duplicates identical child labels and rolls up counts", () => {
		const md = renderSession(session(), {
			subAgents: [
				{ docId: "d1", title: "a", role: "worker", nickname: "Ada", toolCount: 5, failedToolCount: 1 },
				{ docId: "d2", title: "b", role: "worker", nickname: "Ada", toolCount: 3, failedToolCount: 0 },
			],
		});
		expect(md).toContain("worker · Ada"); // first occurrence
		expect(md).toContain("worker · Ada (2)"); // de-duped second
		expect(md).toContain("| 子代理数 | 2 |");
		expect(md).toContain("| 子代理工具合计 | 8 (失败 1) |");
	});

	it("omits the sub-agent section when there are no children", () => {
		const md = renderSession(session());
		expect(md).not.toContain("## 子代理");
		expect(md).not.toContain("子代理数");
	});
});
