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
		// Harness-injected background-task completion blocks (not user input).
		.replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
		// All <local-command-*> and <command-*> wrappers (stdout/stderr/caveat,
		// name/message/args, …) — backreference keeps open/close tags paired.
		.replace(/<local-command-([a-z-]+)>[\s\S]*?<\/local-command-\1>/gi, "")
		.replace(/<command-([a-z-]+)>[\s\S]*?<\/command-\1>/gi, "")
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

/** Detect a real cross-tool CLI invocation (codex↔claude) in a shell summary.
 *  Excludes help/version/which and path noise (e.g. a `claude-code` directory). */
function crossToolCmd(summary: string, other: "codex" | "claude"): string | null {
	const m = summary.match(/`([^`]+)`/);
	const cmd = (m ? m[1] : summary).trim();
	if (new RegExp(`${other}-code|/${other}(?:-|/|\\b)`, "i").test(cmd)) return null; // path noise
	if (/--help|--version|\bwhich\b|\bman\b/i.test(cmd)) return null;
	if (!new RegExp(`\\b${other}\\b\\s+(exec|chat|run|review|-p\\b|--print|--prompt|["'])`, "i").test(cmd)) return null;
	return cmd.replace(/`/g, "'");
}

function oneLine(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** A flat, plain-text one-line teaser for the muted 结论 callout: code fences →
 *  placeholder, table rows / heading & emphasis markers dropped, so a long
 *  table- or heading-ending message doesn't collapse into pipe/asterisk noise. */
function teaser(text: string, max: number): string {
	const plain = text
		.replace(/```[\s\S]*?```/g, " [代码] ")
		.replace(/^\s*\|.*\|\s*$/gm, " ") // markdown table rows
		.replace(/^\s*#{1,6}\s+/gm, "") // heading markers
		.replace(/[*_`>#]/g, ""); // residual emphasis / quote / hash markers
	return oneLine(plain, max);
}

export interface RenderOptions {
	/** Display title (also used in attrs/state). Defaults to the heuristic. */
	title?: string;
	/** Lifecycle status shown in the overview. Defaults to "completed". */
	status?: string;
	/** Sub-agent attachment links inlined into the conversation at trigger time. */
	subAgents?: Array<{ title: string; role?: string; nickname?: string; assetPath: string; toolCount?: number; failedToolCount?: number; createdAt?: string }>;
}

export function renderSession(session: NormalizedSession, options: RenderOptions = {}): string {
	const lines: string[] = [];
	const failed = session.toolActivities.filter((t) => t.status === "failure");
	const highSignal = session.toolActivities.filter(isHighSignalTool);
	const lowSignalCount = session.toolActivities.length - highSignal.length;
	const subs = options.subAgents ?? [];

	// Cleaned, non-empty conversation turns (drives both TL;DR and 对话).
	const turns = session.messages
		.map((m) => ({ role: m.role, text: cleanMessageText(m.text), ts: m.timestamp }))
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

	// Sub-agent entries are inlined into the 对话 timeline at their trigger time
	// (see below), so there is no standalone 子代理 section.

	// ── 🎯 结论 (TL;DR) — a muted callout (blockquote), not a heading, to keep it
	//    visually light: it's a heuristic 问/答 teaser (答 = the last assistant turn),
	//    not an authoritative summary.
	// Mirror the title's basis: the first *substantive* user turn (skip throwaway
	// openers like "hi"), falling back to the first user turn if none qualifies.
	const firstUser =
		turns.find((m) => m.role === "user" && m.text.trim().length >= 3) ?? turns.find((m) => m.role === "user");
	const lastAssistant = [...turns].reverse().find((m) => m.role === "assistant");
	if (firstUser || lastAssistant || failed.length > 0) {
		const parts: string[] = [];
		if (firstUser) parts.push(`🎯 **问** ${teaser(firstUser.text, 120)}`);
		if (lastAssistant) parts.push(`**答** ${teaser(lastAssistant.text, 220)}`);
		if (failed.length > 0) parts.push(`⚠️ 有 ${failed.length} 个工具调用失败，见下方折叠区。`);
		lines.push(
			parts
				.join("\n\n")
				.split("\n")
				.map((l) => (l ? `> ${l}` : ">"))
				.join("\n"),
			"",
		);
	}

	// ── 💬 对话 ── (chronological; sub-agent entries inlined at their trigger time)
	lines.push("## 💬 对话", "");
	type Item =
		| { ts: string; kind: "msg"; role: "user" | "assistant"; text: string }
		| { ts: string; kind: "sub"; assetPath: string; label: string }
		| { ts: string; kind: "xtool"; other: string; cmd: string };
	const items: Item[] = turns.map((m) => ({ ts: m.ts ?? "", kind: "msg", role: m.role, text: m.text }));
	// Cross-tool CLI invocations (codex↔claude) inlined as notes at call time.
	const otherTool = session.source === "codex" ? "claude" : "codex";
	for (const t of session.toolActivities) {
		if (t.kind !== "shell") continue;
		const cmd = crossToolCmd(t.summary, otherTool);
		if (cmd) items.push({ ts: t.timestamp ?? "", kind: "xtool", other: otherTool, cmd });
	}
	const subLabelCounts = new Map<string, number>();
	for (const s of subs) {
		const base = s.nickname ? `${s.role ?? "agent"} · ${s.nickname}` : s.role ?? "agent";
		const seen = (subLabelCounts.get(base) ?? 0) + 1;
		subLabelCounts.set(base, seen);
		const label = `${seen === 1 ? base : `${base} (${seen})`} — ${s.title}`;
		items.push({ ts: s.createdAt ?? "", kind: "sub", assetPath: s.assetPath, label });
	}
	// Stable sort by timestamp keeps a sub-agent right after the turn that spawned it.
	items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

	if (items.length === 0) {
		lines.push("（无对话内容）", "");
	} else {
		let prevRole: string | null = null;
		for (const it of items) {
			if (it.kind === "sub") {
				const text = it.label.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "").trim();
				lines.push(`> 🧩 **子代理** [${text}](${it.assetPath})`, "");
				prevRole = null; // a marker breaks any role grouping
				continue;
			}
			if (it.kind === "xtool") {
				lines.push(`> ↗ **调用 ${it.other}**：\`${it.cmd}\``, "");
				prevRole = null;
				continue;
			}
			if (it.role === "user") {
				if (prevRole !== "user") lines.push("> 🧑 **用户**", ">");
				lines.push(...it.text.split("\n").map((line) => `> ${line}`), "");
			} else {
				if (prevRole !== "assistant") lines.push("🤖 **助手**", "");
				lines.push(it.text, "");
			}
			prevRole = it.role;
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
