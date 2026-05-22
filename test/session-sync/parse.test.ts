import { describe, expect, it } from "vitest";
import { parseCodexSession } from "../../src/core/session-sync/engine/parse/codex";
import { parseClaudeSession } from "../../src/core/session-sync/engine/parse/claude";
import { sessionKey } from "../../src/core/session-sync/engine/identity";

const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n");

describe("parseCodexSession", () => {
	it("extracts metadata, messages, and tool activity", () => {
		const content = jsonl([
			{
				timestamp: "2026-05-01T10:00:00Z",
				type: "session_meta",
				payload: {
					id: "codex-001",
					cwd: "/home/zhaohua/code/demo/siyuan-agent",
					model: "gpt-5.4",
					timestamp: "2026-05-01T10:00:00Z",
				},
			},
			{ timestamp: "2026-05-01T10:00:05Z", type: "event_msg", payload: { type: "user_message", message: "Fix the login bug" } },
			{ timestamp: "2026-05-01T10:00:06Z", type: "event_msg", payload: { type: "agent_message", message: "On it." } },
			{ timestamp: "2026-05-01T10:00:07Z", type: "event_msg", payload: { type: "exec_command_end", command: "npm test", exit_code: 0 } },
			{ timestamp: "2026-05-01T10:00:08Z", type: "event_msg", payload: { type: "exec_command_end", command: "npm run build", exit_code: 1 } },
			{ timestamp: "2026-05-01T10:00:09Z", type: "event_msg", payload: { type: "patch_apply_end", path: "src/auth.ts", success: true } },
		]);
		const s = parseCodexSession(content, "rollout-codex-001.jsonl");
		expect(s.source).toBe("codex");
		expect(s.sessionId).toBe("codex-001");
		expect(s.cwd).toBe("/home/zhaohua/code/demo/siyuan-agent");
		expect(s.model).toBe("gpt-5.4");
		expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
		expect(s.toolActivities.filter((t) => t.kind === "shell")).toHaveLength(2);
		expect(s.toolActivities.filter((t) => t.status === "failure")).toHaveLength(1);
		expect(s.toolActivities.filter((t) => t.kind === "file_edit")).toHaveLength(1);
		expect(s.isSubAgent).toBe(false);
		expect(s.parseWarnings).toHaveLength(0);
	});

	it("marks an explicit worker sub-agent (role + parent)", () => {
		const content = jsonl([
			{
				timestamp: "2026-05-01T11:00:00Z",
				type: "session_meta",
				payload: {
					id: "codex-worker-1",
					cwd: "/x",
					agent_role: "worker",
					agent_nickname: "Ada",
					source: { subagent: { thread_spawn: { parent_thread_id: "codex-main-1" } } },
				},
			},
		]);
		const s = parseCodexSession(content);
		expect(s.agentRole).toBe("worker");
		expect(s.parentSessionId).toBe("codex-main-1");
		expect(s.isSubAgent).toBe(true);
	});

	it("B3: classifies role-null-but-has-parent sessions as sub-agents", () => {
		const content = jsonl([
			{
				timestamp: "2026-05-01T11:30:00Z",
				type: "session_meta",
				payload: {
					id: "codex-turing",
					agent_nickname: "Turing",
					agent_role: null,
					source: { subagent: { thread_spawn: { parent_thread_id: "codex-main-9" } } },
				},
			},
		]);
		const s = parseCodexSession(content);
		expect(s.agentRole).toBeUndefined();
		expect(s.parentSessionId).toBe("codex-main-9");
		// ailogger's !agentRole-only split would have called this a main session.
		expect(s.isSubAgent).toBe(true);
	});

	it("ignores a malformed trailing line", () => {
		const content =
			jsonl([{ timestamp: "2026-05-01T10:00:00Z", type: "session_meta", payload: { id: "codex-x" } }]) +
			"\n{not json";
		const s = parseCodexSession(content);
		expect(s.sessionId).toBe("codex-x");
		expect(s.parseWarnings).toContain("ignored trailing partial json line");
	});

	it("filters injected AGENTS.md context from user messages", () => {
		const content = jsonl([
			{ timestamp: "2026-05-01T10:00:00Z", type: "session_meta", payload: { id: "codex-y" } },
			{
				timestamp: "2026-05-01T10:00:01Z",
				type: "event_msg",
				payload: { type: "user_message", message: "# AGENTS.md instructions for /x\n<INSTRUCTIONS>do things</INSTRUCTIONS>" },
			},
			{ timestamp: "2026-05-01T10:00:02Z", type: "event_msg", payload: { type: "user_message", message: "real question" } },
		]);
		const s = parseCodexSession(content);
		const users = s.messages.filter((m) => m.role === "user");
		expect(users).toHaveLength(1);
		expect(users[0].text).toBe("real question");
	});

	it("filters codex control-tag injections (turn_aborted, subagent_notification)", () => {
		const content = jsonl([
			{ timestamp: "2026-05-01T10:00:00Z", type: "session_meta", payload: { id: "codex-z" } },
			{ timestamp: "2026-05-01T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "<turn_aborted> The user interrupted the previous turn." } },
			{ timestamp: "2026-05-01T10:00:02Z", type: "event_msg", payload: { type: "user_message", message: '<subagent_notification>\n{"agent_path":"x","status":{"completed":"done"}}' } },
			{ timestamp: "2026-05-01T10:00:03Z", type: "event_msg", payload: { type: "user_message", message: "实际问题" } },
		]);
		const s = parseCodexSession(content);
		const users = s.messages.filter((m) => m.role === "user");
		expect(users).toHaveLength(1);
		expect(users[0].text).toBe("实际问题");
	});
});

describe("parseClaudeSession", () => {
	it("parses messages and pairs tool_result failure", () => {
		const content = jsonl([
			{ type: "user", timestamp: "2026-05-02T09:00:00Z", sessionId: "claude-main-1", cwd: "/c", message: { role: "user", content: "hello" } },
			{
				type: "assistant",
				timestamp: "2026-05-02T09:00:01Z",
				sessionId: "claude-main-1",
				message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] },
			},
			{ type: "user", timestamp: "2026-05-02T09:00:02Z", sessionId: "claude-main-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true }] } },
		]);
		const s = parseClaudeSession(content, "/p/claude-main-1.jsonl");
		expect(s.source).toBe("claude");
		expect(s.sessionId).toBe("claude-main-1");
		expect(s.model).toBe("claude-opus-4-7");
		expect(s.isSubAgent).toBe(false);
		const shell = s.toolActivities.find((t) => t.kind === "shell");
		expect(shell?.status).toBe("failure");
	});

	it("B2: sidechain keys on agentId, parent from sessionId field", () => {
		const content = jsonl([
			{ type: "user", timestamp: "2026-05-02T10:00:00Z", sessionId: "PARENT", agentId: "agentA", isSidechain: true, cwd: "/c", message: { role: "user", content: "task A" } },
		]);
		const s = parseClaudeSession(content, "/p/PARENT/subagents/agent-agentA.jsonl");
		expect(s.sessionId).toBe("agentA");
		expect(s.parentSessionId).toBe("PARENT");
		expect(s.agentId).toBe("agentA");
		expect(s.isSubAgent).toBe(true);
	});

	it("B2: two sub-agents of one parent do NOT collapse to one key", () => {
		const a = parseClaudeSession(
			jsonl([{ type: "user", timestamp: "t", sessionId: "PARENT", agentId: "agentA", isSidechain: true, message: { role: "user", content: "a" } }]),
			"/p/PARENT/subagents/agent-agentA.jsonl",
		);
		const b = parseClaudeSession(
			jsonl([{ type: "user", timestamp: "t", sessionId: "PARENT", agentId: "agentB", isSidechain: true, message: { role: "user", content: "b" } }]),
			"/p/PARENT/subagents/agent-agentB.jsonl",
		);
		expect(sessionKey(a)).not.toBe(sessionKey(b));
		expect(a.parentSessionId).toBe("PARENT");
		expect(b.parentSessionId).toBe("PARENT");
	});

	it("derives sidechain identity from path when records lack agentId", () => {
		const content = jsonl([
			{ type: "user", timestamp: "t", sessionId: "PARENT", message: { role: "user", content: "x" } },
		]);
		const s = parseClaudeSession(content, "/p/PARENT/subagents/agent-deadbeef.jsonl");
		expect(s.sessionId).toBe("deadbeef");
		expect(s.parentSessionId).toBe("PARENT");
		expect(s.isSubAgent).toBe(true);
	});

	it("falls back to filename UUID when sessionId absent", () => {
		const s = parseClaudeSession("{bad", "/p/123e4567-e89b-12d3-a456-426614174000.jsonl");
		expect(s.sessionId).toBe("123e4567-e89b-12d3-a456-426614174000");
	});
});
