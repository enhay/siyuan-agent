/** Stable identity, paths, titles, and hashing for sessions.
 *
 *  Ported from `ailogger` (`src/siyuan/identity.ts`) with two changes:
 *  - `contentHash` uses Web Crypto (`crypto.subtle`) instead of `node:crypto`,
 *    keeping the `sha256:` form so plugin and CLI hashes stay comparable.
 *  - `classifyIsSubAgent` fixes ailogger's `!agentRole`-only split (plan B3):
 *    a session is a sub-agent when it has a role OR a parent. */

import type { NormalizedSession, SessionSource } from "./types";

/** Lowercase, keep CJK + alnum, collapse to single dashes. */
export function slugify(value: string | undefined): string {
	return (value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9一-鿿]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

/** Last path segment, accepting both `/` and `\` (UNC) separators. */
export function baseName(p: string | undefined): string {
	if (!p) return "";
	const parts = p.split(/[\\/]+/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : "";
}

export function sessionKey(session: Pick<NormalizedSession, "source" | "sessionId">): string {
	return `${session.source}:${session.sessionId}`;
}

export function fileKey(source: SessionSource, path: string): string {
	return `${source}:${path}`;
}

export function projectSlug(cwd: string | undefined): string {
	return slugify(baseName(cwd)) || "unknown";
}

export function shortSessionId(sessionId: string): string {
	const slug = slugify(sessionId) || "session";
	return slug.length <= 12 ? slug : slug.slice(0, 12);
}

/** A session is a sub-agent if it carries a role OR a parent pointer. ailogger
 *  classified on role alone, which misfiles Codex sub-agents whose `agent_role`
 *  is null but which have a `parent_thread_id` (plan B3). */
export function classifyIsSubAgent(
	session: Pick<NormalizedSession, "agentRole" | "parentSessionId">,
): boolean {
	return !!session.agentRole || !!session.parentSessionId;
}

/** Stable HPath that does NOT depend on a dynamic/AI title (the readable title
 *  is set separately via renameDoc — see plan §11). */
export function buildSiyuanDocPath(rootPath: string, session: NormalizedSession): string {
	const date = (session.createdAt || "").slice(0, 10);
	const [year = "0000", month = "00", day = "00"] = date.split("-");
	const root = rootPath.startsWith("/") ? rootPath : `/${rootPath}`;
	const leaf = `${projectSlug(session.cwd)}--${session.source}--${shortSessionId(session.sessionId)}`;
	return `${root.replace(/\/+$/, "")}/${year}/${month}/${day}/${leaf}`;
}

/** Normalize a candidate title: collapse whitespace, strip a leading slash-command
 *  token (e.g. `/loop summarize` → `summarize`). */
function cleanTitleText(text: string): string {
	// Strip a leading slash-command token only when it's a whole word (followed by
	// whitespace or end) — not a path like "/etc/hosts is broken".
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\/[\w:-]+(?=\s|$)\s*/, "")
		.trim();
}

/** Deterministic title: first substantive user message (skipping bare slash
 *  commands), truncated; falls back to a project/source/id label. */
export function inferTitle(session: NormalizedSession): string {
	for (const message of session.messages) {
		if (message.role !== "user") continue;
		const cleaned = cleanTitleText(message.text);
		if (cleaned.length >= 3) return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 77)}...`;
	}
	return `${projectSlug(session.cwd)} ${session.source} session ${shortSessionId(session.sessionId)}`;
}

/** Custom IAL attributes mirrored onto each generated doc. State-loss recovery
 *  queries `custom-ai-session-key`. Optional keys are omitted (not set to "")
 *  so SiYuan does not store empty attrs. */
export function buildSiyuanAttrs(
	session: NormalizedSession,
	meta: { hash: string; title: string; titleSource: "ai" | "heuristic"; status?: string },
): Record<string, string> {
	const failed = session.toolActivities.filter((t) => t.status === "failure").length;
	const attrs: Record<string, string> = {
		"custom-ai-source": session.source,
		"custom-ai-session-id": session.sessionId,
		"custom-ai-session-key": sessionKey(session),
		"custom-ai-project": projectSlug(session.cwd),
		"custom-ai-status": meta.status ?? "completed",
		"custom-ai-title": meta.title,
		"custom-ai-title-source": meta.titleSource,
		"custom-ai-message-count": String(session.messages.length),
		"custom-ai-tool-count": String(session.toolActivities.length),
		"custom-ai-failed-tool-count": String(failed),
		"custom-ai-content-hash": meta.hash,
	};
	if (session.parentSessionId) attrs["custom-ai-parent-session-id"] = session.parentSessionId;
	if (session.agentId) attrs["custom-ai-agent-id"] = session.agentId;
	return attrs;
}

/** `sha256:<hex>` over the rendered content. Async (Web Crypto). */
export async function contentHash(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}
