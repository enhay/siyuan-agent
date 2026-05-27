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
 *    See `FOLDABLE_HEADING_PREFIXES`.
 *
 *  Modular section renderers (Phase 2): each `## …` section is rendered by its own
 *  `pushXxxSection` helper that pushes into a shared `lines` buffer. The composer
 *  `renderFullDoc` joins them with the exact same spacing the legacy monolithic
 *  renderer produced — `renderSession` is now an alias of `renderFullDoc` for
 *  backward-compat. Section-body and dialog-tail variants live below the composer
 *  so the incremental reconciler can update one section at a time. */

import type { ConversationMessage, NormalizedSession, ToolActivity } from "./types";
import { projectSlug } from "./identity";

/** Headings whose content starts with one of these are folded by the writer. */
export const FOLDABLE_HEADING_PREFIXES = ["🔧 工具调用", "⚠️ 解析警告"];

/** Custom-attr key set on each section's `## heading` block. The incremental
 *  reconciler uses it to find the right block when section-replacing. */
export const SECTION_ATTR_KEY = "custom-section";

/** Discrete section kinds; values are the attr value on the heading block. */
export const SECTION_KIND = {
	overview: "overview",
	summary: "summary",
	dialog: "dialog",
	tools: "tools",
	warnings: "warnings",
} as const;
export type SectionKind = (typeof SECTION_KIND)[keyof typeof SECTION_KIND];

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
	subAgents?: Array<SubAgentLink>;
}

export interface SubAgentLink {
	title: string;
	role?: string;
	nickname?: string;
	assetPath: string;
	toolCount?: number;
	failedToolCount?: number;
	createdAt?: string;
}

interface CleanTurn {
	role: "user" | "assistant";
	text: string;
	ts: string;
}

export type DialogItem =
	| { ts: string; kind: "msg"; role: "user" | "assistant"; text: string }
	| { ts: string; kind: "sub"; assetPath: string; label: string }
	| { ts: string; kind: "xtool"; other: string; cmd: string };

/** Cleaned, non-empty turns — the basis for both 结论 and the 对话 timeline. */
export function cleanTurns(session: NormalizedSession): CleanTurn[] {
	return session.messages
		.map((m) => ({ role: m.role, text: cleanMessageText(m.text), ts: m.timestamp ?? "" }))
		.filter((m) => m.text.length > 0);
}

/** Build the timeline of dialog items (msg + sub-agent links + cross-tool notes),
 *  stably sorted by timestamp so each item lands next to the turn that produced it. */
export function buildDialogItems(
	session: NormalizedSession,
	turns: CleanTurn[],
	subs: SubAgentLink[],
): DialogItem[] {
	const items: DialogItem[] = turns.map((m) => ({ ts: m.ts ?? "", kind: "msg", role: m.role, text: m.text }));
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
	items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return items;
}

// ── Section push helpers (build into a shared `lines` buffer) ────────────────

function pushOverviewSection(
	lines: string[],
	session: NormalizedSession,
	options: RenderOptions,
	subs: SubAgentLink[],
): void {
	const failed = session.toolActivities.filter((t) => t.status === "failure");
	lines.push("## 📋 概览", "");
	lines.push("| 字段 | 值 |", "|---|---|");
	lines.push(`| 来源 | ${session.source} |`);
	lines.push(`| 项目 | ${projectSlug(session.cwd)} |`);
	if (session.isSubAgent)
		lines.push(`| 角色 | ${session.agentRole ?? "sub-agent"}${session.agentNickname ? ` (${session.agentNickname})` : ""} |`);
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
}

function pushSummarySection(lines: string[], session: NormalizedSession, turns: CleanTurn[]): void {
	const failed = session.toolActivities.filter((t) => t.status === "failure");
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
}

/** Push dialog items into `lines`. Returns the trailing role marker so an
 *  incremental tail-append can decide whether to re-emit the role banner. */
function pushDialogItems(
	lines: string[],
	items: DialogItem[],
	initialPrevRole: "user" | "assistant" | null = null,
): { lastRole: "user" | "assistant" | null } {
	let prevRole: "user" | "assistant" | null = initialPrevRole;
	for (const it of items) {
		if (it.kind === "sub") {
			const text = it.label.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "").trim();
			lines.push(`> 🧩 **子代理** [${text}](${it.assetPath})`, "");
			prevRole = null;
			continue;
		}
		if (it.kind === "xtool") {
			lines.push(`> ↗ **调用 ${it.other}**：\`${it.cmd}\``, "");
			prevRole = null;
			continue;
		}
		if (it.role === "user") {
			if (prevRole !== "user") lines.push("> 🧑", ">");
			lines.push(...it.text.split("\n").map((line) => `> ${line}`), "");
		} else {
			if (prevRole !== "assistant") lines.push("🤖", "");
			lines.push(it.text, "");
		}
		prevRole = it.role;
	}
	return { lastRole: prevRole };
}

function pushDialogSection(lines: string[], items: DialogItem[]): void {
	lines.push("## 💬 对话", "");
	if (items.length === 0) {
		lines.push("（无对话内容）", "");
		return;
	}
	pushDialogItems(lines, items, null);
}

