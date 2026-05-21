/** Render a NormalizedSession into a readable SiYuan markdown document.
 *
 *  Readability design (plan §17):
 *  - No body H1 — the document's own title (set via renameDoc) is the heading.
 *  - 🎯 结论 is a real TL;DR (问→答 teaser), not a copy of the last message.
 *  - 💬 对话 is one chronological thread; user turns are blockquotes (🧑), assistant
 *    turns are plain blocks (🤖) so their code/lists render natively.
 *  - Injected noise (<system-reminder>, <command-*>, caveats) is stripped; empty
 *    turns are skipped.
 *  - 🔧 工具调用 and ⚠️ 解析警告 sit under headings the writer folds by default
 *    (SiYuan has no working <details>; a heading with fold="1" collapses its body).
 *    See `FOLDABLE_HEADING_PREFIXES`. */

import type { NormalizedSession, ToolActivity } from "./types";
import { projectSlug } from "./identity";

/** Headings whose content starts with one of these are folded by the writer. */
export const FOLDABLE_HEADING_PREFIXES = ["🔧 工具调用", "⚠️ 解析警告"];

/** Strip injected wrappers that pollute conversation turns (CLAUDE.md reminders,
 *  slash-command echoes, local-command output, caveats). Conservative: only known
 *  wrapper tags / caveat lines. */
