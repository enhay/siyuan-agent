/** Render a NormalizedSession into a readable SiYuan markdown document.
 *
 *  Ported from `ailogger` (`src/render/siyuan.ts`). Pure. The title passed in
 *  (heuristic or AI, see plan §11) becomes the H1; the document's file-tree title
 *  is set separately via renameDoc so identity stays path-independent. */

import type { NormalizedSession, ToolActivity } from "./types";
import { inferTitle, projectSlug } from "./identity";

function formatTool(tool: ToolActivity): string {
	const mark = tool.status === "failure" ? "x" : "v";
	return `- [${mark}] **${tool.kind}:** ${tool.summary}`;
}

function isHighSignalTool(tool: ToolActivity): boolean {
	const summary = tool.summary.toLowerCase();
	return (
		tool.status === "failure" ||
		tool.kind === "file_edit" ||
		/\b(npm test|npm run check|npm run build|go test|cargo test|pytest|vitest|tsc|git status|git diff|git commit)\b/.test(summary)
	);
}

export interface RenderOptions {
	/** Display title (H1). Defaults to the heuristic `inferTitle`. */
	title?: string;
	/** Sub-agent links to inject under a "## 子代理" section (Phase 5). */
	subAgents?: Array<{ title: string; role?: string; nickname?: string; docId: string }>;
}

export function renderSession(session: NormalizedSession, options: RenderOptions = {}): string {
	const lines: string[] = [];
	const title = options.title ?? inferTitle(session);
	const failed = session.toolActivities.filter((t) => t.status === "failure");
	const highSignal = session.toolActivities.filter(isHighSignalTool);
	const lowSignalCount = session.toolActivities.length - highSignal.length;

	lines.push(`# ${title}`, "");
	lines.push("## 概览", "");
	lines.push("| 字段 | 值 |", "|---|---|");
	lines.push(`| 来源 | ${session.source} |`);
	lines.push(`| 项目 | ${projectSlug(session.cwd)} |`);
	if (session.isSubAgent) lines.push(`| 角色 | ${session.agentRole ?? "sub-agent"}${session.agentNickname ? ` (${session.agentNickname})` : ""} |`);
	lines.push(`| 状态 | completed |`);
	lines.push(`| 创建时间 | ${session.createdAt} |`);
	lines.push(`| 更新时间 | ${session.updatedAt} |`);
	lines.push(`| 消息数 | ${session.messages.length} |`);
	lines.push(`| 工具调用 | ${session.toolActivities.length} |`);
	lines.push(`| 失败工具调用 | ${failed.length} |`);
	if (session.cwd) lines.push(`| cwd | \`${session.cwd}\` |`);
	if (session.model) lines.push(`| model | ${session.model} |`);
	lines.push("");

	if (options.subAgents && options.subAgents.length > 0) {
		lines.push("## 子代理", "");
		for (const sub of options.subAgents) {
			const label = sub.nickname ? `${sub.role ?? "agent"} · ${sub.nickname}` : sub.role ?? "agent";
			lines.push(`- ((${sub.docId} "${sub.title}")) — ${label}`);
		}
		lines.push("");
	}

	lines.push("## 结论", "");
	const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
	lines.push(lastAssistant ? lastAssistant.text : "暂无助手结论。", "");

	lines.push("## 关键对话", "");
	for (const message of session.messages.slice(0, 6)) {
		lines.push(`### ${message.role === "user" ? "User" : "Assistant"}`);
		lines.push(`> ${message.timestamp}`, "");
		lines.push(message.text, "");
	}

	if (session.toolActivities.length > 0) {
		lines.push("## 工具摘要", "");
		if (highSignal.length > 0) {
			lines.push("### 高信号工具调用", "");
			for (const tool of highSignal.slice(0, 80)) lines.push(formatTool(tool));
			if (highSignal.length > 80) lines.push(`- ... ${highSignal.length - 80} more high-signal tool calls`);
			lines.push("");
		}
		if (failed.length > 0) {
			lines.push("### 失败工具调用", "");
			for (const tool of failed.slice(0, 40)) lines.push(formatTool(tool));
			lines.push("");
		}
		if (lowSignalCount > 0) {
			lines.push("### 低信号工具调用", "");
			lines.push(`已折叠 ${lowSignalCount} 条低信号工具调用。`, "");
		}
	}

	lines.push("## 完整对话", "");
	for (const message of session.messages) {
		lines.push(`### ${message.role === "user" ? "User" : "Assistant"}`);
		lines.push(`> ${message.timestamp}`, "");
		lines.push(message.text, "");
	}

	if (session.parseWarnings.length > 0) {
		lines.push("## Parse Warnings", "");
		for (const warning of session.parseWarnings) lines.push(`- ${warning}`);
		lines.push("");
	}

	return lines.join("\n");
}
