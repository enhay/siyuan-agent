/** Stable identity, paths, titles, and hashing for sessions.
 *
 *  Ported from `ailogger` (`src/siyuan/identity.ts`); `contentHash` uses Web
 *  Crypto (`crypto.subtle`) instead of `node:crypto`, keeping the `sha256:` form
 *  so plugin and CLI hashes stay comparable. (Sub-agent classification lives in
 *  the parsers, using each tool's authoritative marker: codex `source.subagent`,
 *  claude `isSidechain`.) */

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

/** Deterministic asset path for a sub-agent's `.md` attachment (relative to the
 *  workspace assets dir). Deterministic so re-rendering overwrites in place (via
 *  putFile) — no orphaned assets, parent links stay valid. */
export function assetRelPath(session: Pick<NormalizedSession, "source" | "sessionId">): string {
	return `session-sync/${session.source}-${slugify(session.sessionId) || "session"}.md`;
}

/** Depth-2 grouping folder: the session's project (cwd basename), or 未归类
 *  when cwd yields none. Folders exist for human browsing only — time/source
 *  filtering is served by the IAL attrs + search, so we group by the one axis
 *  users actually recall ("which project"). */
export function projectFolder(cwd: string | undefined): string {
	const slug = projectSlug(cwd);
	return slug === "unknown" ? "未归类" : slug;
}

const SOURCE_EMOJI: Record<SessionSource, string> = { codex: "🧪", claude: "🪻" };

/** Readable doc name shown in the tree: `<emoji><MM-DD> <title>`. The source
 *  emoji + date prefix give at-a-glance source and chronological sort within the
 *  project folder; the clean title is preserved separately in custom-ai-title. */
export function buildDocName(session: NormalizedSession, title: string): string {
	const emoji = SOURCE_EMOJI[session.source] ?? "";
	const mmdd = (session.createdAt || "").slice(5, 10); // YYYY-MM-DD → MM-DD
	const prefix = mmdd ? `${emoji}${mmdd} ` : emoji ? `${emoji} ` : "";
	return `${prefix}${title}`;
}

/** Stable HPath `<root>/<project>/<leaf>` (depth 2). Does NOT depend on the
 *  dynamic/AI title — the readable name is set separately via renameDoc
 *  (buildDocName), so the leaf only needs to be stable + unique. */
export function buildSiyuanDocPath(rootPath: string, session: NormalizedSession): string {
	const root = rootPath.startsWith("/") ? rootPath : `/${rootPath}`;
	const leaf = `${session.source}-${shortSessionId(session.sessionId)}`;
	return `${root.replace(/\/+$/, "")}/${projectFolder(session.cwd)}/${leaf}`;
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

/** First user message with real content (≥3 chars after stripping a leading
 *  slash-command). The shared basis for both the heuristic title and the AI title
 *  seed — so a throwaway opener like "hi" is skipped in both, not fed to the model
 *  (which would echo the instruction back as a junk title). */
export function firstSubstantiveUserMessage(session: NormalizedSession): string | undefined {
	for (const message of session.messages) {
		if (message.role !== "user") continue;
		const cleaned = cleanTitleText(message.text);
		if (cleaned.length >= 3) return cleaned;
	}
	return undefined;
}

/** Deterministic title: first substantive user message, truncated; falls back to
 *  a project/source/id label. */
export function inferTitle(session: NormalizedSession): string {
	const msg = firstSubstantiveUserMessage(session);
	if (msg) return msg.length <= 80 ? msg : `${msg.slice(0, 77)}...`;
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