function pushToolsSection(lines: string[], session: NormalizedSession): void {
	if (session.toolActivities.length === 0) return;
	const highSignal = session.toolActivities.filter(isHighSignalTool);
	const failed = session.toolActivities.filter((t) => t.status === "failure");
	const lowSignalCount = session.toolActivities.length - highSignal.length;
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

function pushWarningsSection(lines: string[], session: NormalizedSession): void {
	if (session.parseWarnings.length === 0) return;
	lines.push("## ⚠️ 解析警告", "");
	for (const warning of session.parseWarnings) lines.push(`- ${warning}`);
	lines.push("");
}

// ── Composer (legacy whole-doc renderer; backward-compatible) ────────────────

export function renderFullDoc(session: NormalizedSession, options: RenderOptions = {}): string {
	const lines: string[] = [];
	const turns = cleanTurns(session);
	const subs = options.subAgents ?? [];
	const items = buildDialogItems(session, turns, subs);
	pushOverviewSection(lines, session, options, subs);
	pushSummarySection(lines, session, turns);
	pushDialogSection(lines, items);
	pushToolsSection(lines, session);
	pushWarningsSection(lines, session);
	return lines.join("\n");
}

/** Backward-compat alias. New code should call `renderFullDoc` or the section
 *  variants (`renderOverviewBlock`, `renderDialogTail`, …) below. */
export const renderSession = renderFullDoc;

// ── Section / tail renderers (for the incremental reconciler) ────────────────

/** Render only the overview section as standalone markdown — used by the
 *  incremental reconciler to section-replace it when counts/status change. */
export function renderOverviewBlock(
	session: NormalizedSession,
	options: RenderOptions,
	subs: SubAgentLink[],
): string {
	const lines: string[] = [];
	pushOverviewSection(lines, session, options, subs);
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/** Render only the 🎯 结论 callout. Returns "" if the session has no content
 *  to summarize (the legacy renderer skips the block in that case). */
export function renderSummaryBlock(session: NormalizedSession, turns: CleanTurn[]): string {
	const lines: string[] = [];
	pushSummarySection(lines, session, turns);
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/** Render only the 🔧 工具调用 section. Returns "" when there are no tools. */
export function renderToolsBlock(session: NormalizedSession): string {
	const lines: string[] = [];
	pushToolsSection(lines, session);
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/** Render only the ⚠️ 解析警告 section. Returns "" when there are no warnings. */
export function renderWarningsBlock(session: NormalizedSession): string {
	const lines: string[] = [];
	pushWarningsSection(lines, session);
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/** Render only the dialog HEADING + content (used for the very first emission
 *  of the section). For subsequent appends use `renderDialogTail`. */
export function renderDialogBlock(items: DialogItem[]): string {
	const lines: string[] = [];
	pushDialogSection(lines, items);
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/** Render NEW dialog items (no heading, no leading blank), with optional role
 *  context so a continuation doesn't re-emit a `> 🧑` banner mid-stream. */
export function renderDialogTail(
	items: DialogItem[],
	prevRole: "user" | "assistant" | null = null,
): string {
	if (items.length === 0) return "";
	const lines: string[] = [];
	pushDialogItems(lines, items, prevRole);
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

// ── Incremental-build helpers (used by the reconciler's append path) ─────────

/** Stable label base for a sub-agent entry — `<role> · <nickname>` or `<role>`. */
function subLabelBase(s: Pick<SubAgentLink, "role" | "nickname">): string {
	return s.nickname ? `${s.role ?? "agent"} · ${s.nickname}` : (s.role ?? "agent");
}

/** Pre-populate a per-base count map from sub-agent links already emitted into a
 *  doc. Pass into `buildIncrementalDialogItems` so per-base numbering continues
 *  across appends (e.g. the second `worker · Ada` after the first is `(2)`). */
export function seedSubLabelCounts(alreadyEmittedSubs: SubAgentLink[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const s of alreadyEmittedSubs) {
		const base = subLabelBase(s);
		counts.set(base, (counts.get(base) ?? 0) + 1);
	}
	return counts;
}

/** Build dialog items from incremental slices — messages/tools/subs that are
 *  *new since the last append*. Mirrors `buildDialogItems` but takes pre-sliced
 *  inputs so the caller can render only the tail. `seenSubLabels` carries label
 *  counts forward (mutated in place). */
export function buildIncrementalDialogItems(
	session: Pick<NormalizedSession, "source">,
	newMessages: ConversationMessage[],
	newTools: ToolActivity[],
	newSubs: SubAgentLink[],
	seenSubLabels: Map<string, number>,
): DialogItem[] {
	const items: DialogItem[] = [];
	for (const m of newMessages) {
		const text = cleanMessageText(m.text);
		if (!text) continue;
		items.push({ ts: m.timestamp ?? "", kind: "msg", role: m.role, text });
	}
	const otherTool = session.source === "codex" ? "claude" : "codex";
	for (const t of newTools) {
		if (t.kind !== "shell") continue;
		const cmd = crossToolCmd(t.summary, otherTool);
		if (cmd) items.push({ ts: t.timestamp ?? "", kind: "xtool", other: otherTool, cmd });
	}
	for (const s of newSubs) {
		const base = subLabelBase(s);
		const seen = (seenSubLabels.get(base) ?? 0) + 1;
		seenSubLabels.set(base, seen);
		const label = `${seen === 1 ? base : `${base} (${seen})`} — ${s.title}`;
		items.push({ ts: s.createdAt ?? "", kind: "sub", assetPath: s.assetPath, label });
	}
	items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return items;
}
