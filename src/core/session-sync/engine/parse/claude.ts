/** Parse a Claude Code session JSONL into a NormalizedSession.
 *
 *  Ported from `ailogger` (`src/parsing/claude.ts`), with two changes:
 *  - Takes file *content* (a string) instead of reading disk.
 *  - Sub-agent (sidechain) support (plan B2): Claude writes sub-agents to
 *    `<project>/<parentSessionId>/subagents/agent-<agentId>.jsonl` where every
 *    record's `sessionId` equals the PARENT's id and the unique child id is the
 *    `agentId` field. Treating `sessionId` as identity would collapse all of a
 *    parent's sub-agents into one doc. So for sidechain files we key on `agentId`
 *    and set `parentSessionId` from the `sessionId` field (dir name as fallback). */

import type { ConversationMessage, NormalizedSession, ToolActivity } from "../types";
import { classifyIsSubAgent } from "../identity";

interface ClaudeRecord {
	type: string;
	timestamp?: string;
	sessionId?: string;
	agentId?: string;
	isSidechain?: boolean;
	cwd?: string;
	message?: { role?: string; model?: string; content?: unknown };
	[key: string]: unknown;
}

interface ClaudeTextContent {
	type: string;
	text: string;
}

interface ClaudeToolUseContent {
	type: "tool_use";
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
}

interface ClaudeToolResultContent {
	type: "tool_result";
	tool_use_id?: string;
	is_error?: boolean;
}

function tryParseLine(line: string): ClaudeRecord | null {
	try {
		return JSON.parse(line) as ClaudeRecord;
	} catch {
		return null;
	}
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is ClaudeTextContent =>
				typeof c === "object" &&
				c !== null &&
				"type" in c &&
				(c as ClaudeTextContent).type === "text" &&
				"text" in c,
		)
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function extractToolUses(
	content: unknown,
	timestamp: string,
): Array<{ toolUseId?: string; activity: ToolActivity }> {
	if (!Array.isArray(content)) return [];
	const out: Array<{ toolUseId?: string; activity: ToolActivity }> = [];
	for (const item of content) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("type" in item) ||
			(item as { type: string }).type !== "tool_use"
		)
			continue;
		const tu = item as ClaudeToolUseContent;
		const name = tu.name ?? "unknown";
		switch (name) {
			case "Bash": {
				const cmd = (tu.input?.command as string) ?? "";
				const short = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
				out.push({ toolUseId: tu.id, activity: { kind: "shell", summary: `\`${short}\``, timestamp } });
				break;
			}
			case "Edit":
			case "Write": {
				const path = (tu.input?.file_path as string) ?? "unknown";
				out.push({ toolUseId: tu.id, activity: { kind: "file_edit", summary: `${name} \`${path}\``, timestamp } });
				break;
			}
			case "Read": {
				const path = (tu.input?.file_path as string) ?? "unknown";
				out.push({ toolUseId: tu.id, activity: { kind: "file_read", summary: `Read \`${path}\``, timestamp } });
				break;
			}
			case "Glob":
			case "Grep": {
				const pattern = (tu.input?.pattern as string) ?? "";
				out.push({ toolUseId: tu.id, activity: { kind: "other", summary: `${name} \`${pattern}\``, timestamp } });
				break;
			}
			case "WebFetch":
			case "WebSearch": {
				const query = (tu.input?.query as string) ?? (tu.input?.url as string) ?? "";
				out.push({ toolUseId: tu.id, activity: { kind: "web", summary: `${name}: ${query.slice(0, 80)}`, timestamp } });
				break;
			}
			case "Agent":
			case "Task": {
				const desc = (tu.input?.description as string) ?? "subagent";
				out.push({ toolUseId: tu.id, activity: { kind: "other", summary: `Agent: ${desc}`, timestamp } });
				break;
			}
		}
	}
	return out;
}

function applyToolResults(content: unknown, pending: Map<string, ToolActivity>): void {
	if (!Array.isArray(content)) return;
	for (const item of content) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("type" in item) ||
			(item as { type: string }).type !== "tool_result"
		)
			continue;
		const result = item as ClaudeToolResultContent;
		if (!result.tool_use_id) continue;
		const activity = pending.get(result.tool_use_id);
		if (!activity) continue;
		activity.status = result.is_error ? "failure" : "success";
		pending.delete(result.tool_use_id);
	}
}

