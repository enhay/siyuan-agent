/**
 * Pure helper functions and shared interfaces for chat-panel.
 * Extracted from chat-panel.ts for maintainability.
 */

import type { AgentState, ToolUIEventPayload } from "../types";
import type { ModelServiceConfig, McpServerConfig } from "../types";
import { defaultTranslator, type Translator } from "../i18n";
import {
	messageKind,
	messageContent,
	messageToolCalls,
	setMessageContent,
	setMessageToolCalls,
} from "../core/message-shape";

/* ── Interfaces ──────────────────────────────────────────────────────── */

export interface AssistantMessageShell {
	el: HTMLElement;
	contentEl: HTMLElement;
	stackEl: HTMLElement;
}

export interface ActivityBlockRefs {
	el: HTMLElement;
	category: "lookup" | "change";
	currentEl: HTMLElement;
	archiveEl: HTMLDetailsElement;
	archiveListEl: HTMLElement;
}

export type SettingsSection = "general" | "model-services" | "default-models" | "mcp" | "tracing";

export interface ComposerKeyEvent {
	key: string;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
}

export interface SettingsDraft {
	customInstructions: string;
	guideDoc: { id: string; title: string } | null;
	defaultNotebook: { id: string; name: string } | null;
	langSmithEnabled: boolean;
	langSmithApiKey: string;
	langSmithEndpoint: string;
	langSmithProject: string;
	modelServices: ModelServiceConfig[];
	defaultModelId: string;
	subAgentModelId: string;
	mcpServers: McpServerConfig[];
	notebookOptions: Array<{ id: string; name: string }>;
}

/* ── Pure functions ──────────────────────────────────────────────────── */

export function shouldSendComposerOnKeydown(e: ComposerKeyEvent): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	if (e.isComposing || e.keyCode === 229) return false;
	return true;
}

export function sessionTitle(state: AgentState): string {
	const msgs = state?.messages || [];
	const first = msgs.find((m: any) => {
		const t = messageKind(m);
		return t === "human" || t === "user";
	});
	if (!first) return "New Chat";
	const rawContent = first.kwargs?.content ?? first.content;
	const text = (typeof rawContent === "string" ? rawContent : "").replace(/^>.*\n\n/s, "").trim();
	return text.length > 30 ? text.slice(0, 30) + "..." : text;
}

export function cloneMessage(raw: Record<string, any>): Record<string, any> {
	return {
		...raw,
		kwargs: raw.kwargs ? { ...raw.kwargs } : raw.kwargs,
	};
}

export function normalizeMessagesForDisplay(messages: any[]): any[] {
	const normalized: any[] = [];
	for (const raw of messages || []) {
		const type = messageKind(raw);
		if (type !== "ai") {
			normalized.push(raw);
			continue;
		}

		const prev = normalized[normalized.length - 1];
		if (prev && messageKind(prev) === "ai") {
			const merged = cloneMessage(prev);
			setMessageContent(merged, messageContent(prev) + messageContent(raw));
			setMessageToolCalls(merged, [...messageToolCalls(prev), ...messageToolCalls(raw)]);
			normalized[normalized.length - 1] = merged;
			continue;
		}

		normalized.push(cloneMessage(raw));
	}
	return normalized;
}

export function escapeHtml(text: string): string {
	const map: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	};
	return text.replace(/[&<>"']/g, (m) => map[m] || m);
}

/* ── Tool display helpers ────────────────────────────────────────────── */

export function getToolCategory(toolName?: string, payload?: ToolUIEventPayload): "lookup" | "change" {
	if (payload && "category" in payload) {
		return payload.category === "change" ? "change" : "lookup";
	}
	const changeTools = ["edit_blocks", "append_block", "create_document", "move_document", "rename_document", "delete_document", "toggle_todo", "create_scheduled_task", "update_scheduled_task", "delete_scheduled_task"];
	return changeTools.includes(toolName || "") ? "change" : "lookup";
}

export function getToolAction(toolName?: string, payload?: ToolUIEventPayload): string {
	if (payload && "action" in payload) return (payload as any).action;
	const map: Record<string, string> = {
		list_notebooks: "list",
		list_documents: "list",
		recent_documents: "list",
		get_document: "read",
		get_document_blocks: "read",
		get_document_outline: "read",
		read_block: "read",
		search_fulltext: "search",
		search_documents: "search",
		search_todos: "search",
		get_todo_stats: "search",
		explore_notes: "search",
		append_block: "append",
		edit_blocks: "edit",
		create_document: "create",
		move_document: "move",
		rename_document: "rename",
		delete_document: "delete",
		toggle_todo: "edit",
		create_scheduled_task: "create",
		list_scheduled_tasks: "list",
		update_scheduled_task: "edit",
		delete_scheduled_task: "delete",
	};
	return map[toolName || ""] || "other";
}

export function getToolDisplayTitle(toolName: string, i18n: Translator = defaultTranslator): string {
	return i18n.t(`chat.toolTitle.${toolName}`, undefined, toolName);
}

export function getActionLabel(action: string, i18n: Translator = defaultTranslator): string {
	return i18n.t(`chat.action.${action}`, undefined, action === "other" ? "" : action);
}
