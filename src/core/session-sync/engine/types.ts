/** Engine-core types for AI session-log syncing.
 *
 *  Ported from `ailogger` (`/home/zhaohua/code/test/ailogger/src/types.ts`).
 *  This layer is pure: no Node, no SiYuan, no fs. Adapters supply IO via the
 *  ports in `ports.ts`. Parsers take file *content* (a string), never read disk,
 *  so the same logic runs in the plugin (UNC/native fs) and the CLI sidecar.
 *
 *  See `docs/session-sync-plan.md`. */

export type SessionSource = "codex" | "claude";

export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: string;
}

export interface ToolActivity {
	kind: "shell" | "file_edit" | "file_read" | "web" | "other";
	summary: string;
	timestamp: string;
	status?: "success" | "failure";
}

/** A single AI coding session normalized across Codex and Claude Code. */
export interface NormalizedSession {
	source: SessionSource;
	/** Stable per-session id. For Claude sub-agents this is the `agentId`, NOT
	 *  the file's `sessionId` field (which equals the parent's id). See B2 in the plan. */
	sessionId: string;
	/** Parent session id when this is a sub-agent (Codex worker/explorer, Claude sidechain). */
	parentSessionId?: string;
	/** True when this session is a sub-agent transcript. */
	isSubAgent?: boolean;
	/** Claude-only: the unique `agentId` of a sidechain sub-agent. */
	agentId?: string;
	createdAt: string;
	updatedAt: string;
	cwd?: string;
	model?: string;
	agentNickname?: string;
	agentRole?: string;
	messages: ConversationMessage[];
	toolActivities: ToolActivity[];
	parseWarnings: string[];
}

export interface FileCursor {
	offset: number;
	mtimeMs?: number;
	sessionKey?: string;
}

/** Per-session record persisted in sync state and mirrored into doc custom attrs. */
export interface SessionRecord {
	target: "siyuan";
	/** Set for main sessions (stored as SiYuan documents). */
	docId?: string;
	/** Set for sub-agent sessions (stored as `.md` attachments under data/assets/). */
	assetPath?: string;
	path?: string;
	title?: string;
	titleSource?: "ai" | "heuristic";
	contentHash?: string;
	source?: SessionSource;
	sessionId?: string;
	parentSessionId?: string;
	agentId?: string;
	createdAt?: string;
	updatedAt?: string;
	cwd?: string;
	model?: string;
	agentNickname?: string;
	agentRole?: string;
	messageCount?: number;
	toolCount?: number;
	failedToolCount?: number;
	lastSourceOffset?: number;
	lastWrittenAt?: string;
	/** Parent doc id this child has been moved under (idempotency for aggregation). */
	movedUnderParent?: string;
	/** Parent doc id this child has a back-link block to (idempotency). Reset on
	 *  overwrite since clearing children wipes the prepended back-link. */
	backLinkedTo?: string;
	// ── Incremental-update fields (Phase 2: append + section-replace + multi-part).
	//    Sessions written under the new structure carry these; legacy sessions
	//    (created before C4 landed) leave them undefined and stay on the old
	//    overwrite path indefinitely (per migration choice — see CONTEXT/CLAUDE.md).
	/** When true, this session is managed by the incremental writer (section-attr
	 *  blocks + append-only dialog + multi-part chain). */
	incrementalEnabled?: boolean;
	/** Ordered chain of part-doc ids. Last entry is the active part (target of
	 *  future appends); `docId` mirrors it for backward compat with legacy code. */
	partDocIds?: string[];
	/** Total dialog messages already written across all parts. Drives the
	 *  append-only tail: next render only emits `messages.slice(appendedMessageCount)`. */
	appendedMessageCount?: number;
	/** Total tool activities already written across all parts. Same idea for the
	 *  tools section's append-only tail. */
	appendedToolCount?: number;
	/** Estimated bytes written into the active part's body (sum of markdown
	 *  appended so far, excluding overview/summary which get section-replaced).
	 *  Compared against the part-size threshold to decide when to spill into a
	 *  new part. */
	currentPartBytes?: number;
}

export interface SyncState {
	files: Record<string, FileCursor>;
	sessions: Record<string, SessionRecord>;
	/** Last successful reconcile time (engine-owned; kept out of user config to
	 *  avoid lost-update races with the settings save path). */
	lastSyncAt?: number;
}

export interface ReconcileResult {
	updatedSessions: number;
	newSessions: number;
	errors: string[];
}
