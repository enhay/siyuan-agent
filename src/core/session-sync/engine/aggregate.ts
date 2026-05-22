/** Sub-agent aggregation helpers (Codex workers/explorers, Claude sidechains).
 *
 *  Hierarchy in SiYuan is built by moving child docs under the parent doc via
 *  moveDocsByID (the only kernel-contracted way — see plan §10). The parent body
 *  also lists child links, rendered from state, so it is eventually consistent
 *  when only a child changed (the file-tree nesting is always timely). */

import type { SyncState } from "./types";
import { sessionKey } from "./identity";

export interface ChildLink {
	docId: string;
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

/** Child links for a parent, gathered from state, ordered stably by createdAt. */
export function collectChildLinks(state: SyncState, parentSource: string, parentSessionId: string): ChildLink[] {
	const want = parentSessionKey(parentSource, parentSessionId);
	const children = Object.values(state.sessions).filter(
		(r) => r.docId && r.parentSessionId && r.source && parentSessionKey(r.source, r.parentSessionId) === want,
	);
	children.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || (a.sessionId ?? "").localeCompare(b.sessionId ?? ""));
	return children.map((r) => ({
		docId: r.docId as string,
		title: r.title || r.sessionId || r.docId!,
		role: r.agentRole,
		nickname: r.agentNickname,
		toolCount: r.toolCount,
		failedToolCount: r.failedToolCount,
		createdAt: r.createdAt,
	}));
}

export interface PendingMove {
	childDocId: string;
	parentDocId: string;
	childSessionKey: string;
}

export interface PendingBacklink {
	childDocId: string;
	childSessionKey: string;
	parentDocId: string;
	parentTitle: string;
}

/** Children whose parent doc exists but which don't yet have a back-link block to
 *  it (or it points at a stale parent). Caller prepends the link and marks
 *  `backLinkedTo`. */
export function pendingBacklinks(state: SyncState): PendingBacklink[] {
	const out: PendingBacklink[] = [];
	for (const rec of Object.values(state.sessions)) {
		if (!rec.docId || !rec.parentSessionId || !rec.source) continue;
		const parent = state.sessions[parentSessionKey(rec.source, rec.parentSessionId)];
		if (!parent?.docId) continue;
		if (rec.backLinkedTo === parent.docId) continue;
		out.push({
			childDocId: rec.docId,
			childSessionKey: sessionKey({ source: rec.source, sessionId: rec.sessionId ?? "" }),
			parentDocId: parent.docId,
			parentTitle: parent.title || parent.sessionId || parent.docId,
		});
	}
	return out;
}

/** Children whose parent doc now exists but which haven't been moved under it yet
 *  (or were moved under a different parent). Caller performs the moves and marks
 *  `movedUnderParent` so this stays idempotent. */
export function pendingChildMoves(state: SyncState): PendingMove[] {
	const moves: PendingMove[] = [];
	for (const rec of Object.values(state.sessions)) {
		if (!rec.docId || !rec.parentSessionId || !rec.source) continue;
		const parent = state.sessions[parentSessionKey(rec.source, rec.parentSessionId)];
		if (!parent?.docId) continue; // parent not synced yet → move later
		if (rec.movedUnderParent === parent.docId) continue; // already nested
		moves.push({ childDocId: rec.docId, parentDocId: parent.docId, childSessionKey: sessionKey({ source: rec.source, sessionId: rec.sessionId ?? "" }) });
	}
	return moves;
}
