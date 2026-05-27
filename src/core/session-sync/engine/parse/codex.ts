/** Parse a Codex CLI session JSONL into a NormalizedSession.
 *
 *  Ported from `ailogger` (`src/parsing/codex.ts`). Change: takes file *content*
 *  (a string) instead of reading disk, so the engine stays pure and runtime-agnostic.
 *  The disk read lives in the FileSource adapter. */

import type { ConversationMessage, NormalizedSession, ToolActivity } from "../types";

interface RawRecord {
	timestamp: string;
	type: string;
	payload: Record<string, unknown>;
}

interface ResponseItemContentPart {
	type?: string;
	text?: string;
}

interface SessionMetaSource {
	subagent?: { thread_spawn?: { parent_thread_id?: string } };
}

function tryParseLine(line: string): RawRecord | null {
	try {
		return JSON.parse(line) as RawRecord;
	} catch {
		return null;
	}
}

function extractResponseItemText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is ResponseItemContentPart =>
				typeof item === "object" &&
				item !== null &&
				"text" in item &&
				typeof (item as ResponseItemContentPart).text === "string",
		)
		.map((item) => item.text?.trim() ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

function isInjectedContextMessage(role: "user" | "assistant", text: string): boolean {
	if (role !== "user") return false;
	const normalized = text.trim();
	if (
		normalized.startsWith("# AGENTS.md instructions for ") &&
		(normalized.includes("<INSTRUCTIONS>") || normalized.includes("<environment_context>"))
	)
		return true;
	// Codex control injections that aren't real user input (interrupt markers,
	// standalone context blocks, sub-agent result callbacks fed back to the parent
	// as a user-role message) — would otherwise render as user turns / doc titles.
	return /^<(turn_aborted|environment_context|user_instructions|subagent_notification)\b/.test(normalized);
}

/** Prior-meta carried from state so the parser can fill in fields a partial
 *  (offset-based) slice may lack (no session_meta record at slice start, etc).
 *  Only used by incremental reads — full reads ignore it. */
export interface PriorSessionMeta {
	sessionId?: string;
	cwd?: string;
	model?: string;
	createdAt?: string;
	parentSessionId?: string;
	agentNickname?: string;
	agentRole?: string;
	isSubAgent?: boolean;
}

export function parseCodexSession(
	content: string,
	_sourcePath?: string,
	prior?: PriorSessionMeta,
): NormalizedSession {
	const lines = content.split("\n").filter((l) => l.trim());

	const records: RawRecord[] = [];
	const parseWarnings: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const rec = tryParseLine(lines[i]);
		if (rec) records.push(rec);
		else if (i === lines.length - 1) parseWarnings.push("ignored trailing partial json line");
		else parseWarnings.push(`ignored malformed line ${i + 1}`);
	}

	let sessionId = "";
	let parentSessionId: string | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let agentNickname: string | undefined;
	let agentRole: string | undefined;
	let isSubAgentMarker = false;
	let createdAt = "";
	let updatedAt = "";

	const responseMessages: ConversationMessage[] = [];
	const fallbackMessages: ConversationMessage[] = [];
	const toolActivities: ToolActivity[] = [];

	for (const rec of records) {
		if (!createdAt || rec.timestamp < createdAt) createdAt = rec.timestamp;
		if (!updatedAt || rec.timestamp > updatedAt) updatedAt = rec.timestamp;

		switch (rec.type) {
			case "session_meta": {
				sessionId = (rec.payload.id as string) ?? sessionId;
				cwd = (rec.payload.cwd as string) ?? cwd;
				model = (rec.payload.model as string) ?? model;
				// `source` is codex's authoritative marker: a string ("cli"/"vscode"/…)
				// for a user-started MAIN session, or an object with `subagent` for a
				// spawned sub-agent. Classify on that, not on agent_role (redundant +
				// would misfire if a future main carried a role).
				if (typeof rec.payload.source === "object" && rec.payload.source !== null) {
					const sourceMeta = rec.payload.source as SessionMetaSource;
					if (sourceMeta.subagent) isSubAgentMarker = true;
					parentSessionId =
						sourceMeta.subagent?.thread_spawn?.parent_thread_id ?? parentSessionId;
				}
				if (rec.payload.agent_nickname) agentNickname = rec.payload.agent_nickname as string;
				if (rec.payload.agent_role) agentRole = rec.payload.agent_role as string;
				if (rec.payload.timestamp) createdAt = rec.payload.timestamp as string;
				break;
			}
			case "turn_context": {
				if (!cwd && rec.payload.cwd) cwd = rec.payload.cwd as string;
				if (!model && rec.payload.model) model = rec.payload.model as string;
				break;
			}
			case "event_msg": {
				const eventType = rec.payload.type as string;
				switch (eventType) {
					case "user_message": {
						const msg = rec.payload.message as string;
						if (!isInjectedContextMessage("user", msg)) {
							fallbackMessages.push({ role: "user", text: msg, timestamp: rec.timestamp });
						}
						break;
					}
					case "agent_message": {
						const msg = rec.payload.message as string;
						fallbackMessages.push({ role: "assistant", text: msg, timestamp: rec.timestamp });
						break;
					}
					case "exec_command_end": {
						const cmd = rec.payload.command as string;
						const exitCode = rec.payload.exit_code as number;
						toolActivities.push({
							kind: "shell",
							summary: `\`${cmd}\` → exit ${exitCode}`,
							timestamp: rec.timestamp,
							status: exitCode === 0 ? "success" : "failure",
						});
						break;
					}
					case "patch_apply_end": {
						const path = rec.payload.path as string;
						const success = rec.payload.success as boolean;
						toolActivities.push({
							kind: "file_edit",
							summary: `Patched \`${path}\``,
							timestamp: rec.timestamp,
							status: success ? "success" : "failure",
						});
						break;
					}
				}
				break;
			}
			case "response_item":
				if (rec.payload.type === "message") {
					const role = rec.payload.role;
					if (role === "user" || role === "assistant") {
						const text = extractResponseItemText(rec.payload.content);
						if (text && !isInjectedContextMessage(role, text)) {
							responseMessages.push({ role, text, timestamp: rec.timestamp });
						}
					}
				}
				break;
		}
	}

	const messages = responseMessages.length > 0 ? responseMessages : fallbackMessages;

	// Fill in anything the slice didn't carry from prior state — relevant for
	// incremental reads where the session_meta record is upstream of the offset.
	const mergedSessionId = sessionId || prior?.sessionId || "";
	const mergedCwd = cwd || prior?.cwd;
	const mergedModel = model || prior?.model;
	const mergedCreatedAt = createdAt || prior?.createdAt || "";
	const mergedParentSessionId = parentSessionId || prior?.parentSessionId;
	const mergedAgentNickname = agentNickname || prior?.agentNickname;
	const mergedAgentRole = agentRole || prior?.agentRole;
	// Sub-agent classification is sticky once observed (the marker only appears
	// in session_meta which a partial slice may lack).
	const mergedIsSubAgent = isSubAgentMarker || (prior?.isSubAgent ?? false);

	return {
		source: "codex",
		sessionId: mergedSessionId,
		parentSessionId: mergedParentSessionId,
		isSubAgent: mergedIsSubAgent,
		createdAt: mergedCreatedAt,
		updatedAt: updatedAt || mergedCreatedAt,
		cwd: mergedCwd,
		model: mergedModel,
		agentNickname: mergedAgentNickname,
		agentRole: mergedAgentRole,
		messages,
		toolActivities,
		parseWarnings,
	};
}
