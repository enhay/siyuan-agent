/** Infer a session's lifecycle status for the overview + custom attrs.
 *
 *  Deterministic heuristic (plan §13 Phase 6): a session whose last activity is
 *  within the active window is still running; an explicit interruption marker
 *  wins; otherwise it's completed. */

import type { NormalizedSession } from "./types";

export type SessionStatus = "active" | "completed" | "interrupted";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export function inferStatus(
	session: NormalizedSession,
	now: number = Date.now(),
	activeWindowMs: number = ACTIVE_WINDOW_MS,
): SessionStatus {
	const interrupted = session.parseWarnings.some((w) => /abort|interrupt/i.test(w));
	if (interrupted) return "interrupted";
	const updated = Date.parse(session.updatedAt);
	if (!Number.isNaN(updated) && now - updated < activeWindowMs) return "active";
	return "completed";
}
