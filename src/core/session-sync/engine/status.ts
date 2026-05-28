/** Infer a session's lifecycle status for the overview + custom attrs.
 *
 *  Deterministic heuristic (plan §13 Phase 6): a session whose last activity is
 *  within the active window is still running; an explicit interruption marker
 *  wins; otherwise it's completed.
 *
 *  Note: the active window MUST align with the reconciler's settle window —
 *  otherwise sessions sitting in the gap (settled enough to write, but still
 *  "active" by status) flip from active→completed mid-window, causing a
 *  second write per session as the render output changes. We default to the
 *  same 5min the reconciler uses, and the reconciler passes its own settleMs
 *  in so the two stay synced even if the user customizes one of them. */

import type { NormalizedSession } from "./types";

export type SessionStatus = "active" | "completed" | "interrupted";

const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export function inferStatus(
	session: NormalizedSession,
	now: number = Date.now(),
	activeWindowMs: number = DEFAULT_ACTIVE_WINDOW_MS,
): SessionStatus {
	const interrupted = session.parseWarnings.some((w) => /abort|interrupt/i.test(w));
	if (interrupted) return "interrupted";
	const updated = Date.parse(session.updatedAt);
	if (!Number.isNaN(updated) && now - updated < activeWindowMs) return "active";
	return "completed";
}
