/** Sub-agent aggregation helpers (Codex workers/explorers, Claude sidechains).
 *
 *  Sub-agents are stored as `.md` attachments (data/assets/), NOT documents — so a
 *  parent links to each child via an asset link (`[title](assets/…)`) inline in its
 *  conversation. This keeps the document/FTS count small (only main sessions are
 *  docs). Links are gathered from state, so they are eventually consistent when
 *  only a child changed. */

import type { SyncState } from "./types";

export interface ChildLink {
	/** Asset link path (`assets/session-sync/…md`) of the sub-agent transcript. */
	assetPath: string;
	title: string;
	role?: string;
	nickname?: string;
	toolCount?: number;
	failedToolCount?: number;
	/** Child start time (≈ when the parent spawned it) — used to place its link
	 *  inline in the parent's conversation timeline. */
	createdAt?: string;
}

/** Stable parent session key for a child record. */
export function parentSessionKey(source: string, parentSessionId: string): string {
	return `${source}:${parentSessionId}`;
}

/** Sub-agent attachment links for a parent, gathered from state, ordered by createdAt. */
export function collectChildLinks(state: SyncState, parentSource: string, parentSessionId: string): ChildLink[] {
	const want = parentSessionKey(parentSource, parentSessionId);
	const children = Object.values(state.sessions).filter(
		(r) => r.assetPath && r.parentSessionId && r.source && parentSessionKey(r.source, r.parentSessionId) === want,
	);
	children.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || (a.sessionId ?? "").localeCompare(b.sessionId ?? ""));
	return children.map((r) => ({
		assetPath: r.assetPath as string,
		title: r.title || r.sessionId || r.assetPath!,
		role: r.agentRole,
		nickname: r.agentNickname,
		toolCount: r.toolCount,
		failedToolCount: r.failedToolCount,
		createdAt: r.createdAt,
	}));
}