/** From `…/<parent>/subagents/agent-<id>.jsonl` derive {agentId, parentSessionId}. */
function deriveSidechainFromPath(sourcePath?: string): { agentId?: string; parent?: string } {
	if (!sourcePath) return {};
	const parts = sourcePath.split(/[\\/]+/).filter(Boolean);
	const subIdx = parts.lastIndexOf("subagents");
	const file = parts[parts.length - 1] ?? "";
	const fileMatch = file.match(/agent-([0-9a-f]+)\.jsonl$/i);
	const parent = subIdx > 0 ? parts[subIdx - 1] : undefined;
	return { agentId: fileMatch?.[1], parent };
}

export function parseClaudeSession(content: string, sourcePath?: string): NormalizedSession {
	const lines = content.split("\n").filter((l) => l.trim());

	const records: ClaudeRecord[] = [];
	const parseWarnings: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const rec = tryParseLine(lines[i]);
		if (rec) records.push(rec);
		else if (i === lines.length - 1) parseWarnings.push("ignored trailing partial json line");
		else parseWarnings.push(`ignored malformed line ${i + 1}`);
	}

	let fileSessionId = "";
	let recordAgentId: string | undefined;
	let isSidechain = false;
	let cwd: string | undefined;
	let model: string | undefined;
	let createdAt = "";
	let updatedAt = "";

	const messages: ConversationMessage[] = [];
	const toolActivities: ToolActivity[] = [];
	const pending = new Map<string, ToolActivity>();

	for (const rec of records) {
		const ts = rec.timestamp ?? "";
		if (ts) {
			if (!createdAt || ts < createdAt) createdAt = ts;
			if (!updatedAt || ts > updatedAt) updatedAt = ts;
		}
		if (rec.sessionId && !fileSessionId) fileSessionId = rec.sessionId;
		if (rec.agentId && !recordAgentId) recordAgentId = rec.agentId;
		if (rec.isSidechain === true) isSidechain = true;
		if (rec.cwd && !cwd) cwd = rec.cwd;

		switch (rec.type) {
			case "user": {
				const c = rec.message?.content;
				const text = typeof c === "string" ? c : extractTextContent(c);
				if (text) messages.push({ role: "user", text, timestamp: ts });
				applyToolResults(c, pending);
				break;
			}
			case "assistant": {
				if (!model && rec.message?.model) model = rec.message.model;
				const c = rec.message?.content;
				const text = extractTextContent(c);
				if (text) messages.push({ role: "assistant", text, timestamp: ts });
				for (const { toolUseId, activity } of extractToolUses(c, ts)) {
					toolActivities.push(activity);
					if (toolUseId) pending.set(toolUseId, activity);
				}
				break;
			}
		}
	}

	const fromPath = deriveSidechainFromPath(sourcePath);
	const agentId = recordAgentId ?? fromPath.agentId;
	isSidechain = isSidechain || !!fromPath.agentId;

	let sessionId: string;
	let parentSessionId: string | undefined;
	if (isSidechain) {
		// `fileSessionId` is the PARENT id in sidechain files; identity is the agentId.
		sessionId = agentId ?? fileSessionId;
		parentSessionId = fileSessionId || fromPath.parent;
		if (parentSessionId === sessionId) parentSessionId = fromPath.parent;
	} else {
		sessionId = fileSessionId;
	}

	if (!sessionId) {
		const m = (sourcePath ?? "").match(/([0-9a-f-]{36})\.jsonl$/i);
		sessionId = m?.[1] ?? sourcePath ?? "";
	}

	return {
		source: "claude",
		sessionId,
		parentSessionId,
		isSubAgent: classifyIsSubAgent({ parentSessionId }) || isSidechain,
		agentId: isSidechain ? agentId : undefined,
		createdAt,
		updatedAt,
		cwd,
		model,
		messages,
		toolActivities,
		parseWarnings,
	};
}