export function cleanMessageText(raw: string): string {
	return raw
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
		.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, "")
		.replace(/<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/gi, "")
		.replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi, "")
		.replace(/^Caveat:.*$/gim, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function statusIcon(status?: ToolActivity["status"]): string {
	return status === "failure" ? "❌" : status === "success" ? "✅" : "•";
}

function formatTool(tool: ToolActivity): string {
	return `- ${statusIcon(tool.status)} **${tool.kind}** ${tool.summary}`;
}

function isHighSignalTool(tool: ToolActivity): boolean {
	const summary = tool.summary.toLowerCase();
	return (
		tool.status === "failure" ||
		tool.kind === "file_edit" ||
		/\b(npm test|npm run check|npm run build|go test|cargo test|pytest|vitest|tsc|git status|git diff|git commit)\b/.test(summary)
	);
}

/** Block-ref anchors are double-quote delimited; swap quotes/newlines so a title
 *  can't terminate the ref early. */
function refAnchor(title: string): string {
	return title.replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
}

function oneLine(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** First `max` chars (keeping line breaks so lists/steps survive) for the TL;DR. */
function excerpt(text: string, max: number): string {
	const t = text.replace(/\n{3,}/g, "\n\n").trim();
	return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

export interface RenderOptions {
	/** Display title (also used in attrs/state). Defaults to the heuristic. */
	title?: string;
	/** Lifecycle status shown in the overview. Defaults to "completed". */
	status?: string;
	/** Sub-agent links injected under a "## 🧩 子代理" section. */
	subAgents?: Array<{ title: string; role?: string; nickname?: string; docId: string; toolCount?: number; failedToolCount?: number }>;
}

export function renderSession(session: NormalizedSession, options: RenderOptions = {}): string {
	const lines: string[] = [];
	const failed = session.toolActivities.filter((t) => t.status === "failure");
	const highSignal = session.toolActivities.filter(isHighSignalTool);
	const lowSignalCount = session.toolActivities.length - highSignal.length;
	const subs = options.subAgents ?? [];

	// Cleaned, non-empty conversation turns (drives both TL;DR and 对话).
	const turns = session.messages
		.map((m) => ({ role: m.role, text: cleanMessageText(m.text) }))
		.filter((m) => m.text.length > 0);

	// ── 📋 概览 ──
	lines.push("## 📋 概览", "");
	lines.push("| 字段 | 值 |", "|---|---|");
	lines.push(`| 来源 | ${session.source} |`);
	lines.push(`| 项目 | ${projectSlug(session.cwd)} |`);
	if (session.isSubAgent) lines.push(`| 角色 | ${session.agentRole ?? "sub-agent"}${session.agentNickname ? ` (${session.agentNickname})` : ""} |`);
	lines.push(`| 状态 | ${options.status ?? "completed"} |`);
	lines.push(`| 时间 | ${session.createdAt} → ${session.updatedAt} |`);
	lines.push(`| 消息 / 工具 | ${session.messages.length} / ${session.toolActivities.length}（失败 ${failed.length}） |`);
	if (subs.length > 0) {
		const childTools = subs.reduce((n, s) => n + (s.toolCount ?? 0), 0);
		const childFailed = subs.reduce((n, s) => n + (s.failedToolCount ?? 0), 0);
		lines.push(`| 子代理 | ${subs.length}（工具 ${childTools}，失败 ${childFailed}） |`);
	}
	if (session.cwd) lines.push(`| cwd | \`${session.cwd}\` |`);
	if (session.model) lines.push(`| model | ${session.model} |`);
	lines.push("");

	// ── 🧩 子代理 ──
	if (subs.length > 0) {
		lines.push("## 🧩 子代理", "");
		const labelCounts = new Map<string, number>();
		for (const sub of subs) {
			const base = sub.nickname ? `${sub.role ?? "agent"} · ${sub.nickname}` : sub.role ?? "agent";
			const seen = (labelCounts.get(base) ?? 0) + 1;
			labelCounts.set(base, seen);
			const label = seen === 1 ? base : `${base} (${seen})`;
			lines.push(`- ((${sub.docId} "${refAnchor(sub.title)}")) — ${label}`);
		}
		lines.push("");
	}

	// ── 🎯 结论 (TL;DR) ──
	const firstUser = turns.find((m) => m.role === "user");
	const lastAssistant = [...turns].reverse().find((m) => m.role === "assistant");
	if (firstUser || lastAssistant || failed.length > 0) {
		lines.push("## 🎯 结论", "");
		if (firstUser) lines.push(`**问：** ${oneLine(firstUser.text, 120)}`, "");
		if (lastAssistant) lines.push(`**答：** ${excerpt(lastAssistant.text, 500)}`, "");
		if (failed.length > 0) lines.push(`> ⚠️ 有 ${failed.length} 个工具调用失败，见下方折叠区。`, "");
	}

	// ── 💬 对话 ── (group consecutive same-role turns under one label)
	lines.push("## 💬 对话", "");
	if (turns.length === 0) {
		lines.push("（无对话内容）", "");
	} else {
		for (let i = 0; i < turns.length; i++) {
			const m = turns[i];
			const sameAsPrev = i > 0 && turns[i - 1].role === m.role;
			const sameAsNext = i + 1 < turns.length && turns[i + 1].role === m.role;
			if (m.role === "user") {
				if (!sameAsPrev) lines.push("> 🧑 **用户**", ">");
				lines.push(...m.text.split("\n").map((line) => `> ${line}`));
				lines.push(sameAsNext ? ">" : ""); // keep blockquote open within a group
			} else {
				if (!sameAsPrev) lines.push("🤖 **助手**", "");
				lines.push(m.text, "");
			}
		}
	}

	// ── 🔧 工具调用 (folded) ──
	if (session.toolActivities.length > 0) {
		lines.push(`## 🔧 工具调用 (${session.toolActivities.length})`, "");
		if (highSignal.length > 0) {
			lines.push("### 高信号", "");
			for (const tool of highSignal.slice(0, 80)) lines.push(formatTool(tool));
			if (highSignal.length > 80) lines.push(`- … 另有 ${highSignal.length - 80} 条高信号调用`);
			lines.push("");
		}
		if (failed.length > 0) {
			lines.push("### 失败", "");
			for (const tool of failed.slice(0, 40)) lines.push(formatTool(tool));
			lines.push("");
		}
		if (lowSignalCount > 0) {
			lines.push("### 低信号", "", `已折叠 ${lowSignalCount} 条低信号工具调用。`, "");
		}
	}

	// ── ⚠️ 解析警告 (folded) ──
	if (session.parseWarnings.length > 0) {
		lines.push("## ⚠️ 解析警告", "");
		for (const warning of session.parseWarnings) lines.push(`- ${warning}`);
		lines.push("");
	}

	return lines.join("\n");
}
